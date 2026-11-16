#include "postgres.h"

#include "catalog/pg_type_d.h"
#include "nodes/nodeFuncs.h"
#include "nodes/parsenodes.h"
#include "nodes/primnodes.h"
#include "parser/parsetree.h"
#include "utils/fmgroids.h"
#include "utils/builtins.h"
#include "utils/hsearch.h"
#include "utils/lsyscache.h"
#include "utils/regproc.h"

#include "null_admission.h"
#include "null_evaluation.h"
#include "parameter_null_admission.h"
#include "query_scope.h"

typedef struct IndirectScopeKey
{
  const Query *query;
  const struct IndirectScopeEntry *parent;
} IndirectScopeKey;

typedef struct IndirectScopeEntry
{
  IndirectScopeKey key;
} IndirectScopeEntry;

typedef struct IndirectQueryKey
{
  const Query *query;
  const IndirectScopeEntry *owner;
  int depth;
  AttrNumber output_attnum;
} IndirectQueryKey;

typedef struct IndirectQueryEntry
{
  IndirectQueryKey key;
  bool mentions_parameter;
} IndirectQueryEntry;

typedef struct PtsParameterUsageContext
{
  int param_id;
  bool conditional;
  PtsParameterUsageEvidence evidence;
  PtsNullAdmissionAnalysis *null_admission_analysis;
  PtsParameterNodeAnalysis *node_analysis;
  const PtsQueryScope *scope;
  HTAB *indirect_scopes;
  HTAB *indirect_queries;
} PtsParameterUsageContext;

static bool mentions_indirect_parameter(Node *node,
                                       PtsParameterUsageContext *context);

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
mark_unknown_expression(PtsParameterUsageContext *context, const Node *node,
                        const char *description)
{
  mark_parameter_usage(context, PTS_NULL_UNKNOWN);
  context->evidence.reasons = pts_add_null_reason(context->evidence.reasons,
    "unresolved", description, exprLocation(node));
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
  target->reasons = list_concat(target->reasons, list_copy(source->reasons));
}

static void
mark_required_nonnull_parameter_usage(PtsParameterUsageContext *context,
                                      const Node *expr)
{
    PtsNullEvaluation evaluation;

  if (mentions_indirect_parameter((Node *) expr, context))
  {
    mark_parameter_usage(context, PTS_NULL_UNKNOWN);
    context->evidence.reasons = pts_add_null_reason(context->evidence.reasons,
      "conditional_required_nonnull", "an expression may require a non-NULL value", exprLocation(expr));
    return;
  }

  if (!pts_node_mentions_external_parameter(expr, context->param_id, context->node_analysis))
  {
    return;
  }

  evaluation = pts_check_parameter_null_evaluation(expr, context->param_id,
                                               context->node_analysis);
  if (evaluation.proof == PTS_NULL_PROOF_NULL && evaluation.evaluation_safe)
  {
    mark_parameter_usage(context, PTS_NULL_REJECTS);
    context->evidence.reasons = pts_add_null_reason(context->evidence.reasons,
      "required_nonnull", "this expression requires a non-NULL value", exprLocation(expr));
  }
  else if (evaluation.proof == PTS_NULL_PROOF_UNKNOWN ||
           !evaluation.evaluation_safe)
  {
    mark_parameter_usage(context, PTS_NULL_UNKNOWN);
    context->evidence.reasons = pts_add_null_reason(context->evidence.reasons,
      "conditional_required_nonnull", "this expression may require a non-NULL value", exprLocation(expr));
  }
}

typedef struct IndirectParameterContext
{
  PtsParameterUsageContext *usage;
  const PtsQueryScope *scope;
  int depth;
} IndirectParameterContext;

static const IndirectScopeEntry *
intern_indirect_scope(HTAB *scopes, const PtsQueryScope *scope)
{
  IndirectScopeKey key;

  if (scope == NULL)
    return NULL;
  MemSet(&key, 0, sizeof(key));
  key.query = scope->query;
  key.parent = intern_indirect_scope(scopes, scope->parent);
  return hash_search(scopes, &key, HASH_ENTER, NULL);
}

static bool
projection_source_cardinality_independent(const PtsQueryScope *scope, int depth)
{
  const Query *query = scope->query;
  const RangeTblEntry *rte;
  const Query *source;
  const PtsQueryScope *owner = scope;
  PtsQueryScope child;
  RangeTblRef *ref;

  if (depth > 32 || query->commandType != CMD_SELECT || query->jointree == NULL ||
      query->jointree->quals != NULL || query->limitCount != NULL ||
      query->limitOffset != NULL || query->hasAggs || query->hasWindowFuncs ||
      query->hasTargetSRFs || query->hasModifyingCTE || query->hasRowSecurity ||
      query->groupClause != NIL || query->groupingSets != NIL ||
      query->havingQual != NULL || query->distinctClause != NIL ||
      query->setOperations != NULL)
    return false;
  if (query->jointree->fromlist == NIL)
    return true;
  if (list_length(query->jointree->fromlist) != 1 ||
      !IsA(linitial(query->jointree->fromlist), RangeTblRef))
    return false;
  ref = linitial_node(RangeTblRef, query->jointree->fromlist);
  if (ref->rtindex <= 0 || ref->rtindex > list_length(query->rtable))
    return false;
  rte = rt_fetch(ref->rtindex, query->rtable);
  if (rte->rtekind == RTE_RELATION)
    return true;
  if (rte->rtekind == RTE_SUBQUERY)
    source = rte->subquery;
  else if (rte->rtekind == RTE_CTE && !rte->self_reference)
  {
    const CommonTableExpr *cte;
    owner = pts_query_scope_at_level(scope, rte->ctelevelsup);
    cte = owner == NULL ? NULL : pts_cte_by_name(owner->query, rte->ctename);
    if (cte == NULL || !IsA(cte->ctequery, Query)) return false;
    source = (const Query *) cte->ctequery;
  }
  else
    return false;
  child.query = source;
  child.parent = owner;
  return projection_source_cardinality_independent(&child, depth + 1);
}

static bool
indirect_parameter_walker(Node *node, void *opaque)
{
  IndirectParameterContext *context = opaque;

  if (node == NULL)
    return false;
  if (context->depth > 32)
    return true;
  if (IsA(node, Param))
  {
    const Param *param = (const Param *) node;
    return context->depth > 0 && param->paramkind == PARAM_EXTERN &&
           param->paramid == context->usage->param_id;
  }
  if (IsA(node, Query))
  {
    const Query *query = (const Query *) node;
    PtsQueryScope child = {query, context->scope};
    IndirectParameterContext nested = {context->usage, &child,
                                      context->depth + 1};
    ListCell *cell;
    if (query_tree_walker((Query *) query, indirect_parameter_walker,
                          &nested, QTW_IGNORE_CTE_SUBQUERIES))
      return true;
    foreach(cell, query->rtable)
    {
      const RangeTblEntry *rte = lfirst_node(RangeTblEntry, cell);
      const PtsQueryScope *owner;
      const CommonTableExpr *cte;
      IndirectParameterContext producer;
      if (rte->rtekind != RTE_CTE) continue;
      if (rte->self_reference) return true;
      owner = pts_query_scope_at_level(&child, rte->ctelevelsup);
      cte = owner == NULL ? NULL : pts_cte_by_name(owner->query, rte->ctename);
      if (cte == NULL || !IsA(cte->ctequery, Query)) return true;
      producer.usage = context->usage;
      producer.scope = owner;
      producer.depth = nested.depth;
      if (indirect_parameter_walker((Node *) cte->ctequery, &producer)) return true;
    }
    return false;
  }
  if (IsA(node, Var))
  {
    const Var *var = (const Var *) node;
    const PtsQueryScope *scope = pts_query_scope_at_level(context->scope,
                                                          var->varlevelsup);
    const RangeTblEntry *rte;
    const Query *source = NULL;
    const PtsQueryScope *owner = scope;
    PtsQueryScope child;
    IndirectParameterContext nested;
    IndirectQueryKey key;
    IndirectQueryEntry *entry;
    bool result;

    if (scope == NULL || var->varno == 0 ||
        var->varno > list_length(scope->query->rtable))
      return true;
    rte = rt_fetch(var->varno, scope->query->rtable);
    if (var->varattno < 0)
      return rte->rtekind != RTE_RELATION;
    if (var->varattno == 0)
    {
      int attno;
      for (attno = 1; attno <= list_length(rte->eref->colnames); attno++)
      {
        Var field = *var;
        field.varattno = attno;
        if (indirect_parameter_walker((Node *) &field, context))
          return true;
      }
      return false;
    }
    if (rte->rtekind == RTE_CTE && rte->self_reference)
      return true;
    if (rte->rtekind == RTE_JOIN || rte->rtekind == RTE_GROUP)
    {
      const List *expressions = rte->rtekind == RTE_JOIN
                                  ? rte->joinaliasvars : rte->groupexprs;
      if (var->varattno <= list_length(expressions))
      {
        nested.usage = context->usage;
        nested.scope = scope;
        nested.depth = context->depth + 1;
        return indirect_parameter_walker(
          (Node *) list_nth(expressions, var->varattno - 1), &nested);
      }
      return true;
    }
    if (rte->rtekind == RTE_VALUES)
    {
      ListCell *cell;
      nested.usage = context->usage;
      nested.scope = scope;
      nested.depth = context->depth + 1;
      foreach(cell, rte->values_lists)
      {
        const List *row = (const List *) lfirst(cell);
        if (var->varattno > list_length(row) ||
            indirect_parameter_walker(
              (Node *) list_nth(row, var->varattno - 1), &nested))
          return true;
      }
      return false;
    }
    if (rte->rtekind == RTE_FUNCTION)
    {
      ListCell *cell;
      nested.usage = context->usage;
      nested.scope = scope;
      nested.depth = context->depth + 1;
      foreach(cell, rte->functions)
      {
        const RangeTblFunction *function = lfirst_node(RangeTblFunction, cell);
        if (function->funcexpr == NULL ||
            indirect_parameter_walker(function->funcexpr, &nested))
          return true;
      }
      return rte->functions == NIL;
    }
    if (rte->rtekind == RTE_SUBQUERY)
      source = rte->subquery;
    else if (rte->rtekind == RTE_CTE && !rte->self_reference)
    {
      const CommonTableExpr *cte;
      owner = pts_query_scope_at_level(scope, rte->ctelevelsup);
      cte = owner == NULL ? NULL : pts_cte_by_name(owner->query, rte->ctename);
      if (cte != NULL && IsA(cte->ctequery, Query))
        source = (const Query *) cte->ctequery;
    }
    if (source == NULL)
      return rte->rtekind != RTE_RELATION;
    child.query = source;
    child.parent = owner;
    nested.usage = context->usage;
    nested.scope = &child;
    nested.depth = context->depth + 1;
    MemSet(&key, 0, sizeof(key));
    key.query = source;
    key.owner = intern_indirect_scope(context->usage->indirect_scopes, owner);
    key.depth = nested.depth;
    key.output_attnum = var->varattno;
    entry = hash_search(context->usage->indirect_queries, &key, HASH_FIND, NULL);
    if (entry != NULL)
      return entry->mentions_parameter;

    if (projection_source_cardinality_independent(&child, 0))
    {
      const TargetEntry *target = pts_target_entry_by_resno(
        source->targetList, var->varattno);
      result = target == NULL || indirect_parameter_walker(
        (Node *) target->expr, &nested);
    }
    else
    {
      IndirectParameterContext producer = {context->usage, owner, nested.depth};
      result = indirect_parameter_walker((Node *) source, &producer);
    }
    entry = hash_search(context->usage->indirect_queries, &key, HASH_ENTER, NULL);
    entry->mentions_parameter = result;
    return result;
  }
  return expression_tree_walker(node, indirect_parameter_walker, opaque);
}

static bool
mentions_indirect_parameter(Node *node, PtsParameterUsageContext *context)
{
  IndirectParameterContext indirect = {context, context->scope, 0};
  return node != NULL && indirect_parameter_walker(node, &indirect);
}

static bool
qual_cannot_be_true_with_null(const Node *qual,
                              PtsParameterUsageContext *context)
{
  PtsNullEvaluation evaluation;
  ListCell *cell;

  if (qual == NULL)
    return false;
  evaluation = pts_check_parameter_null_evaluation(qual, context->param_id,
                                                    context->node_analysis);
  if (!evaluation.evaluation_safe)
    return false;
  if (evaluation.proof == PTS_NULL_PROOF_FALSE ||
      evaluation.proof == PTS_NULL_PROOF_NULL)
    return true;
  if (!IsA(qual, BoolExpr) || ((const BoolExpr *) qual)->boolop != AND_EXPR)
    return false;
  foreach(cell, ((const BoolExpr *) qual)->args)
  {
    if (qual_cannot_be_true_with_null(lfirst(cell), context))
      return true;
  }
  return false;
}

static bool
scalar_bound_safe_with_null(const Node *bound,
                            PtsParameterUsageContext *context)
{
  PtsNullEvaluation evaluation;

  if (bound == NULL)
    return true;
  evaluation = pts_check_parameter_null_evaluation(bound, context->param_id,
                                                    context->node_analysis);
  if (!evaluation.evaluation_safe)
    return false;
  if (evaluation.proof == PTS_NULL_PROOF_NULL)
    return true;
  if (IsA(bound, Const))
  {
    const Const *constant = (const Const *) bound;

    if (constant->constisnull)
      return true;
    switch (constant->consttype)
    {
      case INT2OID:
        return DatumGetInt16(constant->constvalue) >= 0;
      case INT4OID:
        return DatumGetInt32(constant->constvalue) >= 0;
      case INT8OID:
        return DatumGetInt64(constant->constvalue) >= 0;
      default:
        return false;
    }
  }
  if (IsA(bound, FuncExpr))
  {
    const FuncExpr *function = (const FuncExpr *) bound;

    if ((function->funcid == F_INT8_INT4 || function->funcid == F_INT8_INT2) &&
        list_length(function->args) == 1)
      return scalar_bound_safe_with_null(linitial(function->args), context);
  }
  return false;
}

static bool
scalar_sublink_null_with_null_parameter(const SubLink *link,
                                        PtsParameterUsageContext *context)
{
  const Query *query;

  if (link->subLinkType != EXPR_SUBLINK || !IsA(link->subselect, Query))
    return false;
  query = (const Query *) link->subselect;
  if (query->commandType != CMD_SELECT || query->hasAggs ||
      query->groupClause != NIL || query->groupingSets != NIL ||
      query->havingQual != NULL || query->setOperations != NULL ||
      query->hasTargetSRFs || query->hasModifyingCTE || query->hasRowSecurity ||
      query->jointree == NULL ||
      !scalar_bound_safe_with_null(query->limitCount, context) ||
      !scalar_bound_safe_with_null(query->limitOffset, context))
    return false;
  return qual_cannot_be_true_with_null(query->jointree->quals, context);
}

static bool
indirect_callable_walker(Node *node, void *opaque)
{
  PtsParameterUsageContext *context = opaque;
  IndirectParameterContext indirect = {context, context->scope, 0};

  if (node == NULL || IsA(node, Query))
    return false;
  if (nodeTag(node) >= T_Aggref && nodeTag(node) <= T_ReturningExpr &&
      !IsA(node, NamedArgExpr) && !IsA(node, FieldSelect) &&
      !IsA(node, RelabelType) && !IsA(node, CollateExpr) &&
      !IsA(node, ArrayExpr) && !IsA(node, RowExpr) &&
      !IsA(node, NullTest) && !IsA(node, BooleanTest) &&
      !IsA(node, BoolExpr) &&
      !(IsA(node, SubLink) &&
        scalar_sublink_null_with_null_parameter((SubLink *) node, context)) &&
      indirect_parameter_walker(node, &indirect))
  {
    PtsNullEvaluation evaluation = pts_check_parameter_null_evaluation_scoped(
      node, context->param_id, context->scope);

    if (!evaluation.depends_on_subject || !evaluation.evaluation_safe)
    {
      mark_parameter_usage(context, PTS_NULL_UNKNOWN);
      if (IsA(node, FuncExpr) || IsA(node, OpExpr))
      {
        Oid callable = IsA(node, FuncExpr) ? ((FuncExpr *) node)->funcid :
          get_opcode(((OpExpr *) node)->opno);
        context->evidence.reasons = pts_add_null_reason(context->evidence.reasons,
          "opaque_callable", psprintf("evaluation of callable %s with NULL is not proved safe",
            format_procedure_qualified(callable)), exprLocation(node));
      }
      else
        context->evidence.reasons = pts_add_null_reason(context->evidence.reasons,
          "unsupported_projection", "a projected expression may depend on a NULL-sensitive row source", exprLocation(node));
    }
  }
  return expression_tree_walker(node, indirect_callable_walker, opaque);
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

      PtsNullAdmission admission = argument.evaluation_safe &&
        argument.proof == PTS_NULL_PROOF_NULL
        ? pts_type_null_admission(context->null_admission_analysis, coerce->resulttype)
        : PTS_NULL_UNKNOWN;
      bool nested_rejection = context->scope->parent != NULL && admission == PTS_NULL_REJECTS;
      bool conditional_rejection = context->conditional && admission == PTS_NULL_REJECTS;

      mark_parameter_usage(context, conditional_rejection || nested_rejection ? PTS_NULL_UNKNOWN : admission);
      if (conditional_rejection || nested_rejection || !argument.evaluation_safe || argument.proof != PTS_NULL_PROOF_NULL)
        context->evidence.reasons = pts_add_null_reason(context->evidence.reasons,
          "domain_unresolved", psprintf(nested_rejection
            ? "domain coercion to %s: enclosing query execution is not proved unconditional"
            : conditional_rejection
              ? "domain coercion to %s is reached only under an unresolved CASE condition, COALESCE argument, or Boolean operand"
              : "domain coercion to %s depends on an unresolved expression",
            format_type_be_qualified(coerce->resulttype)), exprLocation(node));
      if (!conditional_rejection && !nested_rejection && argument.evaluation_safe && argument.proof == PTS_NULL_PROOF_NULL)
        context->evidence.reasons = list_concat(context->evidence.reasons,
          list_copy(pts_type_null_reasons(context->null_admission_analysis, coerce->resulttype)));
      break;
    }
    case T_FuncExpr:
    case T_OpExpr:
    {
      PtsNullEvaluation evaluation = pts_check_parameter_null_evaluation(
        node, context->param_id, context->node_analysis);
      /* Admission requires safe evaluation, not NULL-valued output. A
       * leakproof callable can safely evaluate a non-NULL CASE/COALESCE arm. */
      if (!evaluation.evaluation_safe)
      {
        Oid callable = IsA(node, FuncExpr) ? ((FuncExpr *) node)->funcid :
          get_opcode(((OpExpr *) node)->opno);
        mark_parameter_usage(context, PTS_NULL_UNKNOWN);
        if (OidIsValid(callable))
          context->evidence.reasons = pts_add_null_reason(context->evidence.reasons,
            "opaque_callable", psprintf("evaluation of callable %s with NULL is not proved safe",
              format_procedure_qualified(callable)), exprLocation(node));
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
        mark_unknown_expression(context, node, "scalar-array operator evaluation is unresolved");
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
        mark_unknown_expression(context, node, "input/output cast evaluation is unresolved");
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
        mark_unknown_expression(context, node, "array coercion evaluation is unresolved");
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
        mark_unknown_expression(context, node, "row type conversion evaluation is unresolved");
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
        mark_unknown_expression(context, node, "distinctness operator evaluation is unresolved");
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

      const BoolExpr *boolean = (const BoolExpr *) node;
      bool outer_conditional = context->conditional;
      ListCell *cell;

      if (!evaluation.evaluation_safe)
      {
        mark_unknown_expression(context, node, "boolean expression evaluation is unresolved");
      }
      foreach(cell, boolean->args)
      {
        ListCell *other_cell;
        bool conditional = outer_conditional;

        if (boolean->boolop != NOT_EXPR)
          foreach(other_cell, boolean->args)
          {
            PtsNullEvaluation other;

            if (other_cell == cell)
              continue;
            other = pts_check_parameter_null_evaluation(
              (const Node *) lfirst(other_cell), context->param_id, context->node_analysis);
            if (!other.evaluation_safe ||
                (other.proof != PTS_NULL_PROOF_NULL &&
                 other.proof != (boolean->boolop == AND_EXPR ? PTS_NULL_PROOF_TRUE : PTS_NULL_PROOF_FALSE)))
              conditional = true;
          }
        context->conditional = conditional;
        parameter_usage_null_admission_walker((Node *) lfirst(cell), context);
      }
      context->conditional = outer_conditional;
      return false;
    }
    case T_CaseExpr:
    {
      const CaseExpr *case_expr = (const CaseExpr *) node;
      ListCell *cell;
      bool outer_conditional = context->conditional;
      bool prior_unknown = false;
      PtsNullEvaluation evaluation = pts_check_parameter_null_evaluation(
        node, context->param_id, context->node_analysis);

      if (!evaluation.evaluation_safe)
      {
        mark_unknown_expression(context, node, "CASE expression evaluation is unresolved");
      }
      else
      {
        mark_parameter_usage(context, PTS_NULL_ADMITS);
      }
      if (case_expr->arg != NULL)
      {
        parameter_usage_null_admission_walker((Node *) case_expr->arg, context);
        prior_unknown = true;
      }
      foreach(cell, case_expr->args)
      {
        const CaseWhen *when = lfirst_node(CaseWhen, cell);
        PtsNullEvaluation condition = pts_check_parameter_null_evaluation(
          (const Node *) when->expr, context->param_id, context->node_analysis);

        context->conditional = outer_conditional || prior_unknown;
        parameter_usage_null_admission_walker((Node *) when->expr, context);
        if (condition.proof != PTS_NULL_PROOF_FALSE &&
            condition.proof != PTS_NULL_PROOF_NULL)
        {
          context->conditional = outer_conditional || prior_unknown ||
            condition.proof != PTS_NULL_PROOF_TRUE;
          parameter_usage_null_admission_walker((Node *) when->result, context);
        }
        if (case_expr->arg == NULL && condition.proof == PTS_NULL_PROOF_TRUE)
        {
          context->conditional = outer_conditional;
          return false;
        }
        if (condition.proof != PTS_NULL_PROOF_TRUE &&
            condition.proof != PTS_NULL_PROOF_FALSE &&
            condition.proof != PTS_NULL_PROOF_NULL)
          prior_unknown = true;
      }
      context->conditional = outer_conditional || prior_unknown;
      parameter_usage_null_admission_walker((Node *) case_expr->defresult, context);
      context->conditional = outer_conditional;
      return false;
    }
    case T_CoalesceExpr:
    {
      const CoalesceExpr *coalesce = (const CoalesceExpr *) node;
      bool outer_conditional = context->conditional;
      bool prior_may_be_nonnull = false;
      ListCell *cell;

      foreach(cell, coalesce->args)
      {
        Node *argument = (Node *) lfirst(cell);
        PtsNullEvaluation evaluation = pts_check_parameter_null_evaluation(
          argument, context->param_id, context->node_analysis);

        context->conditional = outer_conditional || prior_may_be_nonnull;
        parameter_usage_null_admission_walker(argument, context);
        if (evaluation.proof != PTS_NULL_PROOF_NULL)
          prior_may_be_nonnull = true;
      }
      context->conditional = outer_conditional;
      return false;
    }
    case T_Query:
    case T_List:
    case T_TargetEntry:
    case T_NamedArgExpr:
    case T_SubLink:
    case T_FieldSelect:
    case T_RelabelType:
    case T_CollateExpr:
    case T_ArrayExpr:
    case T_RowExpr:
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
      mark_unknown_expression(context, node,
        psprintf("parameter-bearing expression node %d is not modeled", (int) nodeTag(node)));
      break;
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

  context->scope = scope;
  query_tree_walker((Query *) scope->query, indirect_callable_walker,
                    walker_context, QTW_EXAMINE_SORTGROUP | QTW_IGNORE_CTE_SUBQUERIES);

  /* PostgreSQL's query_tree_walker deliberately does not visit utilityStmt. */
  if (scope->query->utilityStmt != NULL)
  {
    mark_unknown_expression(context, scope->query->utilityStmt,
                            "utility statement parameter use is not modeled");
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
    HASHCTL scope_ctl = {0};
    HASHCTL query_ctl = {0};
    PtsParameterUsageContext context = {
      index + 1,
      false,
      {false, PTS_NULL_UNKNOWN, NIL},
      null_admission_analysis,
      node_analysis,
      NULL,
      NULL,
      NULL
    };

    scope_ctl.keysize = sizeof(IndirectScopeKey);
    scope_ctl.entrysize = sizeof(IndirectScopeEntry);
    context.indirect_scopes = hash_create("indirect parameter scopes", 32,
                                          &scope_ctl, HASH_ELEM | HASH_BLOBS);
    query_ctl.keysize = sizeof(IndirectQueryKey);
    query_ctl.entrysize = sizeof(IndirectQueryEntry);
    context.indirect_queries = hash_create("indirect parameter queries", 32,
                                           &query_ctl, HASH_ELEM | HASH_BLOBS);

    pts_execution_reachable_query_walker(
      query, parameter_usage_null_admission_query, &context);
    merge_parameter_usage_evidence(&evidence[index], &context.evidence);
    hash_destroy(context.indirect_queries);
    hash_destroy(context.indirect_scopes);
  }

  pts_destroy_parameter_node_analysis(node_analysis);
}
