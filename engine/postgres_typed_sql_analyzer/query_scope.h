#ifndef POSTGRES_TYPED_SQL_QUERY_SCOPE_H
#define POSTGRES_TYPED_SQL_QUERY_SCOPE_H

#include "postgres.h"
#include "nodes/parsenodes.h"

typedef struct PtsQueryScope
{
  const Query *query;
  const struct PtsQueryScope *parent;
} PtsQueryScope;

typedef bool (*PtsExecutionReachableQueryVisitor)(
  const PtsQueryScope *scope, void *context);

extern const CommonTableExpr *pts_cte_by_name(const Query *query,
                                              const char *name);
extern const PtsQueryScope *pts_query_scope_at_level(
  const PtsQueryScope *scope, Index levels_up);
extern PtsQueryScope *pts_make_query_scope(const Query *query,
                                           const PtsQueryScope *parent);
extern bool pts_query_is_data_modifying(const Query *query);
extern bool pts_query_output_is_unconditional(const PtsQueryScope *scope);
extern const TargetEntry *pts_target_entry_by_resno(
  const List *target_list, AttrNumber resno);
extern bool pts_execution_reachable_query_walker(
  const Query *query, PtsExecutionReachableQueryVisitor visitor,
  void *context);

#endif
