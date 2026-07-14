#include "postgres.h"

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

PG_MODULE_MAGIC;

PG_FUNCTION_INFO_V1(postgres_typed_sql_analyze);

static void append_expr_node(StringInfo out, const Query *query, const Node *expr, int depth);
static void append_query_summary(StringInfo out, const Query *query, int depth);
static void append_from_node(StringInfo out, const Query *query, const Node *node, int depth);
static void append_rtable(StringInfo out, const Query *query, int depth);

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
  appendStringInfoString(&out, "{\"schemaVersion\":2,\"postgresVersionNum\":");
  appendStringInfo(&out, "%d", PG_VERSION_NUM);
  appendStringInfoString(&out, ",\"rawStatementCount\":");
  appendStringInfo(&out, "%d", list_length(raw_trees));
  appendStringInfoString(&out, ",\"statements\":[");

  foreach(raw_cell, raw_trees)
  {
    RawStmt *raw_stmt = lfirst_node(RawStmt, raw_cell);
    List *rewritten_queries = param_count == 0
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
