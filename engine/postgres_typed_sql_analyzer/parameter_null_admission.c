#include "postgres.h"

#include "nodes/nodeFuncs.h"
#include "nodes/parsenodes.h"
#include "nodes/primnodes.h"
#include "utils/hsearch.h"
#include "utils/lsyscache.h"

#include "null_admission.h"
#include "null_evaluation.h"
#include "parameter_null_admission.h"
#include "query_scope.h"

typedef struct PtsParameterUsageContext
{
  int param_id;
  PtsParameterUsageEvidence evidence;
  PtsNullAdmissionAnalysis *null_admission_analysis;
  PtsParameterNodeAnalysis *node_analysis;
} PtsParameterUsageContext;

static void
mark_parameter_usage(PtsParameterUsageContext *context,
                     PtsNullAdmission admission)
{
  if (!context->evidence.seen)
  {
    context->evidence.seen = true;
    context->evidence.admission = admission;
    return;
  }
  context->evidence.admission = pts_combine_null_admission(
    context->evidence.admission, admission);
}

static void
merge_parameter_usage_evidence(PtsParameterUsageEvidence *target,
                               const PtsParameterUsageEvidence *source)
{
  if (!source->seen)
  {
    return;
  }
  if (!target->seen)
  {
    *target = *source;
    return;
  }
  target->admission = pts_combine_null_admission(target->admission,
                                             source->admission);
}

static void
mark_required_nonnull_parameter_usage(PtsParameterUsageContext *context,
                                      const Node *expr)
{
    PtsNullEvaluation evaluation;

  if (!pts_node_mentions_external_parameter(expr, context->param_id, context->node_analysis))
  {
    return;
  }

  evaluation = pts_check_parameter_null_evaluation(expr, context->param_id,
                                               context->node_analysis);
  if (evaluation.proof == PTS_NULL_PROOF_NULL && evaluation.evaluation_safe)
  {
    mark_parameter_usage(context, PTS_NULL_REJECTS);
  }
  else if (evaluation.proof == PTS_NULL_PROOF_UNKNOWN ||
           !evaluation.evaluation_safe)
  {
    mark_parameter_usage(context, PTS_NULL_UNKNOWN);
  }
}

static bool
parameter_usage_null_admission_walker(Node *node, void *walker_context)
{
  PtsParameterUsageContext *context = (PtsParameterUsageContext *) walker_context;
    bool mentions_parameter;

  if (node == NULL)
  {
    return false;
  }
  if (context->evidence.seen &&
      context->evidence.admission == PTS_NULL_REJECTS)
  {
    return true;
  }
  if (IsA(node, Query))
  {
    return false;
  }

  mentions_parameter = pts_node_mentions_external_parameter(node, context->param_id,
                                               context->node_analysis);
  if (!mentions_parameter)
  {
    return false;
  }

  switch (nodeTag(node))
  {
    case T_Param:
      mark_parameter_usage(context, PTS_NULL_ADMITS);
      break;
    case T_CoerceToDomain:
    {
      const CoerceToDomain *coerce = (const CoerceToDomain *) node;
      PtsNullEvaluation argument = pts_check_parameter_null_evaluation(
        (const Node *) coerce->arg, context->param_id,
        context->node_analysis);

      mark_parameter_usage(
        context,
        argument.evaluation_safe && argument.proof == PTS_NULL_PROOF_NULL
          ? pts_type_null_admission(context->null_admission_analysis,
                                coerce->resulttype)
          : PTS_NULL_UNKNOWN);
      break;
    }
    case T_FuncExpr:
    {
      const FuncExpr *function = (const FuncExpr *) node;
      PtsNullEvaluation evaluation = pts_check_parameter_null_evaluation(
        node, context->param_id, context->node_analysis);

      if (!func_strict(function->funcid) ||
          evaluation.proof != PTS_NULL_PROOF_NULL ||
          !evaluation.evaluation_safe)
      {
        mark_parameter_usage(context, PTS_NULL_UNKNOWN);
      }
      break;
    }
    case T_OpExpr:
    {
      const OpExpr *operation = (const OpExpr *) node;
      PtsNullEvaluation evaluation = pts_check_parameter_null_evaluation(
        node, context->param_id, context->node_analysis);

      if (!op_strict(operation->opno) ||
          evaluation.proof != PTS_NULL_PROOF_NULL ||
          !evaluation.evaluation_safe)
      {
        mark_parameter_usage(context, PTS_NULL_UNKNOWN);
      }
      break;
    }
    case T_ScalarArrayOpExpr:
    {
      const ScalarArrayOpExpr *operation = (const ScalarArrayOpExpr *) node;
      PtsNullEvaluation evaluation = pts_check_parameter_null_evaluation(
        node, context->param_id, context->node_analysis);

      if (!op_strict(operation->opno) ||
          !evaluation.evaluation_safe ||
          (evaluation.proof != PTS_NULL_PROOF_NULL &&
           evaluation.proof != PTS_NULL_PROOF_TRUE &&
           evaluation.proof != PTS_NULL_PROOF_FALSE))
      {
        mark_parameter_usage(context, PTS_NULL_UNKNOWN);
      }
      break;
    }
    case T_CoerceViaIO:
    {
      const CoerceViaIO *coerce = (const CoerceViaIO *) node;
      PtsNullEvaluation argument = pts_check_parameter_null_evaluation(
        (const Node *) coerce->arg, context->param_id,
        context->node_analysis);

      if (argument.proof != PTS_NULL_PROOF_NULL ||
          !argument.evaluation_safe)
      {
        mark_parameter_usage(context, PTS_NULL_UNKNOWN);
      }
      break;
    }
    case T_ArrayCoerceExpr:
    {
      const ArrayCoerceExpr *coerce = (const ArrayCoerceExpr *) node;
      PtsNullEvaluation argument = pts_check_parameter_null_evaluation(
        (const Node *) coerce->arg, context->param_id,
        context->node_analysis);

      if (argument.proof != PTS_NULL_PROOF_NULL ||
          !argument.evaluation_safe)
      {
        mark_parameter_usage(context, PTS_NULL_UNKNOWN);
      }
      break;
    }
    case T_ConvertRowtypeExpr:
    {
      const ConvertRowtypeExpr *coerce = (const ConvertRowtypeExpr *) node;
      PtsNullEvaluation argument = pts_check_parameter_null_evaluation(
        (const Node *) coerce->arg, context->param_id,
        context->node_analysis);

      if (argument.proof != PTS_NULL_PROOF_NULL ||
          !argument.evaluation_safe)
      {
        mark_parameter_usage(context, PTS_NULL_UNKNOWN);
      }
      break;
    }
    case T_DistinctExpr:
    {
      const DistinctExpr *distinct = (const DistinctExpr *) node;
      ListCell *cell;
      bool null_short_circuit = false;
      bool arguments_safe = true;

      foreach(cell, distinct->args)
      {
        const Node *argument = (const Node *) lfirst(cell);
        PtsNullEvaluation evaluation = pts_check_parameter_null_evaluation(
          argument, context->param_id, context->node_analysis);

        arguments_safe = arguments_safe && evaluation.evaluation_safe;
        if (pts_node_mentions_external_parameter(argument, context->param_id,
                                                     context->node_analysis) &&
            evaluation.proof == PTS_NULL_PROOF_NULL &&
            evaluation.evaluation_safe)
        {
          null_short_circuit = true;
        }
      }
      if (!null_short_circuit || !arguments_safe)
      {
        mark_parameter_usage(context, PTS_NULL_UNKNOWN);
      }
      break;
    }
    case T_WindowClause:
    {
      const WindowClause *window = (const WindowClause *) node;

      mark_required_nonnull_parameter_usage(context, window->startOffset);
      mark_required_nonnull_parameter_usage(context, window->endOffset);
      break;
    }
    case T_TableSampleClause:
    {
      const TableSampleClause *sample = (const TableSampleClause *) node;
      ListCell *cell;

      foreach(cell, sample->args)
      {
        mark_required_nonnull_parameter_usage(
          context, (const Node *) lfirst(cell));
      }
      mark_required_nonnull_parameter_usage(
        context, (const Node *) sample->repeatable);
      break;
    }
    case T_BoolExpr:
    {
      PtsNullEvaluation evaluation = pts_check_parameter_null_evaluation(
        node, context->param_id, context->node_analysis);

      if (!evaluation.evaluation_safe)
      {
        mark_parameter_usage(context, PTS_NULL_UNKNOWN);
      }
      break;
    }
    case T_Query:
    case T_List:
    case T_TargetEntry:
    case T_NamedArgExpr:
    case T_SubLink:
    case T_FieldSelect:
    case T_RelabelType:
    case T_CollateExpr:
    case T_CaseExpr:
    case T_ArrayExpr:
    case T_RowExpr:
    case T_CoalesceExpr:
    case T_NullTest:
    case T_BooleanTest:
    case T_CommonTableExpr:
    case T_FromExpr:
    case T_OnConflictExpr:
    case T_MergeAction:
    case T_JoinExpr:
    case T_SetOperationStmt:
    case T_PlaceHolderVar:
    case T_InferenceElem:
    case T_ReturningExpr:
    case T_RangeTblFunction:
      break;
    default:
      /* Unmodeled parameter-bearing semantics cannot prove acceptance. */
      mark_parameter_usage(context, PTS_NULL_UNKNOWN);
      break;
  }

  if (context->evidence.seen &&
      context->evidence.admission == PTS_NULL_REJECTS)
  {
    return true;
  }
  return expression_tree_walker(node,
                                parameter_usage_null_admission_walker,
                                walker_context);
}

static bool
parameter_usage_null_admission_query(const PtsQueryScope *scope,
                                     void *walker_context)
{
  PtsParameterUsageContext *context =
    (PtsParameterUsageContext *) walker_context;

  /* PostgreSQL's query_tree_walker deliberately does not visit utilityStmt. */
  if (scope->query->utilityStmt != NULL)
  {
    mark_parameter_usage(context, PTS_NULL_UNKNOWN);
  }
  return query_tree_walker(
    (Query *) scope->query, parameter_usage_null_admission_walker,
    walker_context, QTW_EXAMINE_SORTGROUP | QTW_IGNORE_CTE_SUBQUERIES);
}

void
pts_update_parameter_usage_null_admissions(const Query *query,
                                           PtsParameterUsageEvidence *evidence,
                                           int param_count,
                                           PtsNullAdmissionAnalysis *null_admission_analysis)
{
  PtsParameterNodeAnalysis *node_analysis;
  int index;

  node_analysis = pts_create_parameter_node_analysis();

  for (index = 0; index < param_count; index++)
  {
    PtsParameterUsageContext context = {
      index + 1,
      {false, PTS_NULL_UNKNOWN},
      null_admission_analysis,
      node_analysis
    };

    pts_execution_reachable_query_walker(
      query, parameter_usage_null_admission_query, &context);
    merge_parameter_usage_evidence(&evidence[index], &context.evidence);
  }

  pts_destroy_parameter_node_analysis(node_analysis);
}
