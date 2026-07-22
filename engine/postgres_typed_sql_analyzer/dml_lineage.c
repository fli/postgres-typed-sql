#include "postgres.h"
#include "access/htup_details.h"
#include "catalog/pg_type.h"
#include "nodes/nodeFuncs.h"
#include "optimizer/clauses.h"
#include "parser/parsetree.h"
#include "utils/hsearch.h"
#include "utils/lsyscache.h"
#include "utils/syscache.h"
#include "dml_lineage.h"
#include "null_admission.h"
#include "query_scope.h"

typedef struct DmlParameterTargetKey
{
  int param_id;
  Oid target_relid;
  AttrNumber target_attnum;
  Oid target_type_oid;
  PtsNullAdmission target_null_admission;
  bool direct_assignment;
} DmlParameterTargetKey;

typedef enum LineageWorkKind
{
  LINEAGE_WORK_EXPR,
  LINEAGE_WORK_QUERY_OUTPUT,
  LINEAGE_WORK_SET_OPERATION
} LineageWorkKind;

typedef struct LineageVisitKey
{
  LineageWorkKind kind;
  const Query *query;
  const Node *node;
  AttrNumber output_attnum;
  PtsNullAdmission null_admission;
  bool value_preserving;
  bool null_propagating;
  bool unconditional;
} LineageVisitKey;

typedef struct LineageWorkItem
{
  LineageWorkKind kind;
  const PtsQueryScope *scope;
  const Node *node;
  AttrNumber output_attnum;
  PtsNullAdmission null_admission;
  bool value_preserving;
  bool null_propagating;
  bool unconditional;
  struct LineageWorkItem *next;
} LineageWorkItem;

typedef struct LineageWorkQueue
{
  LineageWorkItem *head;
  LineageWorkItem *tail;
} LineageWorkQueue;

typedef struct DmlLineageContext
{
  List **facts_list;
  Oid target_relid;
  AttrNumber target_attnum;
  HTAB *facts;
  PtsNullAdmissionAnalysis *null_admission_analysis;
  HTAB *visited;
  const List *target_list;
  const List *match_full_foreign_keys;
  const PtsDmlWriteEnforcement *enforcement;
} DmlLineageContext;

static const Node *
unwrap_direct_assignment_expr(DmlLineageContext *context, const Node *expr,
                              PtsNullAdmission *null_admission,
                              bool *direct_assignment)
{
  const Node *current = expr;

  while (current != NULL)
  {
    switch (nodeTag(current))
    {
      case T_RelabelType:
        current = (const Node *) ((const RelabelType *) current)->arg;
        break;
      case T_CoerceViaIO:
        *direct_assignment = false;
        current = (const Node *) ((const CoerceViaIO *) current)->arg;
        break;
      case T_CollateExpr:
        current = (const Node *) ((const CollateExpr *) current)->arg;
        break;
      case T_ArrayCoerceExpr:
        *direct_assignment = false;
        current = (const Node *) ((const ArrayCoerceExpr *) current)->arg;
        break;
      case T_ConvertRowtypeExpr:
        *direct_assignment = false;
        current = (const Node *) ((const ConvertRowtypeExpr *) current)->arg;
        break;
      case T_CoerceToDomain:
      {
        const CoerceToDomain *coerce = (const CoerceToDomain *) current;

        *null_admission = pts_combine_null_admission(
          *null_admission,
          pts_type_null_admission(context->null_admission_analysis,
                                  coerce->resulttype));
        current = (const Node *) coerce->arg;
        break;
      }
      case T_FuncExpr:
      {
        const FuncExpr *function = (const FuncExpr *) current;

        if (function->funcretset ||
            (function->funcformat != COERCE_EXPLICIT_CAST &&
             function->funcformat != COERCE_IMPLICIT_CAST) ||
            list_length(function->args) != 1 || !func_strict(function->funcid))
        {
          return current;
        }
        *direct_assignment = false;
        current = (const Node *) linitial(function->args);
        break;
      }
      default:
        return current;
    }
  }

  return NULL;
}

static void
append_dml_parameter_target(DmlLineageContext *context, int param_id,
                            PtsNullAdmission path_admission,
                            bool value_preserving, bool null_propagating,
                            bool unconditional)
{
  HeapTuple tuple;
  Form_pg_attribute attribute;
  DmlParameterTargetKey lookup_key;
  Oid type_oid;
  PtsNullAdmission target_admission;
  bool direct_assignment;
  bool found;

  if (!OidIsValid(context->target_relid) || context->target_attnum <= 0 || param_id <= 0)
  {
    return;
  }
  tuple = SearchSysCache2(ATTNUM, ObjectIdGetDatum(context->target_relid),
                          Int16GetDatum(context->target_attnum));
  if (!HeapTupleIsValid(tuple))
  {
    return;
  }

  attribute = (Form_pg_attribute) GETSTRUCT(tuple);
  if (attribute->attisdropped)
  {
    ReleaseSysCache(tuple);
    return;
  }

  type_oid = attribute->atttypid;
  target_admission = null_propagating ? path_admission : PTS_NULL_UNKNOWN;
  if (null_propagating && attribute->attnotnull)
  {
    target_admission = PTS_NULL_REJECTS;
  }
  if (null_propagating)
  {
    target_admission = pts_combine_null_admission(
      target_admission,
      pts_column_check_null_admission(context->null_admission_analysis,
                                  context->target_relid, context->target_attnum));
    target_admission = pts_combine_null_admission(
      target_admission,
      pts_type_null_admission(context->null_admission_analysis, type_oid));
    target_admission = pts_combine_null_admission(
      target_admission,
      pts_match_full_null_admission(context->match_full_foreign_keys,
                                context->target_list, param_id,
                                context->target_attnum));
  }
  if (target_admission != PTS_NULL_REJECTS &&
      !pts_dml_write_has_complete_target_null_constraints(context->enforcement))
  {
    target_admission = PTS_NULL_UNKNOWN;
  }
  if (!unconditional && target_admission == PTS_NULL_REJECTS)
  {
    target_admission = PTS_NULL_UNKNOWN;
  }
  direct_assignment = value_preserving && unconditional &&
                      pts_dml_write_has_structural_assignment_identity(
                        context->enforcement);

  memset(&lookup_key, 0, sizeof(lookup_key));
  lookup_key.param_id = param_id;
  lookup_key.target_relid = context->target_relid;
  lookup_key.target_attnum = context->target_attnum;
  lookup_key.target_type_oid = type_oid;
  lookup_key.target_null_admission = target_admission;
  lookup_key.direct_assignment = direct_assignment;
  hash_search(context->facts, &lookup_key, HASH_ENTER, &found);
  if (found)
  {
    ReleaseSysCache(tuple);
    return;
  }

  {
    PtsDmlLineageFact *fact = palloc0(sizeof(PtsDmlLineageFact));

    fact->param_id = param_id;
    fact->target_relid = context->target_relid;
    fact->target_attnum = context->target_attnum;
    fact->target_type_oid = type_oid;
    fact->admission = target_admission;
    fact->direct_assignment = direct_assignment;
    *context->facts_list = lappend(*context->facts_list, fact);
  }

  ReleaseSysCache(tuple);
}

static void
enqueue_lineage_work(DmlLineageContext *context, LineageWorkQueue *work,
                     LineageWorkKind kind, const PtsQueryScope *scope,
                     const Node *node, AttrNumber output_attnum,
                     PtsNullAdmission null_admission,
                     bool value_preserving, bool null_propagating,
                     bool unconditional)
{
  LineageVisitKey key;
  LineageWorkItem *item;
  bool found;

  if (scope == NULL || node == NULL)
  {
    return;
  }

  memset(&key, 0, sizeof(key));
  key.kind = kind;
  key.query = scope->query;
  key.node = node;
  key.output_attnum = output_attnum;
  key.null_admission = null_admission;
  key.value_preserving = value_preserving;
  key.null_propagating = null_propagating;
  key.unconditional = unconditional;
  hash_search(context->visited, &key, HASH_ENTER, &found);
  if (found)
  {
    return;
  }

  item = palloc(sizeof(LineageWorkItem));
  item->kind = kind;
  item->scope = scope;
  item->node = node;
  item->output_attnum = output_attnum;
  item->null_admission = null_admission;
  item->value_preserving = value_preserving;
  item->null_propagating = null_propagating;
  item->unconditional = unconditional;
  item->next = NULL;
  if (work->tail == NULL)
  {
    work->head = item;
  }
  else
  {
    work->tail->next = item;
  }
  work->tail = item;
}

typedef struct UnknownLineageWalkerContext
{
  DmlLineageContext *lineage;
  LineageWorkQueue *work;
  const PtsQueryScope *scope;
} UnknownLineageWalkerContext;

static bool
enqueue_unknown_lineage_walker(Node *node, void *walker_context)
{
  UnknownLineageWalkerContext *context = (UnknownLineageWalkerContext *) walker_context;

  if (node == NULL)
  {
    return false;
  }
  if (IsA(node, Param))
  {
    const Param *param = (const Param *) node;

    if (param->paramkind == PARAM_EXTERN)
    {
      append_dml_parameter_target(context->lineage, param->paramid,
                                  PTS_NULL_UNKNOWN, false, false, false);
    }
    return false;
  }
  if (IsA(node, Var))
  {
    enqueue_lineage_work(context->lineage, context->work, LINEAGE_WORK_EXPR,
                         context->scope, node, 0, PTS_NULL_UNKNOWN,
                         false, false, false);
    return false;
  }
  if (IsA(node, Query))
  {
    PtsQueryScope *query_scope = pts_make_query_scope((const Query *) node, context->scope);
    UnknownLineageWalkerContext query_context = {
      context->lineage,
      context->work,
      query_scope
    };

    return query_tree_walker((Query *) node, enqueue_unknown_lineage_walker,
                             &query_context, 0);
  }
  return expression_tree_walker(node, enqueue_unknown_lineage_walker,
                                walker_context);
}

static void
append_direct_parameter_targets(DmlLineageContext *context, const PtsQueryScope *scope,
                                const Node *expr, PtsNullAdmission null_admission,
                                bool unconditional)
{
  LineageWorkQueue work = {NULL, NULL};

  enqueue_lineage_work(context, &work, LINEAGE_WORK_EXPR, scope, expr, 0,
                       null_admission, true, true, unconditional);

  while (work.head != NULL)
  {
    LineageWorkItem *item = work.head;

    work.head = item->next;
    if (work.head == NULL)
    {
      work.tail = NULL;
    }

    if (item->kind == LINEAGE_WORK_QUERY_OUTPUT)
    {
      const TargetEntry *target;
      bool unconditional = item->unconditional &&
                           pts_query_output_is_unconditional(item->scope);

      if (item->scope->query->setOperations != NULL)
      {
        enqueue_lineage_work(context, &work, LINEAGE_WORK_SET_OPERATION,
                             item->scope, item->scope->query->setOperations,
                             item->output_attnum, item->null_admission,
                             item->value_preserving, item->null_propagating,
                             unconditional);
      }
      else
      {
        target = pts_target_entry_by_resno(item->scope->query->targetList,
                                           item->output_attnum);
        if (target != NULL)
        {
          enqueue_lineage_work(context, &work, LINEAGE_WORK_EXPR, item->scope,
                               (const Node *) target->expr, 0, item->null_admission,
                               item->value_preserving, item->null_propagating,
                               unconditional);
        }
      }
      pfree(item);
      continue;
    }

    if (item->kind == LINEAGE_WORK_SET_OPERATION)
    {
      if (IsA(item->node, SetOperationStmt))
      {
        const SetOperationStmt *set = (const SetOperationStmt *) item->node;

        switch (set->op)
        {
          case SETOP_UNION:
            enqueue_lineage_work(context, &work, LINEAGE_WORK_SET_OPERATION,
                                 item->scope, set->larg, item->output_attnum,
                                 item->null_admission, item->value_preserving,
                                 item->null_propagating, item->unconditional);
            enqueue_lineage_work(context, &work, LINEAGE_WORK_SET_OPERATION,
                                 item->scope, set->rarg, item->output_attnum,
                                 item->null_admission, item->value_preserving,
                                 item->null_propagating, item->unconditional);
            break;
          case SETOP_INTERSECT:
            enqueue_lineage_work(context, &work, LINEAGE_WORK_SET_OPERATION,
                                 item->scope, set->larg, item->output_attnum,
                                 item->null_admission, item->value_preserving,
                                 item->null_propagating, false);
            enqueue_lineage_work(context, &work, LINEAGE_WORK_SET_OPERATION,
                                 item->scope, set->rarg, item->output_attnum,
                                 item->null_admission, item->value_preserving,
                                 item->null_propagating, false);
            break;
          case SETOP_EXCEPT:
            enqueue_lineage_work(context, &work, LINEAGE_WORK_SET_OPERATION,
                                 item->scope, set->larg, item->output_attnum,
                                 item->null_admission, item->value_preserving,
                                 item->null_propagating, false);
            break;
          case SETOP_NONE:
            enqueue_lineage_work(context, &work, LINEAGE_WORK_SET_OPERATION,
                                 item->scope, set->larg, item->output_attnum,
                                 item->null_admission, item->value_preserving,
                                 item->null_propagating, false);
            enqueue_lineage_work(context, &work, LINEAGE_WORK_SET_OPERATION,
                                 item->scope, set->rarg, item->output_attnum,
                                 item->null_admission, item->value_preserving,
                                 item->null_propagating, false);
            break;
        }
      }
      else if (IsA(item->node, RangeTblRef))
      {
        const RangeTblRef *reference = (const RangeTblRef *) item->node;

        if (reference->rtindex > 0 &&
            reference->rtindex <= list_length(item->scope->query->rtable))
        {
          const RangeTblEntry *rte = rt_fetch(reference->rtindex,
                                              item->scope->query->rtable);

          if (rte->rtekind == RTE_SUBQUERY && rte->subquery != NULL)
          {
            PtsQueryScope *child_scope = pts_make_query_scope(rte->subquery, item->scope);

            enqueue_lineage_work(context, &work, LINEAGE_WORK_QUERY_OUTPUT,
                                 child_scope, (const Node *) rte->subquery,
                                 item->output_attnum, item->null_admission,
                                 item->value_preserving, item->null_propagating,
                                 item->unconditional);
          }
        }
      }
      pfree(item);
      continue;
    }

    if (item->kind == LINEAGE_WORK_EXPR)
    {
      PtsNullAdmission item_admission = item->null_admission;
      bool value_preserving = item->value_preserving;
      const Node *unwrapped = unwrap_direct_assignment_expr(context, item->node,
                                                            &item_admission,
                                                            &value_preserving);

      if (unwrapped != NULL && IsA(unwrapped, Param))
      {
        const Param *param = (const Param *) unwrapped;

        if (param->paramkind == PARAM_EXTERN)
        {
          append_dml_parameter_target(context, param->paramid, item_admission,
                                      value_preserving, item->null_propagating,
                                      item->unconditional);
        }
      }
      else if (unwrapped != NULL && IsA(unwrapped, Var))
      {
        const Var *var = (const Var *) unwrapped;
        const PtsQueryScope *variable_scope = pts_query_scope_at_level(item->scope,
                                                                var->varlevelsup);

        if (var->varnullingrels != NULL)
        {
          value_preserving = false;
        }

        if (variable_scope != NULL && var->varno > 0 &&
            var->varno <= list_length(variable_scope->query->rtable))
        {
          const RangeTblEntry *rte = rt_fetch(var->varno, variable_scope->query->rtable);

          if (variable_scope->query->onConflict != NULL &&
              var->varno == variable_scope->query->onConflict->exclRelIndex)
          {
            if (var->varattno > 0)
            {
              const TargetEntry *insert_target = pts_target_entry_by_resno(
                variable_scope->query->targetList, var->varattno);

              if (insert_target != NULL)
              {
                enqueue_lineage_work(context, &work, LINEAGE_WORK_EXPR,
                                     variable_scope,
                                     (const Node *) insert_target->expr,
                                     0, item_admission, false,
                                     item->null_propagating, false);
              }
            }
            else if (var->varattno == InvalidAttrNumber)
            {
              ListCell *target_cell;

              foreach(target_cell, variable_scope->query->targetList)
              {
                const TargetEntry *insert_target =
                  lfirst_node(TargetEntry, target_cell);
                UnknownLineageWalkerContext walker_context = {
                  context,
                  &work,
                  variable_scope
                };

                if (!insert_target->resjunk)
                {
                  enqueue_unknown_lineage_walker(
                    (Node *) insert_target->expr, &walker_context);
                }
              }
            }
          }
          else if (var->varattno > 0 && rte->rtekind == RTE_VALUES)
          {
            ListCell *row_cell;

            foreach(row_cell, rte->values_lists)
            {
              const List *row = (const List *) lfirst(row_cell);

              if (var->varattno <= list_length(row))
              {
                enqueue_lineage_work(context, &work, LINEAGE_WORK_EXPR,
                                     variable_scope,
                                     (const Node *) list_nth(row, var->varattno - 1),
                                     0, item_admission, value_preserving,
                                     item->null_propagating, item->unconditional);
              }
            }
          }
          else if (var->varattno > 0 && rte->rtekind == RTE_SUBQUERY &&
                   rte->subquery != NULL)
          {
            PtsQueryScope *child_scope = pts_make_query_scope(rte->subquery, variable_scope);

            enqueue_lineage_work(context, &work, LINEAGE_WORK_QUERY_OUTPUT,
                                 child_scope, (const Node *) rte->subquery,
                                 var->varattno, item_admission,
                                 value_preserving, item->null_propagating,
                                 item->unconditional);
          }
          else if (var->varattno > 0 && rte->rtekind == RTE_CTE)
          {
            const PtsQueryScope *owner_scope = pts_query_scope_at_level(variable_scope,
                                                                 rte->ctelevelsup);
            const CommonTableExpr *cte = owner_scope == NULL
                                           ? NULL
                                           : pts_cte_by_name(owner_scope->query, rte->ctename);
            const Query *cte_query = cte == NULL ? NULL : (const Query *) cte->ctequery;

            if (cte_query != NULL)
            {
              PtsQueryScope *cte_scope = pts_make_query_scope(cte_query, owner_scope);

              enqueue_lineage_work(context, &work, LINEAGE_WORK_QUERY_OUTPUT,
                                   cte_scope, (const Node *) cte_query,
                                   var->varattno, item_admission,
                                   value_preserving, item->null_propagating,
                                   item->unconditional);
            }
          }
          else if (var->varattno > 0 && rte->rtekind == RTE_JOIN &&
                   var->varattno <= list_length(rte->joinaliasvars))
          {
            enqueue_lineage_work(context, &work, LINEAGE_WORK_EXPR,
                                 variable_scope,
                                 (const Node *) list_nth(rte->joinaliasvars,
                                                        var->varattno - 1),
                                 0, item_admission, value_preserving,
                                 item->null_propagating, item->unconditional);
          }
          else if (var->varattno > 0 && rte->rtekind == RTE_GROUP &&
                   var->varattno <= list_length(rte->groupexprs))
          {
            enqueue_lineage_work(context, &work, LINEAGE_WORK_EXPR,
                                 variable_scope,
                                 (const Node *) list_nth(rte->groupexprs,
                                                        var->varattno - 1),
                                 0, item_admission, value_preserving,
                                 item->null_propagating, item->unconditional);
          }
          else if (var->varattno == InvalidAttrNumber &&
                   (rte->rtekind == RTE_VALUES ||
                    rte->rtekind == RTE_JOIN ||
                    rte->rtekind == RTE_GROUP))
          {
            const Node *payload = rte->rtekind == RTE_VALUES
                                    ? (const Node *) rte->values_lists
                                    : rte->rtekind == RTE_JOIN
                                        ? (const Node *) rte->joinaliasvars
                                        : (const Node *) rte->groupexprs;
            UnknownLineageWalkerContext walker_context = {
              context,
              &work,
              variable_scope
            };

            enqueue_unknown_lineage_walker((Node *) payload,
                                            &walker_context);
          }
          else if (var->varattno == InvalidAttrNumber &&
                   rte->rtekind == RTE_SUBQUERY && rte->subquery != NULL)
          {
            UnknownLineageWalkerContext walker_context = {
              context,
              &work,
              variable_scope
            };

            enqueue_unknown_lineage_walker(
              (Node *) rte->subquery, &walker_context);
          }
          else if (var->varattno == InvalidAttrNumber &&
                   rte->rtekind == RTE_CTE)
          {
            const PtsQueryScope *owner_scope = pts_query_scope_at_level(
              variable_scope, rte->ctelevelsup);
            const CommonTableExpr *cte = owner_scope == NULL
                                           ? NULL
                                           : pts_cte_by_name(owner_scope->query,
                                                         rte->ctename);

            if (cte != NULL && cte->ctequery != NULL &&
                IsA(cte->ctequery, Query))
            {
              UnknownLineageWalkerContext walker_context = {
                context,
                &work,
                owner_scope
              };

              enqueue_unknown_lineage_walker(cte->ctequery,
                                              &walker_context);
            }
          }
          else if (rte->rtekind == RTE_FUNCTION)
          {
            ListCell *function_cell;

            foreach(function_cell, rte->functions)
            {
              const RangeTblFunction *function =
                lfirst_node(RangeTblFunction, function_cell);
              UnknownLineageWalkerContext walker_context = {
                context,
                &work,
                variable_scope
              };

              enqueue_unknown_lineage_walker(function->funcexpr,
                                              &walker_context);
            }
          }
          else if (rte->rtekind == RTE_TABLEFUNC && rte->tablefunc != NULL)
          {
            UnknownLineageWalkerContext walker_context = {
              context,
              &work,
              variable_scope
            };

            enqueue_unknown_lineage_walker((Node *) rte->tablefunc,
                                            &walker_context);
          }
        }
      }
      else if (unwrapped != NULL)
      {
        UnknownLineageWalkerContext walker_context = {
          context,
          &work,
          item->scope
        };

        enqueue_unknown_lineage_walker((Node *) unwrapped, &walker_context);
      }
    }
    pfree(item);
  }
}

static void
collect_targets_from_list(List **facts_list, const PtsQueryScope *scope,
                         const List *target_list, Oid target_relid,
                         bool unconditional,
                         const PtsDmlWriteEnforcement *enforcement,
                         HTAB *facts,
                         PtsNullAdmissionAnalysis *null_admission_analysis)
{
  ListCell *cell;

  foreach(cell, target_list)
  {
    const TargetEntry *target = lfirst_node(TargetEntry, cell);

    if (!target->resjunk && target->resno > 0)
    {
      HASHCTL visited_control;
      DmlLineageContext context;

      memset(&visited_control, 0, sizeof(visited_control));
      visited_control.keysize = sizeof(LineageVisitKey);
      visited_control.entrysize = sizeof(LineageVisitKey);
      context.facts_list = facts_list;
      context.target_relid = target_relid;
      context.target_attnum = target->resno;
      context.facts = facts;
      context.null_admission_analysis = null_admission_analysis;
      context.target_list = target_list;
      context.match_full_foreign_keys =
        pts_dml_write_match_full_foreign_keys(enforcement);
      context.enforcement = enforcement;
      context.visited = hash_create("typed SQL DML lineage visits", 32,
                                    &visited_control, HASH_ELEM | HASH_BLOBS);
      append_direct_parameter_targets(&context, scope, (const Node *) target->expr,
                                      PTS_NULL_ADMITS, unconditional);
      hash_destroy(context.visited);
    }
  }
}

List *
pts_collect_dml_lineage(const Query *query)
{
  const RangeTblEntry *target_rte = NULL;
  Oid target_relid = InvalidOid;
  List *lineage = NIL;
  HASHCTL fact_control;
  HTAB *facts;
  PtsNullAdmissionAnalysis *null_admission_analysis;
  PtsQueryScope scope = {query, NULL};

  memset(&fact_control, 0, sizeof(fact_control));
  fact_control.keysize = sizeof(DmlParameterTargetKey);
  fact_control.entrysize = sizeof(DmlParameterTargetKey);
  facts = hash_create("typed SQL DML parameter target facts", 32,
                      &fact_control, HASH_ELEM | HASH_BLOBS);
  null_admission_analysis = pts_create_null_admission_analysis();

  if (query->resultRelation > 0 && query->resultRelation <= list_length(query->rtable))
  {
    target_rte = rt_fetch(query->resultRelation, query->rtable);
    target_relid = target_rte->relid;
  }

  if (OidIsValid(target_relid) &&
      (query->commandType == CMD_INSERT || query->commandType == CMD_UPDATE))
  {
    PtsDmlWriteEnforcement *enforcement =
      pts_inspect_dml_write_enforcement(query, target_rte, query->commandType);

    collect_targets_from_list(&lineage, &scope, query->targetList, target_relid,
                             query->commandType == CMD_UPDATE ||
                             (query->commandType == CMD_INSERT &&
                              pts_query_output_is_unconditional(&scope)),
                             enforcement, facts, null_admission_analysis);
    pts_release_dml_write_enforcement(enforcement);
  }

  if (OidIsValid(target_relid) && query->onConflict != NULL &&
      query->onConflict->action == ONCONFLICT_UPDATE)
  {
    PtsDmlWriteEnforcement *enforcement =
      pts_inspect_dml_write_enforcement(query, target_rte, CMD_UPDATE);

    collect_targets_from_list(&lineage, &scope,
                             query->onConflict->onConflictSet,
                             target_relid, false, enforcement, facts,
                             null_admission_analysis);
    pts_release_dml_write_enforcement(enforcement);
  }

  if (OidIsValid(target_relid) && query->commandType == CMD_MERGE)
  {
    ListCell *cell;
    PtsDmlWriteEnforcement *insert_enforcement =
      pts_inspect_dml_write_enforcement(query, target_rte, CMD_INSERT);
    PtsDmlWriteEnforcement *update_enforcement =
      pts_inspect_dml_write_enforcement(query, target_rte, CMD_UPDATE);
    foreach(cell, query->mergeActionList)
    {
      const MergeAction *action = lfirst_node(MergeAction, cell);

      if (action->commandType == CMD_INSERT)
      {
        collect_targets_from_list(&lineage, &scope, action->targetList,
                                 target_relid, false, insert_enforcement, facts,
                                 null_admission_analysis);
      }
      else if (action->commandType == CMD_UPDATE)
      {
        collect_targets_from_list(&lineage, &scope, action->targetList,
                                 target_relid, false, update_enforcement, facts,
                                 null_admission_analysis);
      }
    }
    pts_release_dml_write_enforcement(insert_enforcement);
    pts_release_dml_write_enforcement(update_enforcement);
  }

  pts_destroy_null_admission_analysis(null_admission_analysis);
  hash_destroy(facts);
  return lineage;
}
