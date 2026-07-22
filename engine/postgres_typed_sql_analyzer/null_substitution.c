#include "postgres.h"

#include "catalog/pg_proc.h"
#include "catalog/pg_type_d.h"
#include "nodes/nodeFuncs.h"
#include "nodes/primnodes.h"
#include "optimizer/clauses.h"
#include "utils/lsyscache.h"
#include "utils/memutils.h"

#include "null_substitution.h"

typedef enum PtsNullTruth
{
  PTS_NULL_TRUTH_FALSE,
  PTS_NULL_TRUTH_TRUE,
  PTS_NULL_TRUTH_NULL,
  PTS_NULL_TRUTH_UNKNOWN
} PtsNullTruth;

typedef enum PtsSubstitutedValue
{
  PTS_SUBSTITUTED_NULL,
  PTS_SUBSTITUTED_SAME_OLD_TARGET_VALUE,
  PTS_SUBSTITUTED_UNKNOWN
} PtsSubstitutedValue;

static PtsNullTruth null_substitution_truth(
  const Node *expr, const PtsNullSubstitutionContext *context);
static PtsSubstitutedValue null_substitution_value(
  const Node *expr, const PtsNullSubstitutionContext *context);
static bool null_substitution_evaluation_safe(
  const Node *expr, const PtsNullSubstitutionContext *context);

static bool
safe_strict_function(Oid function_oid)
{
  return OidIsValid(function_oid) && func_strict(function_oid) &&
         func_volatile(function_oid) != PROVOLATILE_VOLATILE;
}

static PtsSubstitutedValue
join_values(PtsSubstitutedValue left, PtsSubstitutedValue right)
{
  return left == right ? left : PTS_SUBSTITUTED_UNKNOWN;
}

/*
 * A strict call still evaluates every argument before it observes a NULL.
 * Keep the row-preservation proof only when those evaluations are themselves
 * harmless under the substitution.  Calls with no proven NULL are not safe:
 * even immutable operators such as integer division can raise an error.
 */
static bool
null_substitution_evaluation_safe(
  const Node *expr, const PtsNullSubstitutionContext *context)
{
  ListCell *cell;

  if (expr == NULL)
    return true;

  switch (nodeTag(expr))
  {
    case T_Param:
    case T_Var:
    case T_Const:
      return true;
    case T_RelabelType:
      return null_substitution_evaluation_safe(
        (const Node *) ((const RelabelType *) expr)->arg, context);
    case T_CollateExpr:
      return null_substitution_evaluation_safe(
        (const Node *) ((const CollateExpr *) expr)->arg, context);
    case T_NullTest:
      return !((const NullTest *) expr)->argisrow &&
             null_substitution_evaluation_safe(
               (const Node *) ((const NullTest *) expr)->arg, context);
    case T_BoolExpr:
      foreach(cell, ((const BoolExpr *) expr)->args)
        if (!null_substitution_evaluation_safe(
              (const Node *) lfirst(cell), context))
          return false;
      return true;
    case T_CoalesceExpr:
      foreach(cell, ((const CoalesceExpr *) expr)->args)
        if (!null_substitution_evaluation_safe(
              (const Node *) lfirst(cell), context))
          return false;
      return true;
    case T_CaseExpr:
    {
      const CaseExpr *case_expr = (const CaseExpr *) expr;

      if (case_expr->arg != NULL)
        return false;
      foreach(cell, case_expr->args)
      {
        const CaseWhen *when = lfirst_node(CaseWhen, cell);
        PtsNullTruth condition;

        if (!null_substitution_evaluation_safe(
              (const Node *) when->expr, context))
          return false;
        condition = null_substitution_truth((const Node *) when->expr,
                                                context);
        if (condition == PTS_NULL_TRUTH_FALSE ||
            condition == PTS_NULL_TRUTH_NULL)
          continue;
        if (!null_substitution_evaluation_safe(
              (const Node *) when->result, context))
          return false;
        if (condition == PTS_NULL_TRUTH_TRUE)
          return true;
      }
      return null_substitution_evaluation_safe(
        (const Node *) case_expr->defresult, context);
    }
    case T_FuncExpr:
    {
      const FuncExpr *function = (const FuncExpr *) expr;
      bool saw_null = false;

      if (function->funcretset || !safe_strict_function(function->funcid))
        return false;
      foreach(cell, function->args)
      {
        const Node *argument = (const Node *) lfirst(cell);

        if (!null_substitution_evaluation_safe(argument, context))
          return false;
        saw_null = saw_null ||
                   null_substitution_value(argument, context) ==
                     PTS_SUBSTITUTED_NULL;
      }
      return saw_null;
    }
    case T_OpExpr:
    {
      const OpExpr *operation = (const OpExpr *) expr;
      bool saw_null = false;

      if (operation->opretset || !safe_strict_function(operation->opfuncid))
        return false;
      foreach(cell, operation->args)
      {
        const Node *argument = (const Node *) lfirst(cell);

        if (!null_substitution_evaluation_safe(argument, context))
          return false;
        saw_null = saw_null ||
                   null_substitution_value(argument, context) ==
                     PTS_SUBSTITUTED_NULL;
      }
      return saw_null;
    }
    default:
      return false;
  }
}

static PtsNullTruth
null_substitution_truth(const Node *expr,
                            const PtsNullSubstitutionContext *context)
{
  if (expr == NULL)
    return PTS_NULL_TRUTH_TRUE;

  switch (nodeTag(expr))
  {
    case T_Const:
    {
      const Const *constant = (const Const *) expr;
      if (constant->constisnull)
        return PTS_NULL_TRUTH_NULL;
      if (constant->consttype == BOOLOID)
        return DatumGetBool(constant->constvalue)
                 ? PTS_NULL_TRUTH_TRUE : PTS_NULL_TRUTH_FALSE;
      return PTS_NULL_TRUTH_UNKNOWN;
    }
    case T_Param:
    {
      const Param *parameter = (const Param *) expr;
      return parameter->paramkind == PARAM_EXTERN &&
             parameter->paramid == context->param_id
               ? PTS_NULL_TRUTH_NULL : PTS_NULL_TRUTH_UNKNOWN;
    }
    case T_RelabelType:
      return null_substitution_truth(
        (const Node *) ((const RelabelType *) expr)->arg, context);
    case T_CollateExpr:
      return null_substitution_truth(
        (const Node *) ((const CollateExpr *) expr)->arg, context);
    case T_NullTest:
    {
      const NullTest *test = (const NullTest *) expr;
      PtsSubstitutedValue value;
      if (test->argisrow)
        return PTS_NULL_TRUTH_UNKNOWN;
      value = null_substitution_value((const Node *) test->arg, context);
      if (value == PTS_SUBSTITUTED_UNKNOWN)
        return PTS_NULL_TRUTH_UNKNOWN;
      if (value == PTS_SUBSTITUTED_SAME_OLD_TARGET_VALUE &&
          context->old_target_nullness == PTS_OLD_TARGET_NULLNESS_UNKNOWN)
        return PTS_NULL_TRUTH_UNKNOWN;
      return (value == PTS_SUBSTITUTED_NULL ||
              (value == PTS_SUBSTITUTED_SAME_OLD_TARGET_VALUE &&
               context->old_target_nullness == PTS_OLD_TARGET_NULLNESS_NULL)) ==
             (test->nulltesttype == IS_NULL)
               ? PTS_NULL_TRUTH_TRUE : PTS_NULL_TRUTH_FALSE;
    }
    case T_BoolExpr:
    {
      const BoolExpr *boolean = (const BoolExpr *) expr;
      ListCell *cell;
      bool saw_null = false;
      bool saw_unknown = false;

      if (boolean->boolop == NOT_EXPR && list_length(boolean->args) == 1)
      {
        PtsNullTruth value = null_substitution_truth(
          (const Node *) linitial(boolean->args), context);
        if (value == PTS_NULL_TRUTH_TRUE) return PTS_NULL_TRUTH_FALSE;
        if (value == PTS_NULL_TRUTH_FALSE) return PTS_NULL_TRUTH_TRUE;
        return value;
      }
      foreach(cell, boolean->args)
      {
        PtsNullTruth value = null_substitution_truth(
          (const Node *) lfirst(cell), context);
        if (boolean->boolop == AND_EXPR && value == PTS_NULL_TRUTH_FALSE)
          return PTS_NULL_TRUTH_FALSE;
        if (boolean->boolop == OR_EXPR && value == PTS_NULL_TRUTH_TRUE)
          return PTS_NULL_TRUTH_TRUE;
        saw_null = saw_null || value == PTS_NULL_TRUTH_NULL;
        saw_unknown = saw_unknown || value == PTS_NULL_TRUTH_UNKNOWN;
      }
      if (saw_unknown) return PTS_NULL_TRUTH_UNKNOWN;
      if (saw_null) return PTS_NULL_TRUTH_NULL;
      return boolean->boolop == AND_EXPR
               ? PTS_NULL_TRUTH_TRUE : PTS_NULL_TRUTH_FALSE;
    }
    default:
      return PTS_NULL_TRUTH_UNKNOWN;
  }
}

static PtsSubstitutedValue
coalesce_tail(const List *arguments, const ListCell *start,
              const PtsNullSubstitutionContext *context)
{
  const ListCell *cell;

  for (cell = start; cell != NULL; cell = lnext(arguments, cell))
  {
    PtsSubstitutedValue value = null_substitution_value(
      (const Node *) lfirst(cell), context);

    if (value == PTS_SUBSTITUTED_NULL)
      continue;
    if (value == PTS_SUBSTITUTED_UNKNOWN)
      return PTS_SUBSTITUTED_UNKNOWN;
    if (context->old_target_nullness == PTS_OLD_TARGET_NULLNESS_NONNULL)
      return PTS_SUBSTITUTED_SAME_OLD_TARGET_VALUE;
    else
    {
      PtsNullSubstitutionContext null_context = *context;
      PtsSubstitutedValue null_path;

      null_context.old_target_nullness = PTS_OLD_TARGET_NULLNESS_NULL;
      null_path = coalesce_tail(arguments, lnext(arguments, cell),
                                &null_context);
      return null_path == PTS_SUBSTITUTED_NULL
               ? PTS_SUBSTITUTED_SAME_OLD_TARGET_VALUE
               : PTS_SUBSTITUTED_UNKNOWN;
    }
  }
  return PTS_SUBSTITUTED_NULL;
}

static PtsSubstitutedValue
null_substitution_value(const Node *expr,
                            const PtsNullSubstitutionContext *context)
{
  if (expr == NULL)
    return PTS_SUBSTITUTED_UNKNOWN;

  switch (nodeTag(expr))
  {
    case T_Param:
    {
      const Param *parameter = (const Param *) expr;
      return parameter->paramkind == PARAM_EXTERN &&
             parameter->paramid == context->param_id
               ? PTS_SUBSTITUTED_NULL : PTS_SUBSTITUTED_UNKNOWN;
    }
    case T_Const:
      return ((const Const *) expr)->constisnull
               ? PTS_SUBSTITUTED_NULL : PTS_SUBSTITUTED_UNKNOWN;
    case T_Var:
    {
      const Var *variable = (const Var *) expr;
      return context->query != NULL && context->query->commandType == CMD_UPDATE &&
             variable->varlevelsup == 0 &&
             variable->varno == context->query->resultRelation &&
             variable->varattno == context->target_attnum &&
             variable->varnullingrels == NULL &&
             variable->varreturningtype == VAR_RETURNING_DEFAULT
               ? context->old_target_nullness == PTS_OLD_TARGET_NULLNESS_NULL
                   ? PTS_SUBSTITUTED_NULL
                   : PTS_SUBSTITUTED_SAME_OLD_TARGET_VALUE
               : PTS_SUBSTITUTED_UNKNOWN;
    }
    case T_RelabelType:
      return null_substitution_value(
        (const Node *) ((const RelabelType *) expr)->arg, context);
    case T_CollateExpr:
      return null_substitution_value(
        (const Node *) ((const CollateExpr *) expr)->arg, context);
    case T_FuncExpr:
    {
      const FuncExpr *function = (const FuncExpr *) expr;
      ListCell *cell;
      bool all_arguments_safe = true;
      bool saw_null = false;

      if (function->funcretset || !safe_strict_function(function->funcid))
        return PTS_SUBSTITUTED_UNKNOWN;
      foreach(cell, function->args)
      {
        const Node *argument = (const Node *) lfirst(cell);

        all_arguments_safe = all_arguments_safe &&
                             null_substitution_evaluation_safe(argument,
                                                                   context);
        saw_null = saw_null ||
                   null_substitution_value(argument, context) ==
                     PTS_SUBSTITUTED_NULL;
      }
      return all_arguments_safe && saw_null
               ? PTS_SUBSTITUTED_NULL : PTS_SUBSTITUTED_UNKNOWN;
    }
    case T_OpExpr:
    {
      const OpExpr *operation = (const OpExpr *) expr;
      ListCell *cell;
      bool all_arguments_safe = true;
      bool saw_null = false;

      if (operation->opretset || !safe_strict_function(operation->opfuncid))
        return PTS_SUBSTITUTED_UNKNOWN;
      foreach(cell, operation->args)
      {
        const Node *argument = (const Node *) lfirst(cell);

        all_arguments_safe = all_arguments_safe &&
                             null_substitution_evaluation_safe(argument,
                                                                   context);
        saw_null = saw_null ||
                   null_substitution_value(argument, context) ==
                     PTS_SUBSTITUTED_NULL;
      }
      return all_arguments_safe && saw_null
               ? PTS_SUBSTITUTED_NULL : PTS_SUBSTITUTED_UNKNOWN;
    }
    case T_CoalesceExpr:
      return coalesce_tail(((const CoalesceExpr *) expr)->args,
                           list_head(((const CoalesceExpr *) expr)->args),
                           context);
    case T_CaseExpr:
    {
      const CaseExpr *case_expr = (const CaseExpr *) expr;
      ListCell *cell;
      PtsSubstitutedValue result = PTS_SUBSTITUTED_UNKNOWN;
      bool have_result = false;
      if (case_expr->arg != NULL)
        return PTS_SUBSTITUTED_UNKNOWN;
      foreach(cell, case_expr->args)
      {
        const CaseWhen *when = lfirst_node(CaseWhen, cell);
        PtsNullTruth condition = null_substitution_truth(
          (const Node *) when->expr, context);
        if (condition == PTS_NULL_TRUTH_FALSE || condition == PTS_NULL_TRUTH_NULL)
          continue;
        if (condition == PTS_NULL_TRUTH_TRUE)
          return have_result
                   ? join_values(result, null_substitution_value(
                       (const Node *) when->result, context))
                   : null_substitution_value((const Node *) when->result,
                                                 context);
        result = have_result
                   ? join_values(result, null_substitution_value(
                       (const Node *) when->result, context))
                   : null_substitution_value((const Node *) when->result,
                                                 context);
        have_result = true;
      }
      return have_result
               ? join_values(result, null_substitution_value(
                   (const Node *) case_expr->defresult, context))
               : null_substitution_value((const Node *) case_expr->defresult,
                                             context);
    }
    default:
      return PTS_SUBSTITUTED_UNKNOWN;
  }
}

bool
pts_null_substitution_preserves_old_target(
  const Node *expr, const PtsNullSubstitutionContext *context)
{
  return null_substitution_evaluation_safe(expr, context) &&
         null_substitution_value(expr, context) ==
           PTS_SUBSTITUTED_SAME_OLD_TARGET_VALUE;
}
