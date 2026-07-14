#include "postgres.h"

#include "catalog/pg_attribute.h"
#include "catalog/pg_type.h"
#include "catalog/pg_type_d.h"
#include "fmgr.h"
#include "nodes/bitmapset.h"
#include "nodes/nodeFuncs.h"
#include "nodes/parsenodes.h"
#include "nodes/primnodes.h"
#include "nodes/value.h"
#include "parser/parsetree.h"
#include "tcop/tcopprot.h"
#include "utils/array.h"
#include "utils/builtins.h"
#include "utils/lsyscache.h"
#include "utils/syscache.h"

PG_MODULE_MAGIC;

PG_FUNCTION_INFO_V1(postgres_typed_sql_analyze);

static void append_expr_node(StringInfo out, const Query *query, const Node *expr, int depth);
static void append_query_summary(StringInfo out, const Query *query, int depth);
static void append_from_node(StringInfo out, const Query *query, const Node *node, int depth);
static void append_rtable(StringInfo out, const Query *query, int depth);
static const char *command_type_name(CmdType command_type);
static void append_json_string(StringInfo out, const char *value);
static void append_bool_field(StringInfo out, const char *name, bool value);
static void append_oid_field(StringInfo out, const char *name, Oid value);
static void append_optional_name_field(StringInfo out, const char *name, const char *value);

typedef struct QueryScope
{
  const Query *query;
  const struct QueryScope *parent;
} QueryScope;

typedef struct DmlParameterTargetKey
{
  int param_id;
  Oid target_relid;
  AttrNumber target_attnum;
  const char *source;
} DmlParameterTargetKey;

static const TargetEntry *
target_entry_by_resno(const List *target_list, AttrNumber resno)
{
  ListCell *cell;

  foreach(cell, target_list)
  {
    const TargetEntry *target = lfirst_node(TargetEntry, cell);

    if (!target->resjunk && target->resno == resno)
    {
      return target;
    }
  }

  return NULL;
}

static const CommonTableExpr *
cte_by_name(const Query *query, const char *name)
{
  ListCell *cell;

  if (name == NULL)
  {
    return NULL;
  }

  foreach(cell, query->cteList)
  {
    const CommonTableExpr *cte = lfirst_node(CommonTableExpr, cell);

    if (strcmp(cte->ctename, name) == 0 && cte->ctequery != NULL && IsA(cte->ctequery, Query))
    {
      return cte;
    }
  }

  return NULL;
}

static const Node *
unwrap_direct_assignment_expr(const Node *expr)
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
        current = (const Node *) ((const CoerceViaIO *) current)->arg;
        break;
      case T_CollateExpr:
        current = (const Node *) ((const CollateExpr *) current)->arg;
        break;
      case T_ArrayCoerceExpr:
        current = (const Node *) ((const ArrayCoerceExpr *) current)->arg;
        break;
      case T_ConvertRowtypeExpr:
        current = (const Node *) ((const ConvertRowtypeExpr *) current)->arg;
        break;
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
append_dml_parameter_target(StringInfo out, Oid relid, AttrNumber attnum,
                            int param_id, const char *source, bool *first, List **seen)
{
  HeapTuple tuple;
  Form_pg_attribute attribute;
  DmlParameterTargetKey *key;
  ListCell *cell;
  Oid type_oid;
  char *type_name;

  if (!OidIsValid(relid) || attnum <= 0 || param_id <= 0)
  {
    return;
  }

  foreach(cell, *seen)
  {
    const DmlParameterTargetKey *existing = (const DmlParameterTargetKey *) lfirst(cell);

    if (existing->param_id == param_id && existing->target_relid == relid &&
        existing->target_attnum == attnum && strcmp(existing->source, source) == 0)
    {
      return;
    }
  }

  tuple = SearchSysCache2(ATTNUM, ObjectIdGetDatum(relid), Int16GetDatum(attnum));
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
  type_name = OidIsValid(type_oid)
                ? format_type_extended(type_oid, attribute->atttypmod, FORMAT_TYPE_TYPEMOD_GIVEN)
                : NULL;

  key = palloc(sizeof(DmlParameterTargetKey));
  key->param_id = param_id;
  key->target_relid = relid;
  key->target_attnum = attnum;
  key->source = source;
  *seen = lappend(*seen, key);

  if (!*first)
  {
    appendStringInfoChar(out, ',');
  }
  *first = false;

  appendStringInfo(out,
                   "{\"paramId\":%d,\"targetRelid\":%u,\"targetAttnum\":%d,\"targetAttname\":",
                   param_id, relid, attnum);
  append_json_string(out, NameStr(attribute->attname));
  append_bool_field(out, "targetNullable",
                    !attribute->attnotnull && get_typtype(type_oid) != TYPTYPE_DOMAIN);
  append_oid_field(out, "targetTypeOid", type_oid);
  append_optional_name_field(out, "targetTypeName", type_name);
  appendStringInfoString(out, ",\"source\":");
  append_json_string(out, source);
  appendStringInfoChar(out, '}');

  ReleaseSysCache(tuple);
}

static const QueryScope *
query_scope_at_level(const QueryScope *scope, Index levels_up)
{
  const QueryScope *current = scope;

  while (current != NULL && levels_up > 0)
  {
    current = current->parent;
    levels_up--;
  }

  return current;
}

static void
append_direct_parameter_targets(StringInfo out, const QueryScope *scope, const Node *expr,
                                Oid target_relid, AttrNumber target_attnum,
                                const char *source, bool *first, List **seen, int depth)
{
  const Query *query = scope->query;
  const Node *unwrapped;

  if (expr == NULL || depth <= 0)
  {
    return;
  }

  unwrapped = unwrap_direct_assignment_expr(expr);
  if (unwrapped == NULL)
  {
    return;
  }

  if (IsA(unwrapped, Param))
  {
    const Param *param = (const Param *) unwrapped;

    if (param->paramkind == PARAM_EXTERN)
    {
      append_dml_parameter_target(out, target_relid, target_attnum,
                                  param->paramid, source, first, seen);
    }
    return;
  }

  if (IsA(unwrapped, Var))
  {
    const Var *var = (const Var *) unwrapped;
    const RangeTblEntry *rte;

    if (var->varlevelsup != 0 || var->varattno <= 0 ||
        var->varno <= 0 || var->varno > list_length(query->rtable))
    {
      return;
    }

    rte = rt_fetch(var->varno, query->rtable);
    if (rte->rtekind == RTE_VALUES)
    {
      ListCell *row_cell;

      foreach(row_cell, rte->values_lists)
      {
        const List *row = (const List *) lfirst(row_cell);

        if (var->varattno <= list_length(row))
        {
          append_direct_parameter_targets(out, scope,
                                          (const Node *) list_nth(row, var->varattno - 1),
                                          target_relid, target_attnum, source, first, seen, depth - 1);
        }
      }
      return;
    }

    if (rte->rtekind == RTE_SUBQUERY && rte->subquery != NULL && rte->subquery->setOperations == NULL)
    {
      const TargetEntry *target = target_entry_by_resno(rte->subquery->targetList, var->varattno);

      if (target != NULL)
      {
        QueryScope child_scope = {rte->subquery, scope};

        append_direct_parameter_targets(out, &child_scope, (const Node *) target->expr,
                                        target_relid, target_attnum, source, first, seen, depth - 1);
      }
      return;
    }

    if (rte->rtekind == RTE_CTE)
    {
      const QueryScope *owner_scope = query_scope_at_level(scope, rte->ctelevelsup);
      const CommonTableExpr *cte = owner_scope == NULL
                                     ? NULL
                                     : cte_by_name(owner_scope->query, rte->ctename);
      const Query *cte_query = cte == NULL ? NULL : (const Query *) cte->ctequery;
      const TargetEntry *target = cte_query == NULL || cte->cterecursive || cte_query->setOperations != NULL
                                    ? NULL
                                    : target_entry_by_resno(cte_query->targetList, var->varattno);

      if (target != NULL)
      {
        QueryScope cte_scope = {cte_query, owner_scope};

        append_direct_parameter_targets(out, &cte_scope, (const Node *) target->expr,
                                        target_relid, target_attnum, source, first, seen, depth - 1);
      }
      return;
    }

    if (rte->rtekind == RTE_JOIN && var->varattno <= list_length(rte->joinaliasvars))
    {
      append_direct_parameter_targets(out, scope,
                                      (const Node *) list_nth(rte->joinaliasvars, var->varattno - 1),
                                      target_relid, target_attnum, source, first, seen, depth - 1);
    }
  }
}

static void
append_targets_from_list(StringInfo out, const QueryScope *scope, const List *target_list,
                         Oid target_relid, const char *source, bool *first, List **seen)
{
  ListCell *cell;

  foreach(cell, target_list)
  {
    const TargetEntry *target = lfirst_node(TargetEntry, cell);

    if (!target->resjunk && target->resno > 0)
    {
      append_direct_parameter_targets(out, scope, (const Node *) target->expr,
                                      target_relid, target->resno, source, first, seen, 12);
    }
  }
}

static void
append_dml_parameter_targets(StringInfo out, const Query *query)
{
  const RangeTblEntry *target_rte = NULL;
  Oid target_relid = InvalidOid;
  bool first = true;
  List *seen = NIL;
  QueryScope scope = {query, NULL};

  appendStringInfoString(out, ",\"dmlParameterTargets\":[");

  if (query->resultRelation > 0 && query->resultRelation <= list_length(query->rtable))
  {
    target_rte = rt_fetch(query->resultRelation, query->rtable);
    target_relid = target_rte->relid;
  }

  if (OidIsValid(target_relid) &&
      (query->commandType == CMD_INSERT || query->commandType == CMD_UPDATE))
  {
    append_targets_from_list(out, &scope, query->targetList, target_relid,
                             command_type_name(query->commandType), &first, &seen);
  }

  if (OidIsValid(target_relid) && query->onConflict != NULL &&
      query->onConflict->action == ONCONFLICT_UPDATE)
  {
    append_targets_from_list(out, &scope, query->onConflict->onConflictSet,
                             target_relid, "ON_CONFLICT_UPDATE", &first, &seen);
  }

  if (OidIsValid(target_relid) && query->commandType == CMD_MERGE)
  {
    ListCell *cell;

    foreach(cell, query->mergeActionList)
    {
      const MergeAction *action = lfirst_node(MergeAction, cell);

      if (action->commandType == CMD_INSERT)
      {
        append_targets_from_list(out, &scope, action->targetList,
                                 target_relid, "MERGE_INSERT", &first, &seen);
      }
      else if (action->commandType == CMD_UPDATE)
      {
        append_targets_from_list(out, &scope, action->targetList,
                                 target_relid, "MERGE_UPDATE", &first, &seen);
      }
    }
  }

  appendStringInfoChar(out, ']');
}

static const char *
command_type_name(CmdType command_type)
{
  switch (command_type)
  {
    case CMD_UNKNOWN:
      return "UNKNOWN";
    case CMD_SELECT:
      return "SELECT";
    case CMD_UPDATE:
      return "UPDATE";
    case CMD_INSERT:
      return "INSERT";
    case CMD_DELETE:
      return "DELETE";
    case CMD_MERGE:
      return "MERGE";
    case CMD_UTILITY:
      return "UTILITY";
    case CMD_NOTHING:
      return "NOTHING";
  }

  return "UNRECOGNIZED";
}

static const char *
rte_join_type_name(JoinType join_type)
{
  switch (join_type)
  {
    case JOIN_INNER:
      return "INNER";
    case JOIN_LEFT:
      return "LEFT";
    case JOIN_FULL:
      return "FULL";
    case JOIN_RIGHT:
      return "RIGHT";
    case JOIN_SEMI:
      return "SEMI";
    case JOIN_ANTI:
      return "ANTI";
    case JOIN_RIGHT_SEMI:
      return "RIGHT_SEMI";
    case JOIN_RIGHT_ANTI:
      return "RIGHT_ANTI";
    case JOIN_UNIQUE_OUTER:
      return "UNIQUE_OUTER";
    case JOIN_UNIQUE_INNER:
      return "UNIQUE_INNER";
  }

  return "UNRECOGNIZED";
}

static const char *
rte_kind_name(RTEKind rte_kind)
{
  switch (rte_kind)
  {
    case RTE_RELATION:
      return "RELATION";
    case RTE_SUBQUERY:
      return "SUBQUERY";
    case RTE_JOIN:
      return "JOIN";
    case RTE_FUNCTION:
      return "FUNCTION";
    case RTE_TABLEFUNC:
      return "TABLEFUNC";
    case RTE_VALUES:
      return "VALUES";
    case RTE_CTE:
      return "CTE";
    case RTE_NAMEDTUPLESTORE:
      return "NAMEDTUPLESTORE";
    case RTE_RESULT:
      return "RESULT";
    case RTE_GROUP:
      return "GROUP";
  }

  return "UNRECOGNIZED";
}

static const char *
expr_tag_name(const Node *node)
{
  if (node == NULL)
  {
    return "NULL";
  }

  switch (nodeTag(node))
  {
    case T_Var:
      return "Var";
    case T_Const:
      return "Const";
    case T_Param:
      return "Param";
    case T_BoolExpr:
      return "BoolExpr";
    case T_FuncExpr:
      return "FuncExpr";
    case T_OpExpr:
      return "OpExpr";
    case T_Aggref:
      return "Aggref";
    case T_NullTest:
      return "NullTest";
    case T_BooleanTest:
      return "BooleanTest";
    case T_CoalesceExpr:
      return "CoalesceExpr";
    case T_CaseExpr:
      return "CaseExpr";
    case T_CaseWhen:
      return "CaseWhen";
    case T_CaseTestExpr:
      return "CaseTestExpr";
    case T_ArrayExpr:
      return "ArrayExpr";
    case T_RelabelType:
      return "RelabelType";
    case T_CoerceViaIO:
      return "CoerceViaIO";
    case T_CoerceToDomain:
      return "CoerceToDomain";
    case T_SQLValueFunction:
      return "SQLValueFunction";
    case T_ScalarArrayOpExpr:
      return "ScalarArrayOpExpr";
    case T_SubLink:
      return "SubLink";
    case T_FromExpr:
      return "FromExpr";
    case T_JoinExpr:
      return "JoinExpr";
    case T_RangeTblRef:
      return "RangeTblRef";
    default:
      return "Other";
  }
}

static const char *
bool_expr_type_name(BoolExprType boolop)
{
  switch (boolop)
  {
    case AND_EXPR:
      return "AND";
    case OR_EXPR:
      return "OR";
    case NOT_EXPR:
      return "NOT";
  }

  return "UNRECOGNIZED";
}

static const char *
null_test_type_name(NullTestType nulltesttype)
{
  switch (nulltesttype)
  {
    case IS_NULL:
      return "IS_NULL";
    case IS_NOT_NULL:
      return "IS_NOT_NULL";
  }

  return "UNRECOGNIZED";
}

static const char *
bool_test_type_name(BoolTestType booltesttype)
{
  switch (booltesttype)
  {
    case IS_TRUE:
      return "IS_TRUE";
    case IS_NOT_TRUE:
      return "IS_NOT_TRUE";
    case IS_FALSE:
      return "IS_FALSE";
    case IS_NOT_FALSE:
      return "IS_NOT_FALSE";
    case IS_UNKNOWN:
      return "IS_UNKNOWN";
    case IS_NOT_UNKNOWN:
      return "IS_NOT_UNKNOWN";
  }

  return "UNRECOGNIZED";
}

static const char *
param_kind_name(ParamKind paramkind)
{
  switch (paramkind)
  {
    case PARAM_EXTERN:
      return "EXTERN";
    case PARAM_EXEC:
      return "EXEC";
    case PARAM_SUBLINK:
      return "SUBLINK";
    case PARAM_MULTIEXPR:
      return "MULTIEXPR";
  }

  return "UNRECOGNIZED";
}

static const char *
sublink_type_name(SubLinkType sublink_type)
{
  switch (sublink_type)
  {
    case EXISTS_SUBLINK:
      return "EXISTS";
    case ALL_SUBLINK:
      return "ALL";
    case ANY_SUBLINK:
      return "ANY";
    case ROWCOMPARE_SUBLINK:
      return "ROWCOMPARE";
    case EXPR_SUBLINK:
      return "EXPR";
    case MULTIEXPR_SUBLINK:
      return "MULTIEXPR";
    case ARRAY_SUBLINK:
      return "ARRAY";
    case CTE_SUBLINK:
      return "CTE";
  }

  return "UNRECOGNIZED";
}

static void
append_json_string(StringInfo out, const char *value)
{
  const unsigned char *cursor;

  if (value == NULL)
  {
    appendStringInfoString(out, "null");
    return;
  }

  appendStringInfoChar(out, '"');
  for (cursor = (const unsigned char *) value; *cursor != '\0'; cursor++)
  {
    switch (*cursor)
    {
      case '"':
        appendStringInfoString(out, "\\\"");
        break;
      case '\\':
        appendStringInfoString(out, "\\\\");
        break;
      case '\b':
        appendStringInfoString(out, "\\b");
        break;
      case '\f':
        appendStringInfoString(out, "\\f");
        break;
      case '\n':
        appendStringInfoString(out, "\\n");
        break;
      case '\r':
        appendStringInfoString(out, "\\r");
        break;
      case '\t':
        appendStringInfoString(out, "\\t");
        break;
      default:
        if (*cursor < 0x20)
        {
          appendStringInfo(out, "\\u%04x", *cursor);
        }
        else
        {
          appendStringInfoChar(out, (char) *cursor);
        }
    }
  }
  appendStringInfoChar(out, '"');
}

static void
append_oid_field(StringInfo out, const char *name, Oid oid)
{
  if (!OidIsValid(oid))
  {
    appendStringInfo(out, ",\"%s\":null", name);
    return;
  }

  appendStringInfo(out, ",\"%s\":%u", name, oid);
}

static void
append_bool_field(StringInfo out, const char *name, bool value)
{
  appendStringInfo(out, ",\"%s\":%s", name, value ? "true" : "false");
}

static void
append_list_count_field(StringInfo out, const char *name, const List *list)
{
  appendStringInfo(out, ",\"%s\":%d", name, list_length(list));
}

static void
append_optional_name_field(StringInfo out, const char *name, const char *value)
{
  appendStringInfo(out, ",\"%s\":", name);
  append_json_string(out, value);
}

static void
append_bitmapset_field(StringInfo out, const char *name, const Bitmapset *set)
{
  int member = -1;
  bool first = true;

  appendStringInfo(out, ",\"%s\":[", name);
  while ((member = bms_next_member(set, member)) >= 0)
  {
    if (!first)
    {
      appendStringInfoChar(out, ',');
    }
    first = false;
    appendStringInfo(out, "%d", member);
  }
  appendStringInfoChar(out, ']');
}

static void
append_oid_list_field(StringInfo out, const char *name, const List *oids)
{
  bool first = true;

  appendStringInfo(out, ",\"%s\":[", name);
  foreach_oid(oid, oids)
  {
    if (!first)
    {
      appendStringInfoChar(out, ',');
    }
    first = false;
    appendStringInfo(out, "%u", oid);
  }
  appendStringInfoChar(out, ']');
}

static void
append_string_list_field(StringInfo out, const char *name, const List *strings)
{
  ListCell *cell;
  bool first = true;

  appendStringInfo(out, ",\"%s\":[", name);
  foreach(cell, strings)
  {
    const Node *node = (const Node *) lfirst(cell);

    if (!first)
    {
      appendStringInfoChar(out, ',');
    }
    first = false;

    if (node != NULL && IsA(node, String))
    {
      append_json_string(out, strVal(node));
    }
    else
    {
      append_json_string(out, NULL);
    }
  }
  appendStringInfoChar(out, ']');
}

static bool
node_has_expr_type(const Node *node)
{
  if (node == NULL)
  {
    return false;
  }

  switch (nodeTag(node))
  {
    case T_Var:
    case T_Const:
    case T_Param:
    case T_FuncExpr:
    case T_OpExpr:
    case T_Aggref:
    case T_NullTest:
    case T_BooleanTest:
    case T_CoalesceExpr:
    case T_CaseExpr:
    case T_CaseTestExpr:
    case T_ArrayExpr:
    case T_RelabelType:
    case T_CoerceViaIO:
    case T_CoerceToDomain:
    case T_SQLValueFunction:
    case T_ScalarArrayOpExpr:
    case T_SubLink:
    case T_BoolExpr:
      return true;
    default:
      return false;
  }
}

static void
append_expr_type_fields(StringInfo out, const Node *expr)
{
  Oid type_oid;
  int32 typmod;
  Oid collation_oid;
  char *type_name;

  if (!node_has_expr_type(expr))
  {
    return;
  }

  type_oid = exprType(expr);
  typmod = exprTypmod(expr);
  collation_oid = exprCollation(expr);
  type_name = OidIsValid(type_oid) ? format_type_extended(type_oid, typmod, FORMAT_TYPE_TYPEMOD_GIVEN) : NULL;

  append_oid_field(out, "typeOid", type_oid);
  append_optional_name_field(out, "typeName", type_name);
  appendStringInfo(out, ",\"typmod\":%d", typmod);
  append_oid_field(out, "collationOid", collation_oid);
}

static void
append_expr_list(StringInfo out, const Query *query, const char *name, const List *exprs, int depth)
{
  ListCell *cell;
  bool first = true;

  appendStringInfo(out, ",\"%s\":[", name);
  foreach(cell, exprs)
  {
    if (!first)
    {
      appendStringInfoChar(out, ',');
    }
    first = false;
    append_expr_node(out, query, (const Node *) lfirst(cell), depth - 1);
  }
  appendStringInfoChar(out, ']');
}

static void
append_target_expr_list(StringInfo out, const Query *query, const char *name, const List *targets, int depth)
{
  ListCell *cell;
  bool first = true;

  appendStringInfo(out, ",\"%s\":[", name);
  foreach(cell, targets)
  {
    const TargetEntry *target = lfirst_node(TargetEntry, cell);

    if (!first)
    {
      appendStringInfoChar(out, ',');
    }
    first = false;
    appendStringInfo(out, "{\"resno\":%d,\"resjunk\":%s,\"expr\":", target->resno, target->resjunk ? "true" : "false");
    append_expr_node(out, query, (const Node *) target->expr, depth - 1);
    appendStringInfoChar(out, '}');
  }
  appendStringInfoChar(out, ']');
}

static void
append_expr_specific_fields(StringInfo out, const Query *query, const Node *expr)
{
  if (expr == NULL)
  {
    return;
  }

  switch (nodeTag(expr))
  {
    case T_Var:
    {
      const Var *var = (const Var *) expr;
      appendStringInfo(out, ",\"varno\":%u,\"varattno\":%d,\"varlevelsup\":%u",
                       var->varno, var->varattno, var->varlevelsup);
      append_bitmapset_field(out, "varnullingrels", var->varnullingrels);

      if (var->varno > 0 && var->varno <= list_length(query->rtable))
      {
        const RangeTblEntry *rte = rt_fetch(var->varno, query->rtable);
        appendStringInfoString(out, ",\"rteKind\":");
        append_json_string(out, rte_kind_name(rte->rtekind));
        append_oid_field(out, "relid", rte->relid);
        append_optional_name_field(out, "relname", OidIsValid(rte->relid) ? get_rel_name(rte->relid) : NULL);
        if (OidIsValid(rte->relid) && var->varattno > 0)
        {
          append_optional_name_field(out, "attname", get_attname(rte->relid, var->varattno, true));
        }
      }
      break;
    }
    case T_Const:
    {
      const Const *constant = (const Const *) expr;
      append_bool_field(out, "constIsNull", constant->constisnull);
      if (!constant->constisnull)
      {
        if (constant->consttype == INT2OID)
        {
          appendStringInfo(out, ",\"constInteger\":\"%d\"", DatumGetInt16(constant->constvalue));
        }
        else if (constant->consttype == INT4OID)
        {
          appendStringInfo(out, ",\"constInteger\":\"%d\"", DatumGetInt32(constant->constvalue));
        }
        else if (constant->consttype == INT8OID)
        {
          appendStringInfo(out, ",\"constInteger\":\"%lld\"", (long long) DatumGetInt64(constant->constvalue));
        }

        if (constant->consttype == TEXTOID || constant->consttype == VARCHAROID || constant->consttype == BPCHAROID)
        {
          appendStringInfoString(out, ",\"constString\":");
          append_json_string(out, TextDatumGetCString(constant->constvalue));
        }
        else if (constant->consttype == UNKNOWNOID || constant->consttype == CSTRINGOID)
        {
          appendStringInfoString(out, ",\"constString\":");
          append_json_string(out, DatumGetCString(constant->constvalue));
        }
      }
      break;
    }
    case T_FuncExpr:
    {
      const FuncExpr *func = (const FuncExpr *) expr;
      append_oid_field(out, "funcid", func->funcid);
      append_optional_name_field(out, "funcname", OidIsValid(func->funcid) ? get_func_name(func->funcid) : NULL);
      append_bool_field(out, "returnsSet", func->funcretset);
      break;
    }
    case T_OpExpr:
    {
      const OpExpr *op = (const OpExpr *) expr;
      append_oid_field(out, "opno", op->opno);
      append_optional_name_field(out, "opname", OidIsValid(op->opno) ? get_opname(op->opno) : NULL);
      append_oid_field(out, "opfuncid", op->opfuncid);
      append_optional_name_field(out, "opfuncname", OidIsValid(op->opfuncid) ? get_func_name(op->opfuncid) : NULL);
      append_bool_field(out, "returnsSet", op->opretset);
      break;
    }
    case T_Aggref:
    {
      const Aggref *agg = (const Aggref *) expr;
      append_oid_field(out, "aggfnoid", agg->aggfnoid);
      append_optional_name_field(out, "aggname", OidIsValid(agg->aggfnoid) ? get_func_name(agg->aggfnoid) : NULL);
      break;
    }
    default:
      break;
  }
}

static void
append_expr_node(StringInfo out, const Query *query, const Node *expr, int depth)
{
  if (expr == NULL)
  {
    appendStringInfoString(out, "null");
    return;
  }

  appendStringInfoString(out, "{\"tag\":");
  append_json_string(out, expr_tag_name(expr));
  appendStringInfo(out, ",\"nodeTag\":%d", (int) nodeTag(expr));

  if (depth <= 0)
  {
    append_bool_field(out, "truncated", true);
    appendStringInfoChar(out, '}');
    return;
  }

  append_expr_type_fields(out, expr);
  append_expr_specific_fields(out, query, expr);

  switch (nodeTag(expr))
  {
    case T_Param:
    {
      const Param *param = (const Param *) expr;
      appendStringInfoString(out, ",\"paramKind\":");
      append_json_string(out, param_kind_name(param->paramkind));
      appendStringInfo(out, ",\"paramId\":%d", param->paramid);
      append_oid_field(out, "paramTypeOid", param->paramtype);
      append_optional_name_field(out, "paramTypeName", OidIsValid(param->paramtype) ? format_type_extended(param->paramtype, param->paramtypmod, FORMAT_TYPE_TYPEMOD_GIVEN) : NULL);
      appendStringInfo(out, ",\"paramTypmod\":%d", param->paramtypmod);
      append_oid_field(out, "paramCollationOid", param->paramcollid);
      break;
    }
    case T_FuncExpr:
    {
      const FuncExpr *func = (const FuncExpr *) expr;
      append_expr_list(out, query, "args", func->args, depth);
      break;
    }
    case T_OpExpr:
    {
      const OpExpr *op = (const OpExpr *) expr;
      append_expr_list(out, query, "args", op->args, depth);
      break;
    }
    case T_ScalarArrayOpExpr:
    {
      const ScalarArrayOpExpr *op = (const ScalarArrayOpExpr *) expr;
      append_oid_field(out, "opno", op->opno);
      append_optional_name_field(out, "opname", OidIsValid(op->opno) ? get_opname(op->opno) : NULL);
      append_oid_field(out, "opfuncid", op->opfuncid);
      append_optional_name_field(out, "opfuncname", OidIsValid(op->opfuncid) ? get_func_name(op->opfuncid) : NULL);
      append_bool_field(out, "useOr", op->useOr);
      append_expr_list(out, query, "args", op->args, depth);
      break;
    }
    case T_BoolExpr:
    {
      const BoolExpr *bool_expr = (const BoolExpr *) expr;
      appendStringInfoString(out, ",\"boolOp\":");
      append_json_string(out, bool_expr_type_name(bool_expr->boolop));
      append_expr_list(out, query, "args", bool_expr->args, depth);
      break;
    }
    case T_Aggref:
    {
      const Aggref *agg = (const Aggref *) expr;
      append_target_expr_list(out, query, "args", agg->args, depth);
      break;
    }
    case T_CoalesceExpr:
    {
      const CoalesceExpr *coalesce = (const CoalesceExpr *) expr;
      append_expr_list(out, query, "args", coalesce->args, depth);
      break;
    }
    case T_NullTest:
    {
      const NullTest *null_test = (const NullTest *) expr;
      appendStringInfoString(out, ",\"nullTestType\":");
      append_json_string(out, null_test_type_name(null_test->nulltesttype));
      append_bool_field(out, "argIsRow", null_test->argisrow);
      appendStringInfoString(out, ",\"arg\":");
      append_expr_node(out, query, (const Node *) null_test->arg, depth - 1);
      break;
    }
    case T_BooleanTest:
    {
      const BooleanTest *boolean_test = (const BooleanTest *) expr;
      appendStringInfoString(out, ",\"boolTestType\":");
      append_json_string(out, bool_test_type_name(boolean_test->booltesttype));
      appendStringInfoString(out, ",\"arg\":");
      append_expr_node(out, query, (const Node *) boolean_test->arg, depth - 1);
      break;
    }
    case T_RelabelType:
    {
      const RelabelType *relabel = (const RelabelType *) expr;
      appendStringInfoString(out, ",\"arg\":");
      append_expr_node(out, query, (const Node *) relabel->arg, depth - 1);
      break;
    }
    case T_CoerceViaIO:
    {
      const CoerceViaIO *coerce = (const CoerceViaIO *) expr;
      appendStringInfoString(out, ",\"arg\":");
      append_expr_node(out, query, (const Node *) coerce->arg, depth - 1);
      break;
    }
    case T_CoerceToDomain:
    {
      const CoerceToDomain *coerce = (const CoerceToDomain *) expr;
      appendStringInfoString(out, ",\"arg\":");
      append_expr_node(out, query, (const Node *) coerce->arg, depth - 1);
      break;
    }
    case T_CaseExpr:
    {
      const CaseExpr *case_expr = (const CaseExpr *) expr;
      appendStringInfoString(out, ",\"arg\":");
      append_expr_node(out, query, (const Node *) case_expr->arg, depth - 1);
      append_expr_list(out, query, "whenClauses", case_expr->args, depth);
      appendStringInfoString(out, ",\"defresult\":");
      append_expr_node(out, query, (const Node *) case_expr->defresult, depth - 1);
      break;
    }
    case T_CaseWhen:
    {
      const CaseWhen *case_when = (const CaseWhen *) expr;
      appendStringInfoString(out, ",\"condition\":");
      append_expr_node(out, query, (const Node *) case_when->expr, depth - 1);
      appendStringInfoString(out, ",\"result\":");
      append_expr_node(out, query, (const Node *) case_when->result, depth - 1);
      break;
    }
    case T_ArrayExpr:
    {
      const ArrayExpr *array_expr = (const ArrayExpr *) expr;
      append_oid_field(out, "elementTypeOid", array_expr->element_typeid);
      append_optional_name_field(out, "elementTypeName", OidIsValid(array_expr->element_typeid) ? format_type_extended(array_expr->element_typeid, -1, FORMAT_TYPE_TYPEMOD_GIVEN) : NULL);
      append_bool_field(out, "multidims", array_expr->multidims);
      append_expr_list(out, query, "elements", array_expr->elements, depth);
      break;
    }
    case T_SubLink:
    {
      const SubLink *sublink = (const SubLink *) expr;
      appendStringInfoString(out, ",\"subLinkType\":");
      append_json_string(out, sublink_type_name(sublink->subLinkType));
      appendStringInfo(out, ",\"subLinkId\":%d", sublink->subLinkId);
      appendStringInfoString(out, ",\"testExpr\":");
      append_expr_node(out, query, sublink->testexpr, depth - 1);
      if (sublink->subselect != NULL && IsA(sublink->subselect, Query))
      {
        appendStringInfoString(out, ",\"subquery\":");
        append_query_summary(out, (const Query *) sublink->subselect, depth - 1);
      }
      else
      {
        appendStringInfoString(out, ",\"subquery\":null");
      }
      break;
    }
    default:
      break;
  }

  appendStringInfoChar(out, '}');
}

static void
append_cte_list(StringInfo out, const Query *query, int depth)
{
  ListCell *cell;
  bool first = true;

  appendStringInfoString(out, ",\"cteList\":[");
  foreach(cell, query->cteList)
  {
    const CommonTableExpr *cte = lfirst_node(CommonTableExpr, cell);

    if (!first)
    {
      appendStringInfoChar(out, ',');
    }
    first = false;

    appendStringInfoString(out, "{\"name\":");
    append_json_string(out, cte->ctename);
    append_bool_field(out, "recursive", cte->cterecursive);
    appendStringInfo(out, ",\"refCount\":%d", cte->cterefcount);
    append_string_list_field(out, "columnNames", cte->ctecolnames);
    append_oid_list_field(out, "columnTypeOids", cte->ctecoltypes);
    if (cte->ctequery != NULL && IsA(cte->ctequery, Query))
    {
      Query *cte_query = (Query *) cte->ctequery;
      appendStringInfoString(out, ",\"commandType\":");
      append_json_string(out, command_type_name(cte_query->commandType));
      appendStringInfoString(out, ",\"query\":");
      append_query_summary(out, cte_query, depth - 1);
    }
    appendStringInfoChar(out, '}');
  }
  appendStringInfoChar(out, ']');
}

static void
append_target_list(StringInfo out, const Query *query)
{
  ListCell *cell;
  bool first = true;

  appendStringInfoString(out, "\"targetList\":[");
  foreach(cell, query->targetList)
  {
    const TargetEntry *target = lfirst_node(TargetEntry, cell);
    const Node *expr = (const Node *) target->expr;
    Oid type_oid = exprType(expr);
    int32 typmod = exprTypmod(expr);
    Oid collation_oid = exprCollation(expr);
    char *type_name = OidIsValid(type_oid) ? format_type_extended(type_oid, typmod, FORMAT_TYPE_TYPEMOD_GIVEN) : NULL;

    if (!first)
    {
      appendStringInfoChar(out, ',');
    }
    first = false;

    appendStringInfo(out, "{\"resno\":%d,\"resjunk\":%s,\"resname\":",
                     target->resno, target->resjunk ? "true" : "false");
    append_json_string(out, target->resname);
    appendStringInfoString(out, ",\"exprTag\":");
    append_json_string(out, expr_tag_name(expr));
    appendStringInfo(out, ",\"nodeTag\":%d", expr == NULL ? 0 : (int) nodeTag(expr));
    append_oid_field(out, "typeOid", type_oid);
    append_optional_name_field(out, "typeName", type_name);
    appendStringInfo(out, ",\"typmod\":%d", typmod);
    append_oid_field(out, "collationOid", collation_oid);
    append_expr_specific_fields(out, query, expr);
    appendStringInfoString(out, ",\"expr\":");
    append_expr_node(out, query, expr, 8);
    appendStringInfoChar(out, '}');
  }
  appendStringInfoChar(out, ']');
}

static void
append_returning_list(StringInfo out, const Query *query)
{
  ListCell *cell;
  bool first = true;

  appendStringInfoString(out, ",\"returningList\":[");
  foreach(cell, query->returningList)
  {
    const TargetEntry *target = lfirst_node(TargetEntry, cell);
    const Node *expr = (const Node *) target->expr;

    if (!first)
    {
      appendStringInfoChar(out, ',');
    }
    first = false;

    appendStringInfo(out, "{\"resno\":%d,\"resjunk\":%s,\"resname\":",
                     target->resno, target->resjunk ? "true" : "false");
    append_json_string(out, target->resname);
    appendStringInfoString(out, ",\"expr\":");
    append_expr_node(out, query, expr, 8);
    appendStringInfoChar(out, '}');
  }
  appendStringInfoChar(out, ']');
}

static void
append_rtable(StringInfo out, const Query *query, int depth)
{
  ListCell *cell;
  bool first = true;
  int index = 1;

  appendStringInfoString(out, ",\"rtable\":[");
  foreach(cell, query->rtable)
  {
    const RangeTblEntry *rte = lfirst_node(RangeTblEntry, cell);

    if (!first)
    {
      appendStringInfoChar(out, ',');
    }
    first = false;

    appendStringInfo(out, "{\"index\":%d,\"kind\":", index);
    append_json_string(out, rte_kind_name(rte->rtekind));
    if (rte->eref != NULL)
    {
      append_optional_name_field(out, "erefAlias", rte->eref->aliasname);
      append_string_list_field(out, "erefColumnNames", rte->eref->colnames);
    }
    if (rte->rtekind == RTE_JOIN)
    {
      appendStringInfoString(out, ",\"joinType\":");
      append_json_string(out, rte_join_type_name(rte->jointype));
      appendStringInfo(out, ",\"joinMergedCols\":%d", rte->joinmergedcols);
    }
    if (rte->rtekind == RTE_CTE)
    {
      append_optional_name_field(out, "cteName", rte->ctename);
      appendStringInfo(out, ",\"cteLevelSup\":%u", rte->ctelevelsup);
      append_oid_list_field(out, "cteColumnTypeOids", rte->coltypes);
    }
    append_oid_field(out, "relid", rte->relid);
    append_optional_name_field(out, "relname", OidIsValid(rte->relid) ? get_rel_name(rte->relid) : NULL);
    if (rte->rtekind == RTE_SUBQUERY && rte->subquery != NULL && depth > 0)
    {
      appendStringInfoString(out, ",\"subquery\":");
      append_query_summary(out, rte->subquery, depth - 1);
    }
    appendStringInfoChar(out, '}');
    index++;
  }
  appendStringInfoChar(out, ']');
}

static void
append_from_list(StringInfo out, const Query *query, const char *name, const List *nodes, int depth)
{
  ListCell *cell;
  bool first = true;

  appendStringInfo(out, ",\"%s\":[", name);
  foreach(cell, nodes)
  {
    if (!first)
    {
      appendStringInfoChar(out, ',');
    }
    first = false;
    append_from_node(out, query, (const Node *) lfirst(cell), depth - 1);
  }
  appendStringInfoChar(out, ']');
}

static void
append_from_node(StringInfo out, const Query *query, const Node *node, int depth)
{
  if (node == NULL)
  {
    appendStringInfoString(out, "null");
    return;
  }

  appendStringInfoString(out, "{\"tag\":");
  append_json_string(out, expr_tag_name(node));
  appendStringInfo(out, ",\"nodeTag\":%d", (int) nodeTag(node));

  if (depth <= 0)
  {
    append_bool_field(out, "truncated", true);
    appendStringInfoChar(out, '}');
    return;
  }

  switch (nodeTag(node))
  {
    case T_RangeTblRef:
    {
      const RangeTblRef *ref = (const RangeTblRef *) node;
      appendStringInfo(out, ",\"rtindex\":%d", ref->rtindex);
      if (ref->rtindex > 0 && ref->rtindex <= list_length(query->rtable))
      {
        const RangeTblEntry *rte = rt_fetch(ref->rtindex, query->rtable);
        appendStringInfoString(out, ",\"rteKind\":");
        append_json_string(out, rte_kind_name(rte->rtekind));
        append_oid_field(out, "relid", rte->relid);
        append_optional_name_field(out, "relname", OidIsValid(rte->relid) ? get_rel_name(rte->relid) : NULL);
      }
      break;
    }
    case T_JoinExpr:
    {
      const JoinExpr *join = (const JoinExpr *) node;
      appendStringInfoString(out, ",\"joinType\":");
      append_json_string(out, rte_join_type_name(join->jointype));
      append_bool_field(out, "isNatural", join->isNatural);
      appendStringInfo(out, ",\"rtindex\":%d", join->rtindex);
      appendStringInfoString(out, ",\"left\":");
      append_from_node(out, query, join->larg, depth - 1);
      appendStringInfoString(out, ",\"right\":");
      append_from_node(out, query, join->rarg, depth - 1);
      appendStringInfoString(out, ",\"quals\":");
      append_expr_node(out, query, join->quals, depth - 1);
      break;
    }
    case T_FromExpr:
    {
      const FromExpr *from = (const FromExpr *) node;
      append_from_list(out, query, "fromlist", from->fromlist, depth);
      appendStringInfoString(out, ",\"quals\":");
      append_expr_node(out, query, from->quals, depth - 1);
      break;
    }
    default:
      appendStringInfoString(out, ",\"unsupported\":true");
      break;
  }

  appendStringInfoChar(out, '}');
}

static void
append_query_summary(StringInfo out, const Query *query, int depth)
{
  appendStringInfoString(out, "{\"commandType\":");
  append_json_string(out, command_type_name(query->commandType));
  appendStringInfo(out, ",\"querySource\":%d,\"canSetTag\":%s",
                   query->querySource, query->canSetTag ? "true" : "false");
  appendStringInfo(out, ",\"resultRelation\":%d", query->resultRelation);
  append_bool_field(out, "hasAggs", query->hasAggs);
  append_bool_field(out, "hasWindowFuncs", query->hasWindowFuncs);
  append_bool_field(out, "hasTargetSRFs", query->hasTargetSRFs);
  append_bool_field(out, "hasSubLinks", query->hasSubLinks);
  append_bool_field(out, "hasModifyingCTE", query->hasModifyingCTE);
  append_bool_field(out, "hasRowSecurity", query->hasRowSecurity);
  append_list_count_field(out, "groupClauseCount", query->groupClause);
  append_list_count_field(out, "groupingSetsCount", query->groupingSets);
  append_list_count_field(out, "distinctClauseCount", query->distinctClause);
  append_bool_field(out, "hasHavingQual", query->havingQual != NULL);
  append_bool_field(out, "hasLimitOffset", query->limitOffset != NULL);
  append_bool_field(out, "hasLimitCount", query->limitCount != NULL);
  append_bool_field(out, "hasSetOperations", query->setOperations != NULL);
  appendStringInfoString(out, ",\"limitCount\":");
  append_expr_node(out, query, query->limitCount, depth);
  appendStringInfoChar(out, ',');
  append_target_list(out, query);
  append_returning_list(out, query);
  append_dml_parameter_targets(out, query);
  append_cte_list(out, query, depth);
  append_rtable(out, query, depth);
  appendStringInfoString(out, ",\"fromTree\":");
  append_from_node(out, query, (const Node *) query->jointree, depth);
  appendStringInfoString(out, ",\"whereQual\":");
  if (query->jointree == NULL)
  {
    appendStringInfoString(out, "null");
  }
  else
  {
    append_expr_node(out, query, query->jointree->quals, depth);
  }
  appendStringInfoChar(out, '}');
}

static Oid *
read_param_type_oids(ArrayType *array, int *count)
{
  Datum *values;
  bool *nulls;
  int value_count;
  Oid *oids;

  deconstruct_array_builtin(array, OIDOID, &values, &nulls, &value_count);
  oids = palloc0(sizeof(Oid) * value_count);
  for (int index = 0; index < value_count; index++)
  {
    if (nulls[index])
    {
      ereport(ERROR, (errmsg("param_type_oids must not contain nulls")));
    }
    oids[index] = DatumGetObjectId(values[index]);
  }

  *count = value_count;
  return oids;
}

static bool
param_types_need_inference(const Oid *param_types, int param_count)
{
  for (int index = 0; index < param_count; index++)
  {
    if (!OidIsValid(param_types[index]))
    {
      return true;
    }
  }

  return false;
}

Datum
postgres_typed_sql_analyze(PG_FUNCTION_ARGS)
{
  text *sql_text = PG_GETARG_TEXT_PP(0);
  ArrayType *param_type_array = PG_GETARG_ARRAYTYPE_P(1);
  char *sql = text_to_cstring(sql_text);
  int param_count = 0;
  Oid *param_types = read_param_type_oids(param_type_array, &param_count);
  List *raw_trees = pg_parse_query(sql);
  StringInfoData out;
  ListCell *raw_cell;
  bool first_raw = true;

  initStringInfo(&out);
  appendStringInfoString(&out, "{\"schemaVersion\":3,\"postgresVersionNum\":");
  appendStringInfo(&out, "%d", PG_VERSION_NUM);
  appendStringInfoString(&out, ",\"rawStatementCount\":");
  appendStringInfo(&out, "%d", list_length(raw_trees));
  appendStringInfoString(&out, ",\"statements\":[");

  foreach(raw_cell, raw_trees)
  {
    RawStmt *raw_stmt = lfirst_node(RawStmt, raw_cell);
    List *rewritten_queries = param_count == 0 || param_types_need_inference(param_types, param_count)
                                ? pg_analyze_and_rewrite_varparams(raw_stmt, sql, &param_types, &param_count, NULL)
                                : pg_analyze_and_rewrite_fixedparams(raw_stmt, sql, param_types, param_count, NULL);
    ListCell *query_cell;
    bool first_query = true;

    if (!first_raw)
    {
      appendStringInfoChar(&out, ',');
    }
    first_raw = false;

    appendStringInfoString(&out, "{\"rewrittenQueryCount\":");
    appendStringInfo(&out, "%d", list_length(rewritten_queries));
    appendStringInfoString(&out, ",\"queries\":[");

    foreach(query_cell, rewritten_queries)
    {
      Query *query = lfirst_node(Query, query_cell);

      if (!first_query)
      {
        appendStringInfoChar(&out, ',');
      }
      first_query = false;

      append_query_summary(&out, query, 10);
    }

    appendStringInfoString(&out, "]}");
  }

  appendStringInfoString(&out, "],\"paramTypeOids\":[");
  for (int index = 0; index < param_count; index++)
  {
    if (index > 0)
    {
      appendStringInfoChar(&out, ',');
    }
    appendStringInfo(&out, "%u", param_types[index]);
  }
  appendStringInfoString(&out, "]}");

  PG_RETURN_TEXT_P(cstring_to_text(out.data));
}
