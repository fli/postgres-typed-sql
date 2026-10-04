#include "postgres.h"

#include "catalog/pg_proc.h"
#include "catalog/pg_type_d.h"
#include "nodes/nodeFuncs.h"
#include "nodes/primnodes.h"
#include "utils/hsearch.h"
#include "utils/fmgroids.h"
#include "utils/lsyscache.h"

#include "array_shape.h"
#include "null_evaluation.h"

typedef enum ArrayCardinalityProof
{
  ARRAY_CARDINALITY_EMPTY,
  ARRAY_CARDINALITY_NONEMPTY,
  ARRAY_CARDINALITY_UNKNOWN
} ArrayCardinalityProof;
static ArrayCardinalityProof
array_cardinality_proof(const Node *node)
{
  PtsArrayShape shape = pts_array_shape_proof(node);

  if (shape.proof != PTS_ARRAY_SHAPE_VALID || shape.is_null)
  {
    return ARRAY_CARDINALITY_UNKNOWN;
  }
  return shape.nitems == 0
           ? ARRAY_CARDINALITY_EMPTY
           : ARRAY_CARDINALITY_NONEMPTY;
}
typedef struct NullProofSubject
{
  AttrNumber target_attnum;
  int param_id;
  PtsParameterNodeAnalysis *node_analysis;
} NullProofSubject;

typedef struct PtsParameterNodeKey
{
  const Node *node;
  int param_id;
} PtsParameterNodeKey;

typedef struct PtsParameterNodeAnalysisEntry
{
  PtsParameterNodeKey key;
  PtsNullEvaluation null_evaluation;
  bool proof_known;
  bool mentions_parameter;
  bool mention_known;
} PtsParameterNodeAnalysisEntry;

struct PtsParameterNodeAnalysis
{
  HTAB *entries;
};

typedef struct ParameterMentionContext
{
  int param_id;
  PtsParameterNodeAnalysis *analysis;
} ParameterMentionContext;

PtsNullEvaluation
pts_make_null_evaluation(PtsNullProof proof, bool evaluation_safe,
                     bool depends_on_subject)
{
  PtsNullEvaluation evaluation = {proof, evaluation_safe, depends_on_subject};

  return evaluation;
}

static PtsNullEvaluation
invert_null_evaluation(PtsNullEvaluation evaluation)
{
  if (evaluation.proof == PTS_NULL_PROOF_TRUE)
  {
    evaluation.proof = PTS_NULL_PROOF_FALSE;
  }
  else if (evaluation.proof == PTS_NULL_PROOF_FALSE)
  {
    evaluation.proof = PTS_NULL_PROOF_TRUE;
  }
  return evaluation;
}

/*
 * An executed callable is safe for a no-error proof only when PostgreSQL's
 * catalog says that it cannot expose argument-dependent errors and will not
 * perform volatile work.  Argument independence alone says nothing about
 * whether evaluating the callable can fail (integer division is the canonical
 * example).
 */
static bool
function_evaluation_safe(Oid function_oid)
{
  return OidIsValid(function_oid) && get_func_leakproof(function_oid) &&
         func_volatile(function_oid) != PROVOLATILE_VOLATILE;
}

static bool
operator_evaluation_safe(Oid operator_oid)
{
  return function_evaluation_safe(get_opcode(operator_oid));
}

static PtsNullEvaluation
check_null_evaluation_for_subject_uncached(const Node *expr,
                                           const NullProofSubject *subject);

static PtsNullEvaluation
check_null_evaluation_for_subject(const Node *expr,
                                  const NullProofSubject *subject)
{
  PtsParameterNodeKey key;
  PtsParameterNodeAnalysisEntry *entry;
  PtsNullEvaluation evaluation;
  bool found;

  if (expr == NULL || subject->node_analysis == NULL || subject->param_id <= 0)
  {
    return check_null_evaluation_for_subject_uncached(expr, subject);
  }

  memset(&key, 0, sizeof(key));
  key.node = expr;
  key.param_id = subject->param_id;
  entry = hash_search(subject->node_analysis->entries, &key, HASH_FIND, &found);
  if (found && entry->proof_known)
  {
    return entry->null_evaluation;
  }

  evaluation = check_null_evaluation_for_subject_uncached(expr, subject);
  entry = hash_search(subject->node_analysis->entries, &key, HASH_ENTER, &found);
  if (!found)
  {
    entry->mention_known = false;
  }
  entry->null_evaluation = evaluation;
  entry->proof_known = true;
  return evaluation;
}

/* Audited conversions used by PostgreSQL's JSON constructors. Do not admit
 * SQL containers, custom casts/output functions, or textual JSON parsing. */
static bool
json_scalar_conversion_safe(Oid type_oid)
{
  switch (type_oid)
  {
    case BOOLOID:
    case INT2OID:
    case INT4OID:
    case INT8OID:
    case FLOAT4OID:
    case FLOAT8OID:
    case NUMERICOID:
    case TEXTOID:
    case VARCHAROID:
    case BPCHAROID:
    case UUIDOID:
    case DATEOID:
    case TIMESTAMPOID:
    case TIMESTAMPTZOID:
    case JSONBOID:
      return true;
    default:
      return false;
  }
}

static bool
json_constructor_evaluation_safe(const FuncExpr *function,
                                  const NullProofSubject *subject)
{
  bool object;
  ListCell *cell;
  int index = 0;

  switch (function->funcid)
  {
    case F_JSON_BUILD_OBJECT_ANY:
    case F_JSONB_BUILD_OBJECT_ANY:
      object = true;
      break;
    case F_JSON_BUILD_ARRAY_ANY:
    case F_JSONB_BUILD_ARRAY_ANY:
      object = false;
      break;
    default:
      return false;
  }
  if (function->funcvariadic ||
      (object && list_length(function->args) % 2 != 0))
    return false;
  foreach(cell, function->args)
  {
    const Node *argument = (const Node *) lfirst(cell);
    PtsNullEvaluation evaluation = check_null_evaluation_for_subject(argument,
                                                                    subject);
    if (!evaluation.evaluation_safe)
      return false;
    if (object && index % 2 == 0)
    {
      /* Constant textual keys exclude NULL keys and arbitrary key I/O. */
      if (!IsA(argument, Const) || ((const Const *) argument)->constisnull ||
          (((const Const *) argument)->consttype != TEXTOID &&
           ((const Const *) argument)->consttype != UNKNOWNOID &&
           ((const Const *) argument)->consttype != VARCHAROID &&
           ((const Const *) argument)->consttype != BPCHAROID))
        return false;
    }
    else if (evaluation.proof != PTS_NULL_PROOF_NULL &&
             !(IsA(argument, Const) &&
               ((const Const *) argument)->consttype == UNKNOWNOID) &&
             !json_scalar_conversion_safe(exprType(argument)))
      return false;
    index++;
  }
  return true;
}

static PtsNullEvaluation
check_null_evaluation_for_subject_uncached(const Node *expr,
                                           const NullProofSubject *subject)
{
  if (expr == NULL)
  {
    return pts_make_null_evaluation(PTS_NULL_PROOF_UNKNOWN, false, true);
  }

  switch (nodeTag(expr))
  {
    case T_CoerceToDomainValue:
      return pts_make_null_evaluation(PTS_NULL_PROOF_NULL, true, true);
    case T_Param:
    {
      const Param *parameter = (const Param *) expr;

      return pts_make_null_evaluation(
        subject->param_id > 0 && parameter->paramkind == PARAM_EXTERN &&
            parameter->paramid == subject->param_id
          ? PTS_NULL_PROOF_NULL
          : PTS_NULL_PROOF_UNKNOWN,
        true,
        subject->param_id > 0 && parameter->paramkind == PARAM_EXTERN &&
          parameter->paramid == subject->param_id);
    }
    case T_Var:
    {
      const Var *variable = (const Var *) expr;

      if (subject->target_attnum > 0 && variable->varlevelsup == 0 && variable->varno == 1 &&
          variable->varattno == subject->target_attnum)
      {
        return pts_make_null_evaluation(PTS_NULL_PROOF_NULL, true, true);
      }
      return pts_make_null_evaluation(PTS_NULL_PROOF_UNKNOWN, true, false);
    }
    case T_Const:
    {
      const Const *constant = (const Const *) expr;

      if (constant->constisnull)
      {
        return pts_make_null_evaluation(PTS_NULL_PROOF_NULL, true, false);
      }
      if (constant->consttype == BOOLOID)
      {
        return pts_make_null_evaluation(
          DatumGetBool(constant->constvalue) ? PTS_NULL_PROOF_TRUE : PTS_NULL_PROOF_FALSE,
          true, false);
      }
      return pts_make_null_evaluation(PTS_NULL_PROOF_NONNULL, true, false);
    }
    case T_RelabelType:
      return check_null_evaluation_for_subject(
        (const Node *) ((const RelabelType *) expr)->arg, subject);
    case T_CollateExpr:
      return check_null_evaluation_for_subject(
        (const Node *) ((const CollateExpr *) expr)->arg, subject);
    case T_CoerceViaIO:
    {
      PtsNullEvaluation argument = check_null_evaluation_for_subject(
        (const Node *) ((const CoerceViaIO *) expr)->arg, subject);

      return pts_make_null_evaluation(argument.proof,
                                  argument.evaluation_safe &&
                                    argument.proof == PTS_NULL_PROOF_NULL,
                                  argument.depends_on_subject);
    }
    case T_ArrayCoerceExpr:
    {
      PtsNullEvaluation argument = check_null_evaluation_for_subject(
        (const Node *) ((const ArrayCoerceExpr *) expr)->arg, subject);

      return pts_make_null_evaluation(argument.proof,
                                  argument.evaluation_safe &&
                                    argument.proof == PTS_NULL_PROOF_NULL,
                                  argument.depends_on_subject);
    }
    case T_ConvertRowtypeExpr:
    {
      PtsNullEvaluation argument = check_null_evaluation_for_subject(
        (const Node *) ((const ConvertRowtypeExpr *) expr)->arg, subject);

      return pts_make_null_evaluation(argument.proof,
                                  argument.evaluation_safe &&
                                    argument.proof == PTS_NULL_PROOF_NULL,
                                  argument.depends_on_subject);
    }
    case T_NullTest:
    {
      const NullTest *test = (const NullTest *) expr;
      PtsNullEvaluation argument = check_null_evaluation_for_subject(
        (const Node *) test->arg, subject);

      if (test->argisrow || argument.proof == PTS_NULL_PROOF_UNKNOWN)
      {
        return pts_make_null_evaluation(PTS_NULL_PROOF_UNKNOWN,
                                    argument.evaluation_safe,
                                    argument.depends_on_subject);
      }
      if (argument.proof == PTS_NULL_PROOF_NULL)
      {
        return pts_make_null_evaluation(
          test->nulltesttype == IS_NULL ? PTS_NULL_PROOF_TRUE : PTS_NULL_PROOF_FALSE,
          argument.evaluation_safe, argument.depends_on_subject);
      }
      return pts_make_null_evaluation(
        test->nulltesttype == IS_NULL ? PTS_NULL_PROOF_FALSE : PTS_NULL_PROOF_TRUE,
        argument.evaluation_safe, argument.depends_on_subject);
    }
    case T_BooleanTest:
    {
      const BooleanTest *test = (const BooleanTest *) expr;
      PtsNullEvaluation argument = check_null_evaluation_for_subject(
        (const Node *) test->arg, subject);
      PtsNullProof proof;

      if (argument.proof == PTS_NULL_PROOF_UNKNOWN ||
          argument.proof == PTS_NULL_PROOF_NONNULL)
      {
        return pts_make_null_evaluation(PTS_NULL_PROOF_UNKNOWN,
                                    argument.evaluation_safe,
                                    argument.depends_on_subject);
      }
      switch (test->booltesttype)
      {
        case IS_TRUE:
          proof = argument.proof == PTS_NULL_PROOF_TRUE ? PTS_NULL_PROOF_TRUE : PTS_NULL_PROOF_FALSE;
          break;
        case IS_NOT_TRUE:
          proof = argument.proof == PTS_NULL_PROOF_TRUE ? PTS_NULL_PROOF_FALSE : PTS_NULL_PROOF_TRUE;
          break;
        case IS_FALSE:
          proof = argument.proof == PTS_NULL_PROOF_FALSE ? PTS_NULL_PROOF_TRUE : PTS_NULL_PROOF_FALSE;
          break;
        case IS_NOT_FALSE:
          proof = argument.proof == PTS_NULL_PROOF_FALSE ? PTS_NULL_PROOF_FALSE : PTS_NULL_PROOF_TRUE;
          break;
        case IS_UNKNOWN:
          proof = argument.proof == PTS_NULL_PROOF_NULL ? PTS_NULL_PROOF_TRUE : PTS_NULL_PROOF_FALSE;
          break;
        case IS_NOT_UNKNOWN:
          proof = argument.proof == PTS_NULL_PROOF_NULL ? PTS_NULL_PROOF_FALSE : PTS_NULL_PROOF_TRUE;
          break;
        default:
          proof = PTS_NULL_PROOF_UNKNOWN;
          break;
      }
      return pts_make_null_evaluation(proof, argument.evaluation_safe,
                                  argument.depends_on_subject);
    }
    case T_BoolExpr:
    {
      const BoolExpr *boolean = (const BoolExpr *) expr;
      ListCell *cell;
      bool saw_null = false;
      bool saw_unknown = false;
      bool saw_decisive = false;
      bool evaluation_safe = true;
      bool depends_on_subject = false;

      if (boolean->boolop == NOT_EXPR && list_length(boolean->args) == 1)
      {
        return invert_null_evaluation(check_null_evaluation_for_subject(
          (const Node *) linitial(boolean->args), subject));
      }

      foreach(cell, boolean->args)
      {
        PtsNullEvaluation argument = check_null_evaluation_for_subject(
          (const Node *) lfirst(cell), subject);

        evaluation_safe = evaluation_safe && argument.evaluation_safe;
        depends_on_subject = depends_on_subject ||
                             argument.depends_on_subject;
        if ((boolean->boolop == AND_EXPR && argument.proof == PTS_NULL_PROOF_FALSE) ||
            (boolean->boolop == OR_EXPR && argument.proof == PTS_NULL_PROOF_TRUE))
        {
          saw_decisive = true;
        }
        else if (argument.proof == PTS_NULL_PROOF_NULL)
        {
          saw_null = true;
        }
        else if (argument.proof == PTS_NULL_PROOF_UNKNOWN ||
                 argument.proof == PTS_NULL_PROOF_NONNULL)
        {
          saw_unknown = true;
        }
      }

      if (saw_decisive)
      {
        return pts_make_null_evaluation(
          boolean->boolop == AND_EXPR ? PTS_NULL_PROOF_FALSE : PTS_NULL_PROOF_TRUE,
          evaluation_safe, depends_on_subject);
      }
      if (saw_unknown)
      {
        return pts_make_null_evaluation(PTS_NULL_PROOF_UNKNOWN, evaluation_safe,
                                    depends_on_subject);
      }
      if (saw_null)
      {
        return pts_make_null_evaluation(PTS_NULL_PROOF_NULL, evaluation_safe,
                                    depends_on_subject);
      }
      return pts_make_null_evaluation(
        boolean->boolop == AND_EXPR ? PTS_NULL_PROOF_TRUE : PTS_NULL_PROOF_FALSE,
        evaluation_safe, depends_on_subject);
    }
    case T_CaseExpr:
    {
      const CaseExpr *case_expr = (const CaseExpr *) expr;
      ListCell *cell;
      bool has_result = false;
      bool evaluation_safe = true;
      bool depends_on_subject = false;
      bool include_default = true;
      PtsNullProof proof = PTS_NULL_PROOF_UNKNOWN;

      /* Simple CASE needs CaseTestExpr substitution; leave it unresolved. */
      if (case_expr->arg != NULL)
      {
        return pts_make_null_evaluation(PTS_NULL_PROOF_UNKNOWN, false, true);
      }
      foreach(cell, case_expr->args)
      {
        const CaseWhen *when = lfirst_node(CaseWhen, cell);
        PtsNullEvaluation condition = check_null_evaluation_for_subject(
          (const Node *) when->expr, subject);
        PtsNullEvaluation result;

        evaluation_safe = evaluation_safe && condition.evaluation_safe;
        depends_on_subject = depends_on_subject || condition.depends_on_subject;
        if (condition.proof == PTS_NULL_PROOF_FALSE ||
            condition.proof == PTS_NULL_PROOF_NULL)
        {
          continue;
        }
        result = check_null_evaluation_for_subject((const Node *) when->result,
                                                    subject);
        evaluation_safe = evaluation_safe && result.evaluation_safe;
        depends_on_subject = depends_on_subject || result.depends_on_subject;
        proof = !has_result ? result.proof : proof == result.proof
                                               ? proof : PTS_NULL_PROOF_UNKNOWN;
        has_result = true;
        if (condition.proof == PTS_NULL_PROOF_TRUE)
        {
          include_default = false;
          break;
        }
      }
      if (include_default)
      {
        PtsNullEvaluation result = check_null_evaluation_for_subject(
          (const Node *) case_expr->defresult, subject);

        evaluation_safe = evaluation_safe && result.evaluation_safe;
        depends_on_subject = depends_on_subject || result.depends_on_subject;
        proof = !has_result ? result.proof : proof == result.proof
                                               ? proof : PTS_NULL_PROOF_UNKNOWN;
      }
      return pts_make_null_evaluation(proof, evaluation_safe, depends_on_subject);
    }
    case T_CoalesceExpr:
    {
      const CoalesceExpr *coalesce = (const CoalesceExpr *) expr;
      ListCell *cell;
      bool saw_unknown = false;
      bool evaluation_safe = true;
      bool depends_on_subject = false;

      foreach(cell, coalesce->args)
      {
        PtsNullEvaluation argument = check_null_evaluation_for_subject(
          (const Node *) lfirst(cell), subject);

        evaluation_safe = evaluation_safe && argument.evaluation_safe;
        depends_on_subject = depends_on_subject ||
                             argument.depends_on_subject;
        if (saw_unknown)
        {
          continue;
        }
        if (argument.proof == PTS_NULL_PROOF_NULL)
        {
          continue;
        }
        if (argument.proof == PTS_NULL_PROOF_UNKNOWN)
        {
          saw_unknown = true;
          continue;
        }
        return pts_make_null_evaluation(argument.proof, evaluation_safe,
                                    depends_on_subject);
      }
      return pts_make_null_evaluation(
        saw_unknown ? PTS_NULL_PROOF_UNKNOWN : PTS_NULL_PROOF_NULL,
        evaluation_safe, depends_on_subject);
    }
    case T_FuncExpr:
    case T_OpExpr:
    {
      bool is_function = IsA(expr, FuncExpr);
      const List *args = is_function
                           ? ((const FuncExpr *) expr)->args
                           : ((const OpExpr *) expr)->args;
      Oid callable_oid = is_function
                           ? ((const FuncExpr *) expr)->funcid
                           : ((const OpExpr *) expr)->opno;
      ListCell *cell;
      bool all_arguments_safe = true;
      bool saw_safely_null_argument = false;
      bool depends_on_subject = false;

      foreach(cell, args)
      {
        PtsNullEvaluation argument = check_null_evaluation_for_subject(
          (const Node *) lfirst(cell), subject);

        all_arguments_safe = all_arguments_safe && argument.evaluation_safe;
        depends_on_subject = depends_on_subject ||
                             argument.depends_on_subject;
        saw_safely_null_argument = saw_safely_null_argument ||
                                   (argument.evaluation_safe &&
                                    argument.proof == PTS_NULL_PROOF_NULL);
      }
      if ((is_function ? func_strict(callable_oid) : op_strict(callable_oid)) &&
          all_arguments_safe && saw_safely_null_argument)
      {
        return pts_make_null_evaluation(PTS_NULL_PROOF_NULL, true,
                                        depends_on_subject);
      }
      if (is_function && json_constructor_evaluation_safe(
                            (const FuncExpr *) expr, subject))
      {
        return pts_make_null_evaluation(PTS_NULL_PROOF_NONNULL, true,
                                        depends_on_subject);
      }
      return pts_make_null_evaluation(
        PTS_NULL_PROOF_UNKNOWN,
        all_arguments_safe &&
          (is_function ? function_evaluation_safe(callable_oid)
                       : operator_evaluation_safe(callable_oid)),
        depends_on_subject);
    }
    case T_ArrayExpr:
    {
      const ArrayExpr *array = (const ArrayExpr *) expr;
      ListCell *cell;
      bool evaluation_safe = true;
      bool depends_on_subject = false;

      foreach(cell, array->elements)
      {
        PtsNullEvaluation element = check_null_evaluation_for_subject(
          (const Node *) lfirst(cell), subject);

        evaluation_safe = evaluation_safe && element.evaluation_safe;
        depends_on_subject = depends_on_subject ||
                             element.depends_on_subject;
      }
      if (array->multidims)
      {
        PtsArrayShape shape = pts_array_shape_proof(expr);

        evaluation_safe = evaluation_safe &&
                          shape.proof == PTS_ARRAY_SHAPE_VALID;
      }
      return pts_make_null_evaluation(PTS_NULL_PROOF_NONNULL, evaluation_safe,
                                  depends_on_subject);
    }
    case T_ScalarArrayOpExpr:
    {
      const ScalarArrayOpExpr *operation = (const ScalarArrayOpExpr *) expr;
      const Node *scalar;
      const Node *array;
      ArrayCardinalityProof cardinality;
      PtsNullEvaluation scalar_evaluation;
      PtsNullEvaluation array_evaluation;
      bool evaluation_safe;
      bool depends_on_subject;

      if (!op_strict(operation->opno) || list_length(operation->args) != 2)
      {
        return pts_make_null_evaluation(PTS_NULL_PROOF_UNKNOWN, false, true);
      }
      scalar = (const Node *) linitial(operation->args);
      array = (const Node *) lsecond(operation->args);
      scalar_evaluation = check_null_evaluation_for_subject(scalar, subject);
      array_evaluation = check_null_evaluation_for_subject(array, subject);
      evaluation_safe = scalar_evaluation.evaluation_safe &&
                        array_evaluation.evaluation_safe;
      depends_on_subject = scalar_evaluation.depends_on_subject ||
                           array_evaluation.depends_on_subject;
      cardinality = array_cardinality_proof(array);
      if (cardinality == ARRAY_CARDINALITY_EMPTY)
      {
        return pts_make_null_evaluation(
          operation->useOr ? PTS_NULL_PROOF_FALSE : PTS_NULL_PROOF_TRUE,
          evaluation_safe, depends_on_subject);
      }
      if (cardinality == ARRAY_CARDINALITY_NONEMPTY &&
          scalar_evaluation.proof == PTS_NULL_PROOF_NULL)
      {
        return pts_make_null_evaluation(PTS_NULL_PROOF_NULL, evaluation_safe,
                                    depends_on_subject);
      }
      return pts_make_null_evaluation(PTS_NULL_PROOF_UNKNOWN,
                                  evaluation_safe &&
                                    operator_evaluation_safe(operation->opno),
                                  depends_on_subject);
    }
    default:
      return pts_make_null_evaluation(PTS_NULL_PROOF_UNKNOWN, false, true);
  }
}

PtsNullEvaluation
pts_check_null_evaluation(const Node *expr, AttrNumber target_attnum)
{
  const NullProofSubject subject = {target_attnum, 0, NULL};

  return check_null_evaluation_for_subject(expr, &subject);
}

PtsNullEvaluation
pts_check_parameter_null_evaluation(const Node *expr, int param_id,
                                PtsParameterNodeAnalysis *node_analysis)
{
  const NullProofSubject subject = {0, param_id, node_analysis};

  return check_null_evaluation_for_subject(expr, &subject);
}

PtsParameterNodeAnalysis *
pts_create_parameter_node_analysis(void)
{
  HASHCTL control;
  PtsParameterNodeAnalysis *analysis;

  analysis = palloc(sizeof(*analysis));
  memset(&control, 0, sizeof(control));
  control.keysize = sizeof(PtsParameterNodeKey);
  control.entrysize = sizeof(PtsParameterNodeAnalysisEntry);
  analysis->entries = hash_create("typed SQL parameter node analysis", 128,
                                  &control, HASH_ELEM | HASH_BLOBS);
  return analysis;
}

void
pts_destroy_parameter_node_analysis(PtsParameterNodeAnalysis *analysis)
{
  if (analysis == NULL)
  {
    return;
  }
  hash_destroy(analysis->entries);
  pfree(analysis);
}

static bool
node_mentions_external_parameter_walker(Node *node, void *context)
{
  const ParameterMentionContext *mention =
    (const ParameterMentionContext *) context;

  return pts_node_mentions_external_parameter(node, mention->param_id,
                                               mention->analysis);
}

bool
pts_node_mentions_external_parameter(const Node *node, int param_id,
                                     PtsParameterNodeAnalysis *analysis)
{
  PtsParameterNodeKey key;
  PtsParameterNodeAnalysisEntry *entry;
  bool found;
  bool mentions_parameter;

  if (node == NULL)
  {
    return false;
  }

  if (analysis == NULL)
  {
    if (IsA(node, Param))
    {
      const Param *param = (const Param *) node;

      return param->paramkind == PARAM_EXTERN && param->paramid == param_id;
    }
    else
    {
      ParameterMentionContext mention = {param_id, NULL};

      return IsA(node, Query)
        ? query_tree_walker((Query *) node,
                            node_mentions_external_parameter_walker,
                            &mention, QTW_EXAMINE_SORTGROUP)
        : expression_tree_walker((Node *) node,
                                 node_mentions_external_parameter_walker,
                                 &mention);
    }
  }

  memset(&key, 0, sizeof(key));
  key.node = node;
  key.param_id = param_id;
  entry = hash_search(analysis->entries, &key, HASH_FIND, &found);
  if (found && entry->mention_known)
  {
    return entry->mentions_parameter;
  }

  if (IsA(node, Param))
  {
    const Param *param = (const Param *) node;

    mentions_parameter = param->paramkind == PARAM_EXTERN &&
                         param->paramid == param_id;
  }
  else
  {
    ParameterMentionContext mention = {param_id, analysis};

    mentions_parameter = IsA(node, Query)
      ? query_tree_walker((Query *) node,
                          node_mentions_external_parameter_walker,
                          &mention, QTW_EXAMINE_SORTGROUP)
      : expression_tree_walker((Node *) node,
                               node_mentions_external_parameter_walker,
                               &mention);
  }

  entry = hash_search(analysis->entries, &key, HASH_ENTER, &found);
  if (!found)
  {
    entry->proof_known = false;
  }
  entry->mentions_parameter = mentions_parameter;
  entry->mention_known = true;
  return mentions_parameter;
}
