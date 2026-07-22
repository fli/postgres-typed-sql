#include "postgres.h"

#include "nodes/nodeFuncs.h"
#include "nodes/parsenodes.h"
#include "parser/parsetree.h"
#include "utils/hsearch.h"
#include "utils/memutils.h"

#include "query_scope.h"

const TargetEntry *
pts_target_entry_by_resno(const List *target_list, AttrNumber resno)
{
  ListCell *cell;

  foreach(cell, target_list)
  {
    const TargetEntry *target = lfirst_node(TargetEntry, cell);

    if (!target->resjunk && target->resno == resno)
      return target;
  }
  return NULL;
}

typedef struct PtsExecutionReachableQueryKey
{
  const Query *query;
} PtsExecutionReachableQueryKey;

typedef struct PtsExecutionReachableQueryContext
{
  const PtsQueryScope *scope;
  PtsExecutionReachableQueryVisitor visitor;
  void *visitor_context;
  HTAB *visited;
} PtsExecutionReachableQueryContext;

static bool pts_execution_reachable_query_walker_internal(
  const Query *query, const PtsQueryScope *parent_scope,
  PtsExecutionReachableQueryVisitor visitor, void *visitor_context,
  HTAB *visited);

const CommonTableExpr *
pts_cte_by_name(const Query *query, const char *name)
{
  ListCell *cell;

  if (name == NULL)
  {
    return NULL;
  }

  foreach(cell, query->cteList)
  {
    const CommonTableExpr *cte = lfirst_node(CommonTableExpr, cell);

    if (strcmp(cte->ctename, name) == 0 && cte->ctequery != NULL &&
        IsA(cte->ctequery, Query))
    {
      return cte;
    }
  }

  return NULL;
}

const PtsQueryScope *
pts_query_scope_at_level(const PtsQueryScope *scope, Index levels_up)
{
  const PtsQueryScope *current = scope;

  while (current != NULL && levels_up > 0)
  {
    current = current->parent;
    levels_up--;
  }

  return current;
}

PtsQueryScope *
pts_make_query_scope(const Query *query, const PtsQueryScope *parent)
{
  PtsQueryScope *scope = palloc(sizeof(PtsQueryScope));

  scope->query = query;
  scope->parent = parent;
  return scope;
}

bool
pts_query_is_data_modifying(const Query *query)
{
  return query->commandType == CMD_INSERT ||
         query->commandType == CMD_UPDATE ||
         query->commandType == CMD_DELETE ||
         query->commandType == CMD_MERGE;
}

static bool pts_query_output_is_unconditional_at_depth(
  const PtsQueryScope *scope, int depth);

static bool
pts_from_node_is_unconditional(const PtsQueryScope *scope, const Node *node,
                               int depth)
{
  const Query *query = scope->query;

  if (node == NULL || depth <= 0)
    return false;
  if (IsA(node, RangeTblRef))
  {
    const RangeTblRef *reference = (const RangeTblRef *) node;
    const RangeTblEntry *rte;

    if (reference->rtindex <= 0 ||
        reference->rtindex > list_length(query->rtable))
      return false;
    rte = rt_fetch(reference->rtindex, query->rtable);
    switch (rte->rtekind)
    {
      case RTE_RESULT:
        return true;
      case RTE_VALUES:
        return rte->values_lists != NIL;
      case RTE_SUBQUERY:
        if (rte->subquery != NULL)
        {
          PtsQueryScope child_scope = {rte->subquery, scope};

          return pts_query_output_is_unconditional_at_depth(&child_scope,
                                                             depth - 1);
        }
        return false;
      case RTE_CTE:
      {
        const PtsQueryScope *owner_scope =
          pts_query_scope_at_level(scope, rte->ctelevelsup);
        const CommonTableExpr *cte = owner_scope == NULL
                                       ? NULL
                                       : pts_cte_by_name(owner_scope->query,
                                                         rte->ctename);

        if (cte != NULL && !cte->cterecursive && cte->ctequery != NULL &&
            IsA(cte->ctequery, Query))
        {
          PtsQueryScope cte_scope = {(const Query *) cte->ctequery,
                                     owner_scope};

          return pts_query_output_is_unconditional_at_depth(&cte_scope,
                                                             depth - 1);
        }
        return false;
      }
      default:
        return false;
    }
  }
  if (IsA(node, JoinExpr))
  {
    const JoinExpr *join = (const JoinExpr *) node;
    bool left = pts_from_node_is_unconditional(scope, join->larg, depth - 1);
    bool right = pts_from_node_is_unconditional(scope, join->rarg, depth - 1);

    switch (join->jointype)
    {
      case JOIN_INNER:
        return join->quals == NULL && left && right;
      case JOIN_LEFT:
        return left;
      case JOIN_RIGHT:
        return right;
      case JOIN_FULL:
        return left || right;
      default:
        return false;
    }
  }
  return false;
}

static bool
pts_query_output_is_unconditional_at_depth(const PtsQueryScope *scope,
                                            int depth)
{
  const Query *query = scope->query;
  ListCell *from_cell;

  if (depth <= 0 || (query->commandType != CMD_SELECT &&
                     query->commandType != CMD_INSERT) ||
      query->hasTargetSRFs || query->havingQual != NULL ||
      query->limitOffset != NULL || query->limitCount != NULL)
    return false;
  if (query->hasAggs && query->groupClause == NIL &&
      query->groupingSets == NIL)
    return true;
  if (query->jointree == NULL || query->jointree->quals != NULL)
    return false;
  foreach(from_cell, query->jointree->fromlist)
  {
    if (!pts_from_node_is_unconditional(scope,
                                        (const Node *) lfirst(from_cell),
                                        depth - 1))
      return false;
  }
  return true;
}

bool
pts_query_output_is_unconditional(const PtsQueryScope *scope)
{
  return scope != NULL && pts_query_output_is_unconditional_at_depth(scope, 16);
}

static bool
pts_execution_reachable_query_discovery_walker(Node *node,
                                                void *walker_context)
{
  PtsExecutionReachableQueryContext *context =
    (PtsExecutionReachableQueryContext *) walker_context;

  if (node == NULL)
  {
    return false;
  }
  if (IsA(node, Query))
  {
    return pts_execution_reachable_query_walker_internal(
      (const Query *) node, context->scope, context->visitor,
      context->visitor_context, context->visited);
  }
  if (IsA(node, RangeTblEntry))
  {
    const RangeTblEntry *rte = (const RangeTblEntry *) node;

    if (rte->rtekind == RTE_CTE)
    {
      const PtsQueryScope *owner_scope = pts_query_scope_at_level(
        context->scope, rte->ctelevelsup);
      const CommonTableExpr *cte = owner_scope == NULL
                                     ? NULL
                                     : pts_cte_by_name(owner_scope->query,
                                                       rte->ctename);

      if (cte != NULL && cte->ctequery != NULL &&
          IsA(cte->ctequery, Query) &&
          pts_execution_reachable_query_walker_internal(
            (const Query *) cte->ctequery, owner_scope, context->visitor,
            context->visitor_context, context->visited))
      {
        return true;
      }
    }
    return false;
  }
  return expression_tree_walker(
    node, pts_execution_reachable_query_discovery_walker, walker_context);
}

static bool
pts_execution_reachable_query_walker_internal(
  const Query *query, const PtsQueryScope *parent_scope,
  PtsExecutionReachableQueryVisitor visitor, void *visitor_context,
  HTAB *visited)
{
  PtsExecutionReachableQueryKey key;
  PtsQueryScope scope = {query, parent_scope};
  PtsExecutionReachableQueryContext context = {
    &scope,
    visitor,
    visitor_context,
    visited
  };
  ListCell *cell;
  bool found;

  memset(&key, 0, sizeof(key));
  key.query = query;
  hash_search(visited, &key, HASH_ENTER, &found);
  if (found)
  {
    return false;
  }
  if (visitor(&scope, visitor_context))
  {
    return true;
  }

  /*
   * PostgreSQL executes data-modifying CTEs to completion when their owning
   * query executes, even if no RTE_CTE references their result.
   */
  foreach(cell, query->cteList)
  {
    const CommonTableExpr *cte = lfirst_node(CommonTableExpr, cell);

    if (cte->ctequery != NULL && IsA(cte->ctequery, Query) &&
        pts_query_is_data_modifying((const Query *) cte->ctequery) &&
        pts_execution_reachable_query_walker_internal(
          (const Query *) cte->ctequery, &scope, visitor, visitor_context,
          visited))
    {
      return true;
    }
  }

  /*
   * Ordinary CTE bodies are reached only through RTE_CTE references.  RTE
   * subqueries and SubLinks remain ordinary reachable child queries.
   */
  return query_tree_walker(
    (Query *) query, pts_execution_reachable_query_discovery_walker, &context,
    QTW_IGNORE_CTE_SUBQUERIES | QTW_EXAMINE_RTES_BEFORE);
}

bool
pts_execution_reachable_query_walker(
  const Query *query, PtsExecutionReachableQueryVisitor visitor, void *context)
{
  HASHCTL control;
  HTAB *visited;
  bool result;

  memset(&control, 0, sizeof(control));
  control.keysize = sizeof(PtsExecutionReachableQueryKey);
  control.entrysize = sizeof(PtsExecutionReachableQueryKey);
  visited = hash_create("typed SQL reachable query visits", 32,
                        &control, HASH_ELEM | HASH_BLOBS);
  result = pts_execution_reachable_query_walker_internal(
    query, NULL, visitor, context, visited);
  hash_destroy(visited);
  return result;
}
