#include "postgres.h"

#include "access/hash.h"
#include "access/htup_details.h"
#include "access/nbtree.h"
#include "access/table.h"
#include "access/transam.h"
#include "catalog/pg_aggregate.h"
#include "catalog/pg_amop.h"
#include "catalog/pg_amproc.h"
#include "catalog/pg_attribute.h"
#include "catalog/pg_class.h"
#include "catalog/pg_constraint.h"
#include "catalog/pg_inherits.h"
#include "catalog/pg_language_d.h"
#include "catalog/pg_proc.h"
#include "catalog/pg_trigger.h"
#include "catalog/pg_type.h"
#include "catalog/pg_type_d.h"
#include "commands/trigger.h"
#include "fmgr.h"
#include "nodes/bitmapset.h"
#include "nodes/execnodes.h"
#include "nodes/nodeFuncs.h"
#include "nodes/parsenodes.h"
#include "nodes/primnodes.h"
#include "nodes/value.h"
#include "optimizer/clauses.h"
#include "optimizer/optimizer.h"
#include "parser/parsetree.h"
#include "tcop/tcopprot.h"
#include "tcop/utility.h"
#include "utils/array.h"
#include "utils/builtins.h"
#include "utils/catcache.h"
#include "utils/fmgroids.h"
#include "utils/hsearch.h"
#include "utils/jsonb.h"
#include "utils/jsonfuncs.h"
#include "utils/lsyscache.h"
#include "utils/memutils.h"
#include "utils/multirangetypes.h"
#include "utils/rangetypes.h"
#include "utils/rel.h"
#include "utils/relcache.h"
#include "utils/syscache.h"
#include "utils/typcache.h"

#include "array_shape.h"
#include "dml_analysis.h"
#include "null_admission.h"
#include "null_evaluation.h"
#include "null_substitution.h"
#include "parameter_null_admission.h"
#include "query_scope.h"

PG_MODULE_MAGIC;

PG_FUNCTION_INFO_V1(postgres_typed_sql_analyze);

static void append_expr_node(StringInfo out, const PtsQueryScope *scope, const Node *expr, int depth);
static void append_query_summary(StringInfo out, const Query *query,
                                 const PtsQueryScope *parent_scope, int depth,
                                 bool protocol_output,
                                 bool bind_io_invokes_volatile);
static void append_from_node(StringInfo out, const PtsQueryScope *scope, const Node *node, int depth);
static void append_rtable(StringInfo out, const PtsQueryScope *scope, int depth);
static void append_set_operation(StringInfo out, const Node *node);
static const char *command_type_name(CmdType command_type);
static const char *utility_kind_name(const Node *utility_stmt);
static const char *var_returning_type_name(VarReturningType returning_type);
static bool utility_returns_tuples_stably(const Node *utility_stmt);
static void append_json_string(StringInfo out, const char *value);
static void append_bool_field(StringInfo out, const char *name, bool value);
static void append_oid_field(StringInfo out, const char *name, Oid value);
static void append_optional_name_field(StringInfo out, const char *name, const char *value);
static bool query_contains_volatile_functions(const Query *query);
static bool volatile_function_walker(Node *node, void *context);
static bool query_contains_row_marks(const Query *query);
static bool executor_support_dependency_invokes_volatile(
  Oid function_oid, const List *args, bool target_entries,
  Oid result_type, int32 result_typmod);
static bool
json_text_is_empty_array(const char *value)
{
  const char *cursor = value;

  while (*cursor == ' ' || *cursor == '\t' || *cursor == '\r' || *cursor == '\n')
  {
    cursor++;
  }
  if (*cursor++ != '[')
  {
    return false;
  }
  while (*cursor == ' ' || *cursor == '\t' || *cursor == '\r' || *cursor == '\n')
  {
    cursor++;
  }
  if (*cursor++ != ']')
  {
    return false;
  }
  while (*cursor == ' ' || *cursor == '\t' || *cursor == '\r' || *cursor == '\n')
  {
    cursor++;
  }
  return *cursor == '\0';
}

typedef struct VolatileFunctionContext
{
  const PtsQueryScope *scope;
} VolatileFunctionContext;

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
utility_kind_name(const Node *utility_stmt)
{
  if (utility_stmt == NULL)
  {
    return "NONE";
  }

  switch (nodeTag(utility_stmt))
  {
    case T_CallStmt:
      return "CALL";
    case T_ExplainStmt:
      return "EXPLAIN";
    case T_VariableShowStmt:
      return "SHOW";
    case T_FetchStmt:
      return "FETCH";
    case T_ExecuteStmt:
      return "EXECUTE";
    default:
      return "OTHER";
  }
}

static bool
utility_returns_tuples_stably(const Node *utility_stmt)
{
  if (utility_stmt == NULL)
  {
    return false;
  }

  switch (nodeTag(utility_stmt))
  {
    case T_CallStmt:
    case T_ExplainStmt:
    case T_VariableShowStmt:
      return UtilityReturnsTuples((Node *) utility_stmt);
    case T_FetchStmt:
    case T_ExecuteStmt:
      /*
       * Their descriptors depend on a live portal or prepared statement.
       * Report a possible result so consumers cannot mistake them for
       * stable no-result utilities.
       */
      return true;
    default:
      return false;
  }
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
var_returning_type_name(VarReturningType returning_type)
{
  switch (returning_type)
  {
    case VAR_RETURNING_DEFAULT:
      return "DEFAULT";
    case VAR_RETURNING_OLD:
      return "OLD";
    case VAR_RETURNING_NEW:
      return "NEW";
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
    case T_ArrayCoerceExpr:
      return "ArrayCoerceExpr";
    case T_ConvertRowtypeExpr:
      return "ConvertRowtypeExpr";
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
coercion_form_name(CoercionForm form)
{
  switch (form)
  {
    case COERCE_EXPLICIT_CALL:
      return "EXPLICIT_CALL";
    case COERCE_EXPLICIT_CAST:
      return "EXPLICIT_CAST";
    case COERCE_IMPLICIT_CAST:
      return "IMPLICIT_CAST";
    case COERCE_SQL_SYNTAX:
      return "SQL_SYNTAX";
  }

  return "UNRECOGNIZED";
}

static bool
function_cast_nonnull_for_nonnull_argument(const FuncExpr *function)
{
  Oid source_type;
  Oid expected_source_type;
  Oid expected_result_type;

  if (function->funcretset || list_length(function->args) != 1 ||
      (function->funcformat != COERCE_EXPLICIT_CAST &&
       function->funcformat != COERCE_IMPLICIT_CAST))
  {
    return false;
  }

  /*
   * PostgreSQL's package-owned integer cast implementations return a
   * converted Datum or raise on overflow.  Keep this deliberately narrow
   * and keyed by pg_proc identity plus the parsed source/result types.
   */
  switch (function->funcid)
  {
    case F_INT4_INT2:
      expected_source_type = INT2OID;
      expected_result_type = INT4OID;
      break;
    case F_INT2_INT4:
      expected_source_type = INT4OID;
      expected_result_type = INT2OID;
      break;
    case F_INT4_INT8:
      expected_source_type = INT8OID;
      expected_result_type = INT4OID;
      break;
    case F_INT8_INT4:
      expected_source_type = INT4OID;
      expected_result_type = INT8OID;
      break;
    case F_INT2_INT8:
      expected_source_type = INT8OID;
      expected_result_type = INT2OID;
      break;
    case F_INT8_INT2:
      expected_source_type = INT2OID;
      expected_result_type = INT8OID;
      break;
    default:
      return false;
  }

  source_type = exprType((const Node *) linitial(function->args));
  return source_type == expected_source_type &&
         function->funcresulttype == expected_result_type;
}

static bool
package_owned_type_io_function(Oid function_oid)
{
  /*
   * ExecEvalCoerceViaIO's non-NULL path requires both type I/O calls to
   * return non-NULL.  Trust that executor contract only for PostgreSQL-owned
   * functions; user-defined type I/O implementations remain opaque.
   */
  return OidIsValid(function_oid) && function_oid < FirstNormalObjectId;
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
    case T_ArrayCoerceExpr:
    case T_ConvertRowtypeExpr:
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
append_expr_list(StringInfo out, const PtsQueryScope *scope, const char *name, const List *exprs, int depth)
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
    append_expr_node(out, scope, (const Node *) lfirst(cell), depth - 1);
  }
  appendStringInfoChar(out, ']');
}

static void
append_expr_rows(StringInfo out, const PtsQueryScope *scope, const char *name, const List *rows, int depth)
{
  ListCell *row_cell;
  bool first_row = true;

  appendStringInfo(out, ",\"%s\":[", name);
  foreach(row_cell, rows)
  {
    const List *row = (const List *) lfirst(row_cell);
    ListCell *expr_cell;
    bool first_expr = true;

    if (!first_row)
    {
      appendStringInfoChar(out, ',');
    }
    first_row = false;
    appendStringInfoChar(out, '[');
    foreach(expr_cell, row)
    {
      if (!first_expr)
      {
        appendStringInfoChar(out, ',');
      }
      first_expr = false;
      append_expr_node(out, scope, (const Node *) lfirst(expr_cell), depth - 1);
    }
    appendStringInfoChar(out, ']');
  }
  appendStringInfoChar(out, ']');
}

static void
append_target_expr_list(StringInfo out, const PtsQueryScope *scope, const char *name, const List *targets, int depth)
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
    append_expr_node(out, scope, (const Node *) target->expr, depth - 1);
    appendStringInfoChar(out, '}');
  }
  appendStringInfoChar(out, ']');
}

static void
append_expr_specific_fields(StringInfo out, const PtsQueryScope *scope, const Node *expr)
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
      const PtsQueryScope *owner_scope = pts_query_scope_at_level(scope, var->varlevelsup);
      appendStringInfo(out, ",\"varno\":%u,\"varattno\":%d,\"varlevelsup\":%u",
                       var->varno, var->varattno, var->varlevelsup);
      append_bitmapset_field(out, "varnullingrels", var->varnullingrels);
      appendStringInfoString(out, ",\"varreturningtype\":");
      append_json_string(out, var_returning_type_name(var->varreturningtype));

      if (owner_scope != NULL && var->varno > 0 &&
          var->varno <= list_length(owner_scope->query->rtable))
      {
        const RangeTblEntry *rte = rt_fetch(var->varno, owner_scope->query->rtable);
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
        if (constant->consttype == JSONOID)
        {
          char *json = TextDatumGetCString(constant->constvalue);

          if (json_text_is_empty_array(json))
          {
            append_bool_field(out, "constEmptyJsonArray", true);
          }
          pfree(json);
        }
        else if (constant->consttype == JSONBOID)
        {
          Jsonb *json = DatumGetJsonbP(constant->constvalue);

          if (JB_ROOT_IS_ARRAY(json) && !JB_ROOT_IS_SCALAR(json) &&
              JB_ROOT_COUNT(json) == 0)
          {
            append_bool_field(out, "constEmptyJsonArray", true);
          }
        }
      }
      break;
    }
    case T_FuncExpr:
    {
      const FuncExpr *func = (const FuncExpr *) expr;
      bool is_cast =
        func->funcformat == COERCE_EXPLICIT_CAST ||
        func->funcformat == COERCE_IMPLICIT_CAST;

      append_oid_field(out, "funcid", func->funcid);
      append_optional_name_field(out, "funcname", OidIsValid(func->funcid) ? get_func_name(func->funcid) : NULL);
      append_bool_field(out, "funcVariadic", func->funcvariadic);
      append_bool_field(out, "returnsSet", func->funcretset);
      appendStringInfoString(out, ",\"coercionForm\":");
      append_json_string(out, coercion_form_name(func->funcformat));
      if (is_cast)
      {
        append_bool_field(out, "nullInputProducesNull",
                          list_length(func->args) == 1 &&
                          func_strict(func->funcid));
        append_bool_field(
          out, "nonNullInputProducesNonNull",
          function_cast_nonnull_for_nonnull_argument(func));
      }
      break;
    }
    case T_OpExpr:
    {
      const OpExpr *op = (const OpExpr *) expr;
      append_oid_field(out, "opno", op->opno);
      append_optional_name_field(out, "opname", OidIsValid(op->opno) ? get_opname(op->opno) : NULL);
      append_oid_field(out, "opfuncid", op->opfuncid);
      append_optional_name_field(out, "opfuncname", OidIsValid(op->opfuncid) ? get_func_name(op->opfuncid) : NULL);
      append_oid_field(out, "inputCollationOid", op->inputcollid);
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
append_expr_node(StringInfo out, const PtsQueryScope *scope, const Node *expr, int depth)
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
  append_expr_specific_fields(out, scope, expr);

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
      append_expr_list(out, scope, "args", func->args, depth);
      break;
    }
    case T_OpExpr:
    {
      const OpExpr *op = (const OpExpr *) expr;
      append_expr_list(out, scope, "args", op->args, depth);
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
      append_expr_list(out, scope, "args", op->args, depth);
      break;
    }
    case T_BoolExpr:
    {
      const BoolExpr *bool_expr = (const BoolExpr *) expr;
      appendStringInfoString(out, ",\"boolOp\":");
      append_json_string(out, bool_expr_type_name(bool_expr->boolop));
      append_expr_list(out, scope, "args", bool_expr->args, depth);
      break;
    }
    case T_Aggref:
    {
      const Aggref *agg = (const Aggref *) expr;
      append_target_expr_list(out, scope, "args", agg->args, depth);
      break;
    }
    case T_CoalesceExpr:
    {
      const CoalesceExpr *coalesce = (const CoalesceExpr *) expr;
      append_expr_list(out, scope, "args", coalesce->args, depth);
      break;
    }
    case T_NullTest:
    {
      const NullTest *null_test = (const NullTest *) expr;
      appendStringInfoString(out, ",\"nullTestType\":");
      append_json_string(out, null_test_type_name(null_test->nulltesttype));
      append_bool_field(out, "argIsRow", null_test->argisrow);
      appendStringInfoString(out, ",\"arg\":");
      append_expr_node(out, scope, (const Node *) null_test->arg, depth - 1);
      break;
    }
    case T_BooleanTest:
    {
      const BooleanTest *boolean_test = (const BooleanTest *) expr;
      appendStringInfoString(out, ",\"boolTestType\":");
      append_json_string(out, bool_test_type_name(boolean_test->booltesttype));
      appendStringInfoString(out, ",\"arg\":");
      append_expr_node(out, scope, (const Node *) boolean_test->arg, depth - 1);
      break;
    }
    case T_RelabelType:
    {
      const RelabelType *relabel = (const RelabelType *) expr;
      appendStringInfoString(out, ",\"coercionForm\":");
      append_json_string(out, coercion_form_name(relabel->relabelformat));
      append_bool_field(out, "nullInputProducesNull", true);
      append_bool_field(out, "nonNullInputProducesNonNull", true);
      appendStringInfoString(out, ",\"arg\":");
      append_expr_node(out, scope, (const Node *) relabel->arg, depth - 1);
      break;
    }
    case T_CoerceViaIO:
    {
      const CoerceViaIO *coerce = (const CoerceViaIO *) expr;
      Oid input_function;
      Oid output_function;
      Oid type_io_parameter;
      bool source_is_varlena;

      getTypeInputInfo(coerce->resulttype, &input_function,
                       &type_io_parameter);
      getTypeOutputInfo(exprType((const Node *) coerce->arg),
                        &output_function, &source_is_varlena);
      appendStringInfoString(out, ",\"coercionForm\":");
      append_json_string(out, coercion_form_name(coerce->coerceformat));
      append_oid_field(out, "inputFunctionOid", input_function);
      append_oid_field(out, "outputFunctionOid", output_function);
      append_bool_field(
        out, "nullInputProducesNull",
        package_owned_type_io_function(input_function) ||
        func_strict(input_function));
      append_bool_field(
        out, "nonNullInputProducesNonNull",
        package_owned_type_io_function(input_function) &&
        package_owned_type_io_function(output_function));
      appendStringInfoString(out, ",\"arg\":");
      append_expr_node(out, scope, (const Node *) coerce->arg, depth - 1);
      break;
    }
    case T_CoerceToDomain:
    {
      const CoerceToDomain *coerce = (const CoerceToDomain *) expr;
      PtsNullAdmission admission =
        pts_type_null_admission(NULL, coerce->resulttype);

      appendStringInfoString(out, ",\"coercionForm\":");
      append_json_string(out, coercion_form_name(coerce->coercionformat));
      appendStringInfoString(out, ",\"domainNullAdmission\":");
      append_json_string(out, pts_null_admission_name(admission));
      append_bool_field(out, "nullInputProducesNull",
                        admission == PTS_NULL_ADMITS);
      append_bool_field(out, "nonNullInputProducesNonNull", true);
      appendStringInfoString(out, ",\"arg\":");
      append_expr_node(out, scope, (const Node *) coerce->arg, depth - 1);
      break;
    }
    case T_ArrayCoerceExpr:
    {
      const ArrayCoerceExpr *coerce = (const ArrayCoerceExpr *) expr;
      appendStringInfoString(out, ",\"coercionForm\":");
      append_json_string(out, coercion_form_name(coerce->coerceformat));
      append_bool_field(out, "nullInputProducesNull", true);
      append_bool_field(out, "nonNullInputProducesNonNull", true);
      appendStringInfoString(out, ",\"arg\":");
      append_expr_node(out, scope, (const Node *) coerce->arg, depth - 1);
      appendStringInfoString(out, ",\"elementExpr\":");
      append_expr_node(out, scope, (const Node *) coerce->elemexpr,
                       depth - 1);
      break;
    }
    case T_ConvertRowtypeExpr:
    {
      const ConvertRowtypeExpr *coerce =
        (const ConvertRowtypeExpr *) expr;
      appendStringInfoString(out, ",\"coercionForm\":");
      append_json_string(out, coercion_form_name(coerce->convertformat));
      append_bool_field(out, "nullInputProducesNull", true);
      append_bool_field(out, "nonNullInputProducesNonNull", true);
      appendStringInfoString(out, ",\"arg\":");
      append_expr_node(out, scope, (const Node *) coerce->arg, depth - 1);
      break;
    }
    case T_CaseExpr:
    {
      const CaseExpr *case_expr = (const CaseExpr *) expr;
      appendStringInfoString(out, ",\"arg\":");
      append_expr_node(out, scope, (const Node *) case_expr->arg, depth - 1);
      append_expr_list(out, scope, "whenClauses", case_expr->args, depth);
      appendStringInfoString(out, ",\"defresult\":");
      append_expr_node(out, scope, (const Node *) case_expr->defresult, depth - 1);
      break;
    }
    case T_CaseWhen:
    {
      const CaseWhen *case_when = (const CaseWhen *) expr;
      appendStringInfoString(out, ",\"condition\":");
      append_expr_node(out, scope, (const Node *) case_when->expr, depth - 1);
      appendStringInfoString(out, ",\"result\":");
      append_expr_node(out, scope, (const Node *) case_when->result, depth - 1);
      break;
    }
    case T_ArrayExpr:
    {
      const ArrayExpr *array_expr = (const ArrayExpr *) expr;
      append_oid_field(out, "elementTypeOid", array_expr->element_typeid);
      append_optional_name_field(out, "elementTypeName", OidIsValid(array_expr->element_typeid) ? format_type_extended(array_expr->element_typeid, -1, FORMAT_TYPE_TYPEMOD_GIVEN) : NULL);
      append_bool_field(out, "multidims", array_expr->multidims);
      append_expr_list(out, scope, "elements", array_expr->elements, depth);
      break;
    }
    case T_SubLink:
    {
      const SubLink *sublink = (const SubLink *) expr;
      appendStringInfoString(out, ",\"subLinkType\":");
      append_json_string(out, sublink_type_name(sublink->subLinkType));
      appendStringInfo(out, ",\"subLinkId\":%d", sublink->subLinkId);
      appendStringInfoString(out, ",\"testExpr\":");
      append_expr_node(out, scope, sublink->testexpr, depth - 1);
      if (sublink->subselect != NULL && IsA(sublink->subselect, Query))
      {
        appendStringInfoString(out, ",\"subquery\":");
        append_query_summary(out, (const Query *) sublink->subselect, scope,
                             depth - 1, false, false);
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
append_cte_list(StringInfo out, const PtsQueryScope *scope, int depth)
{
  const Query *query = scope->query;
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
      append_query_summary(out, cte_query, scope, depth - 1, false, false);
    }
    appendStringInfoChar(out, '}');
  }
  appendStringInfoChar(out, ']');
}

static void
append_target_list(StringInfo out, const PtsQueryScope *scope)
{
  const Query *query = scope->query;
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
    append_expr_specific_fields(out, scope, expr);
    appendStringInfoString(out, ",\"expr\":");
    append_expr_node(out, scope, expr, 8);
    appendStringInfoChar(out, '}');
  }
  appendStringInfoChar(out, ']');
}

static void
append_set_operation(StringInfo out, const Node *node)
{
  if (node == NULL)
  {
    appendStringInfoString(out, "null");
    return;
  }

  if (IsA(node, RangeTblRef))
  {
    const RangeTblRef *reference = (const RangeTblRef *) node;

    appendStringInfo(out, "{\"kind\":\"leaf\",\"rtindex\":%d}", reference->rtindex);
    return;
  }

  if (IsA(node, SetOperationStmt))
  {
    const SetOperationStmt *operation = (const SetOperationStmt *) node;
    const char *name = "UNKNOWN";

    switch (operation->op)
    {
      case SETOP_UNION:
        name = "UNION";
        break;
      case SETOP_INTERSECT:
        name = "INTERSECT";
        break;
      case SETOP_EXCEPT:
        name = "EXCEPT";
        break;
      case SETOP_NONE:
        name = "NONE";
        break;
    }

    appendStringInfoString(out, "{\"kind\":\"operation\",\"operation\":");
    append_json_string(out, name);
    append_bool_field(out, "all", operation->all);
    appendStringInfoString(out, ",\"left\":");
    append_set_operation(out, operation->larg);
    appendStringInfoString(out, ",\"right\":");
    append_set_operation(out, operation->rarg);
    appendStringInfoChar(out, '}');
    return;
  }

  appendStringInfoString(out, "null");
}

static void
append_returning_list(StringInfo out, const PtsQueryScope *scope)
{
  const Query *query = scope->query;
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
    append_expr_node(out, scope, expr, 8);
    appendStringInfoChar(out, '}');
  }
  appendStringInfoChar(out, ']');
}

static void
append_rtable(StringInfo out, const PtsQueryScope *scope, int depth)
{
  const Query *query = scope->query;
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
    append_bool_field(out, "inh", rte->inh);
    append_bool_field(out, "lateral", rte->lateral);
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
      append_expr_list(out, scope, "joinAliasVars", rte->joinaliasvars, depth);
    }
    if (rte->rtekind == RTE_VALUES)
    {
      append_expr_rows(out, scope, "valuesLists", rte->values_lists, depth);
    }
    if (rte->rtekind == RTE_CTE)
    {
      append_optional_name_field(out, "cteName", rte->ctename);
      appendStringInfo(out, ",\"cteLevelSup\":%u", rte->ctelevelsup);
      append_bool_field(out, "cteSelfReference", rte->self_reference);
      append_oid_list_field(out, "cteColumnTypeOids", rte->coltypes);
    }
    if (rte->rtekind == RTE_GROUP)
    {
      append_expr_list(out, scope, "groupExprs", rte->groupexprs, depth);
    }
    append_oid_field(out, "relid", rte->relid);
    append_optional_name_field(out, "relname", OidIsValid(rte->relid) ? get_rel_name(rte->relid) : NULL);
    if (rte->rtekind == RTE_SUBQUERY && rte->subquery != NULL && depth > 0)
    {
      appendStringInfoString(out, ",\"subquery\":");
      append_query_summary(out, rte->subquery, scope, depth - 1, false, false);
    }
    appendStringInfoChar(out, '}');
    index++;
  }
  appendStringInfoChar(out, ']');
}

static void
append_from_list(StringInfo out, const PtsQueryScope *scope, const char *name, const List *nodes, int depth)
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
    append_from_node(out, scope, (const Node *) lfirst(cell), depth - 1);
  }
  appendStringInfoChar(out, ']');
}

static void
append_from_node(StringInfo out, const PtsQueryScope *scope, const Node *node, int depth)
{
  const Query *query = scope->query;
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
      append_from_node(out, scope, join->larg, depth - 1);
      appendStringInfoString(out, ",\"right\":");
      append_from_node(out, scope, join->rarg, depth - 1);
      appendStringInfoString(out, ",\"quals\":");
      append_expr_node(out, scope, join->quals, depth - 1);
      break;
    }
    case T_FromExpr:
    {
      const FromExpr *from = (const FromExpr *) node;
      append_from_list(out, scope, "fromlist", from->fromlist, depth);
      appendStringInfoString(out, ",\"quals\":");
      append_expr_node(out, scope, from->quals, depth - 1);
      break;
    }
    default:
      appendStringInfoString(out, ",\"unsupported\":true");
      break;
  }

  appendStringInfoChar(out, '}');
}

static bool
function_is_volatile(Oid function_oid)
{
  HeapTuple tuple;
  bool result;

  tuple = SearchSysCache1(PROCOID, ObjectIdGetDatum(function_oid));
  if (!HeapTupleIsValid(tuple))
  {
    elog(ERROR, "cache lookup failed for function %u", function_oid);
  }

  result = ((Form_pg_proc) GETSTRUCT(tuple))->provolatile == PROVOLATILE_VOLATILE;
  ReleaseSysCache(tuple);
  return result;
}

typedef enum AggregateExecutionProfile
{
  AGG_EXECUTION_NONWINDOW,
  AGG_EXECUTION_WINDOW_ORDINARY,
  AGG_EXECUTION_WINDOW_MOVING,
  AGG_EXECUTION_WINDOW_UNRESOLVED
} AggregateExecutionProfile;

static bool
aggregate_invokes_volatile_function(Oid aggregate_oid, const List *args,
                                    bool target_entries,
                                    AggregateExecutionProfile execution,
                                    Oid result_type, int32 result_typmod)
{
  HeapTuple tuple;
  Form_pg_aggregate aggregate;
  Oid support_function_oids[5];
  int support_function_count = 0;
  int index;

  tuple = SearchSysCache1(AGGFNOID, ObjectIdGetDatum(aggregate_oid));
  if (!HeapTupleIsValid(tuple))
  {
    elog(ERROR, "cache lookup failed for aggregate %u", aggregate_oid);
  }

  aggregate = (Form_pg_aggregate) GETSTRUCT(tuple);
  if (execution == AGG_EXECUTION_NONWINDOW ||
      execution == AGG_EXECUTION_WINDOW_ORDINARY ||
      execution == AGG_EXECUTION_WINDOW_UNRESOLVED)
  {
    support_function_oids[support_function_count++] = aggregate->aggtransfn;
    support_function_oids[support_function_count++] = aggregate->aggfinalfn;
  }
  if (execution == AGG_EXECUTION_NONWINDOW)
  {
    support_function_oids[support_function_count++] = aggregate->aggcombinefn;
    support_function_oids[support_function_count++] = aggregate->aggserialfn;
    support_function_oids[support_function_count++] = aggregate->aggdeserialfn;
  }
  else if (execution == AGG_EXECUTION_WINDOW_MOVING ||
           execution == AGG_EXECUTION_WINDOW_UNRESOLVED)
  {
    support_function_oids[support_function_count++] = aggregate->aggmtransfn;
    support_function_oids[support_function_count++] = aggregate->aggminvtransfn;
    support_function_oids[support_function_count++] = aggregate->aggmfinalfn;
  }
  ReleaseSysCache(tuple);

  for (index = 0; index < support_function_count; index++)
  {
    Oid function_oid = support_function_oids[index];

    if (OidIsValid(function_oid) &&
        (function_is_volatile(function_oid) ||
         executor_support_dependency_invokes_volatile(
           function_oid, args, target_entries, result_type, result_typmod)))
    {
      return true;
    }
  }
  return false;
}

static const WindowClause *
window_clause_for_function(const WindowFunc *function,
                           const PtsQueryScope *scope)
{
  ListCell *cell;

  if (scope == NULL || scope->query == NULL)
  {
    return NULL;
  }
  foreach(cell, scope->query->windowClause)
  {
    const WindowClause *window = lfirst_node(WindowClause, cell);

    if (window->winref == function->winref)
    {
      return window;
    }
  }
  return NULL;
}

static bool
window_function_arguments_contain_volatile(const WindowFunc *function)
{
  return function_is_volatile(function->winfnoid) ||
         contain_volatile_functions((Node *) function->args) ||
         contain_volatile_functions((Node *) function->aggfilter);
}

static bool
window_function_arguments_contain_subplans(const WindowFunc *function)
{
  return contain_subplans((Node *) function->args) ||
         contain_subplans((Node *) function->aggfilter);
}

static AggregateExecutionProfile
window_aggregate_execution_profile(const WindowFunc *function,
                                   const PtsQueryScope *scope)
{
  HeapTuple tuple;
  Form_pg_aggregate aggregate;
  const WindowClause *window;
  AggregateExecutionProfile execution;

  tuple = SearchSysCache1(AGGFNOID, ObjectIdGetDatum(function->winfnoid));
  if (!HeapTupleIsValid(tuple))
  {
    elog(ERROR, "cache lookup failed for aggregate %u", function->winfnoid);
  }
  aggregate = (Form_pg_aggregate) GETSTRUCT(tuple);

  /*
   * Keep this ordering synchronized with initialize_peragg() in
   * nodeWindowAgg.c.  Moving-final safety can force moving mode before the
   * frame and argument checks are considered.
   */
  if (!OidIsValid(aggregate->aggminvtransfn))
  {
    execution = AGG_EXECUTION_WINDOW_ORDINARY;
  }
  else if (aggregate->aggmfinalmodify == AGGMODIFY_READ_ONLY &&
           aggregate->aggfinalmodify != AGGMODIFY_READ_ONLY)
  {
    execution = AGG_EXECUTION_WINDOW_MOVING;
  }
  else
  {
    window = window_clause_for_function(function, scope);
    if (window == NULL)
    {
      execution = AGG_EXECUTION_WINDOW_UNRESOLVED;
    }
    else if ((window->frameOptions &
              FRAMEOPTION_START_UNBOUNDED_PRECEDING) != 0 ||
             window_function_arguments_contain_volatile(function) ||
             window_function_arguments_contain_subplans(function))
    {
      execution = AGG_EXECUTION_WINDOW_ORDINARY;
    }
    else
    {
      execution = AGG_EXECUTION_WINDOW_MOVING;
    }
  }

  ReleaseSysCache(tuple);
  return execution;
}

/* Dynamic container support is recursive; unresolved cycles stay conservative. */
#define MAX_RUNTIME_TYPE_SUPPORT_DEPTH 32

typedef enum RuntimeTypeSupportKind
{
  RUNTIME_SUPPORT_EQUAL,
  RUNTIME_SUPPORT_COMPARE,
  RUNTIME_SUPPORT_HASH
} RuntimeTypeSupportKind;

typedef struct RuntimeTypeSupportKey
{
  Oid type_oid;
  int32 typmod;
  RuntimeTypeSupportKind kind;
} RuntimeTypeSupportKey;

typedef struct RuntimeTypeSupportContext
{
  RuntimeTypeSupportKey stack[MAX_RUNTIME_TYPE_SUPPORT_DEPTH];
  int depth;
} RuntimeTypeSupportContext;

static bool
type_runtime_support_invokes_volatile(Oid type_oid, int32 typmod,
                                      RuntimeTypeSupportKind kind,
                                      RuntimeTypeSupportContext *context)
{
  TypeCacheEntry *type_cache;
  Oid base_type;
  Oid element_type;
  char type_kind;
  FmgrInfo *support_function = NULL;
  int stack_index;
  bool result = false;

  if (!OidIsValid(type_oid) || context->depth >= MAX_RUNTIME_TYPE_SUPPORT_DEPTH)
  {
    return true;
  }

  base_type = getBaseTypeAndTypmod(type_oid, &typmod);
  for (stack_index = 0; stack_index < context->depth; stack_index++)
  {
    RuntimeTypeSupportKey *key = &context->stack[stack_index];

    if (key->type_oid == base_type && key->typmod == typmod && key->kind == kind)
    {
      return true;
    }
  }
  context->stack[context->depth].type_oid = base_type;
  context->stack[context->depth].typmod = typmod;
  context->stack[context->depth].kind = kind;
  context->depth++;

  switch (kind)
  {
    case RUNTIME_SUPPORT_EQUAL:
      type_cache = lookup_type_cache(base_type, TYPECACHE_EQ_OPR_FINFO);
      support_function = &type_cache->eq_opr_finfo;
      break;
    case RUNTIME_SUPPORT_COMPARE:
      type_cache = lookup_type_cache(base_type, TYPECACHE_CMP_PROC_FINFO);
      support_function = &type_cache->cmp_proc_finfo;
      break;
    case RUNTIME_SUPPORT_HASH:
      type_cache = lookup_type_cache(base_type, TYPECACHE_HASH_PROC_FINFO);
      support_function = &type_cache->hash_proc_finfo;
      break;
  }
  if (support_function != NULL && OidIsValid(support_function->fn_oid) &&
      function_is_volatile(support_function->fn_oid))
  {
    context->depth--;
    return true;
  }

  element_type = get_element_type(base_type);
  if (OidIsValid(element_type))
  {
    result = type_runtime_support_invokes_volatile(
      element_type, -1, kind, context);
    context->depth--;
    return result;
  }

  type_kind = get_typtype(base_type);
  if (type_kind == TYPTYPE_COMPOSITE || base_type == RECORDOID)
  {
    TupleDesc descriptor = lookup_rowtype_tupdesc_domain(base_type, typmod, true);
    int attribute_index;

    if (descriptor == NULL)
    {
      context->depth--;
      return true;
    }
    for (attribute_index = 0; attribute_index < descriptor->natts; attribute_index++)
    {
      Form_pg_attribute attribute = TupleDescAttr(descriptor, attribute_index);

      if (!attribute->attisdropped &&
          type_runtime_support_invokes_volatile(
            attribute->atttypid, attribute->atttypmod, kind, context))
      {
        result = true;
        break;
      }
    }
    ReleaseTupleDesc(descriptor);
    context->depth--;
    return result;
  }

  if (type_kind == TYPTYPE_RANGE)
  {
    type_cache = lookup_type_cache(base_type, TYPECACHE_RANGE_INFO);
    if (type_cache->rngelemtype == NULL)
    {
      context->depth--;
      return true;
    }
    if (kind == RUNTIME_SUPPORT_HASH)
    {
      result = type_runtime_support_invokes_volatile(
        type_cache->rngelemtype->type_id, -1, RUNTIME_SUPPORT_HASH, context);
    }
    else
    {
      result = !OidIsValid(type_cache->rng_cmp_proc_finfo.fn_oid) ||
               function_is_volatile(type_cache->rng_cmp_proc_finfo.fn_oid) ||
               type_runtime_support_invokes_volatile(
                 type_cache->rngelemtype->type_id, -1,
                 RUNTIME_SUPPORT_COMPARE, context);
    }
    context->depth--;
    return result;
  }

  if (type_kind == TYPTYPE_MULTIRANGE)
  {
    type_cache = lookup_type_cache(base_type, TYPECACHE_MULTIRANGE_INFO);
    if (type_cache->rngtype == NULL)
    {
      context->depth--;
      return true;
    }
    result = type_runtime_support_invokes_volatile(
      type_cache->rngtype->type_id, -1, kind, context);
    context->depth--;
    return result;
  }

  context->depth--;
  return false;
}

typedef struct JsonConversionKey
{
  Oid type_oid;
  int32 typmod;
  bool is_jsonb;
} JsonConversionKey;

typedef struct JsonConversionContext
{
  JsonConversionKey stack[MAX_RUNTIME_TYPE_SUPPORT_DEPTH];
  int depth;
} JsonConversionContext;

static bool
json_type_conversion_invokes_volatile(Oid type_oid, int32 typmod,
                                      bool is_jsonb,
                                      JsonConversionContext *context)
{
  JsonTypeCategory category;
  Oid output_function;
  Oid base_type;
  int stack_index;
  bool result = false;

  if (!OidIsValid(type_oid) || context->depth >= MAX_RUNTIME_TYPE_SUPPORT_DEPTH)
  {
    return true;
  }
  base_type = getBaseTypeAndTypmod(type_oid, &typmod);
  for (stack_index = 0; stack_index < context->depth; stack_index++)
  {
    JsonConversionKey *key = &context->stack[stack_index];

    if (key->type_oid == base_type && key->typmod == typmod &&
        key->is_jsonb == is_jsonb)
    {
      return true;
    }
  }
  context->stack[context->depth].type_oid = base_type;
  context->stack[context->depth].typmod = typmod;
  context->stack[context->depth].is_jsonb = is_jsonb;
  context->depth++;

  json_categorize_type(base_type, is_jsonb, &category, &output_function);
  if (category == JSONTYPE_ARRAY)
  {
    Oid element_type = get_element_type(base_type);

    result = !OidIsValid(element_type) ||
             json_type_conversion_invokes_volatile(
               element_type, -1, is_jsonb, context);
  }
  else if (category == JSONTYPE_COMPOSITE)
  {
    TupleDesc descriptor = lookup_rowtype_tupdesc_domain(base_type, typmod, true);
    int attribute_index;

    if (descriptor == NULL)
    {
      result = true;
    }
    else
    {
      for (attribute_index = 0; attribute_index < descriptor->natts; attribute_index++)
      {
        Form_pg_attribute attribute = TupleDescAttr(descriptor, attribute_index);

        if (!attribute->attisdropped &&
            json_type_conversion_invokes_volatile(
              attribute->atttypid, attribute->atttypmod, is_jsonb, context))
        {
          result = true;
          break;
        }
      }
      ReleaseTupleDesc(descriptor);
    }
  }
  else if (OidIsValid(output_function))
  {
    result = function_is_volatile(output_function);
  }

  context->depth--;
  return result;
}

static bool
json_conversion_args_invoke_volatile(const List *args, bool is_jsonb,
                                     bool target_entries)
{
  ListCell *cell;

  foreach(cell, args)
  {
    const Node *argument = target_entries
                             ? (const Node *) lfirst_node(TargetEntry, cell)->expr
                             : (const Node *) lfirst(cell);
    JsonConversionContext context = {0};

    if (argument == NULL ||
        json_type_conversion_invokes_volatile(
          exprType(argument), exprTypmod(argument), is_jsonb, &context))
    {
      return true;
    }
  }
  return false;
}

static bool
json_function_args_invoke_volatile(Oid function_oid, const List *args)
{
  switch (function_oid)
  {
    case F_ARRAY_TO_JSON_ANYARRAY:
    case F_ARRAY_TO_JSON_ANYARRAY_BOOL:
    case F_ROW_TO_JSON_RECORD:
    case F_ROW_TO_JSON_RECORD_BOOL:
    case F_TO_JSON:
    case F_JSON_BUILD_ARRAY_ANY:
    case F_JSON_BUILD_OBJECT_ANY:
      return json_conversion_args_invoke_volatile(args, false, false);
    case F_TO_JSONB:
    case F_JSONB_BUILD_ARRAY_ANY:
    case F_JSONB_BUILD_OBJECT_ANY:
      return json_conversion_args_invoke_volatile(args, true, false);
    default:
      return false;
  }
}

static bool
json_aggregate_args_invoke_volatile(Oid aggregate_oid, const List *args)
{
  bool is_jsonb;

  switch (aggregate_oid)
  {
    case F_JSON_AGG:
    case F_JSON_AGG_STRICT:
    case F_JSON_OBJECT_AGG:
    case F_JSON_OBJECT_AGG_STRICT:
    case F_JSON_OBJECT_AGG_UNIQUE:
    case F_JSON_OBJECT_AGG_UNIQUE_STRICT:
      is_jsonb = false;
      break;
    case F_JSONB_AGG:
    case F_JSONB_AGG_STRICT:
    case F_JSONB_OBJECT_AGG:
    case F_JSONB_OBJECT_AGG_STRICT:
    case F_JSONB_OBJECT_AGG_UNIQUE:
    case F_JSONB_OBJECT_AGG_UNIQUE_STRICT:
      is_jsonb = true;
      break;
    default:
      return false;
  }
  return json_conversion_args_invoke_volatile(args, is_jsonb, true);
}

static bool
json_constructor_args_invoke_volatile(const JsonConstructorExpr *constructor)
{
  bool is_jsonb;

  if (constructor->returning == NULL || constructor->returning->format == NULL)
  {
    return true;
  }
  switch (constructor->type)
  {
    case JSCTOR_JSON_OBJECT:
    case JSCTOR_JSON_ARRAY:
    case JSCTOR_JSON_OBJECTAGG:
    case JSCTOR_JSON_ARRAYAGG:
    case JSCTOR_JSON_SCALAR:
      is_jsonb = constructor->returning->format->format_type == JS_FORMAT_JSONB;
      return json_conversion_args_invoke_volatile(
        constructor->args, is_jsonb, false);
    case JSCTOR_JSON_PARSE:
    case JSCTOR_JSON_SERIALIZE:
      return false;
  }
  return true;
}

typedef enum ExecutorSupportDependency
{
  EXECUTOR_SUPPORT_NONE = 0,
  EXECUTOR_SUPPORT_EQUAL = 1 << 0,
  EXECUTOR_SUPPORT_COMPARE = 1 << 1,
  EXECUTOR_SUPPORT_HASH = 1 << 2,
  EXECUTOR_SUPPORT_RANGE_CANONICAL = 1 << 3
} ExecutorSupportDependency;

typedef struct ExecutorSupportProfile
{
  int dependencies;
  bool inspect_arguments;
  bool inspect_result;
} ExecutorSupportProfile;

static ExecutorSupportProfile
executor_support_profile(int dependencies, bool inspect_arguments,
                         bool inspect_result)
{
  ExecutorSupportProfile profile = {
    dependencies,
    inspect_arguments,
    inspect_result
  };

  return profile;
}

/*
 * CREATE TYPE AS RANGE manufactures constructor OIDs, so unlike the fixed
 * pg_catalog functions below they must be recognized by their trusted
 * INTERNAL implementation and exact generated signature.
 */
static ExecutorSupportProfile
dynamic_container_executor_support_profile(Oid function_oid)
{
  HeapTuple tuple;
  Form_pg_proc procedure;
  Datum source_datum;
  char *source;
  bool is_null;
  ExecutorSupportProfile profile = executor_support_profile(
    EXECUTOR_SUPPORT_NONE, false, false);

  if (!OidIsValid(function_oid))
  {
    return profile;
  }
  tuple = SearchSysCache1(PROCOID, ObjectIdGetDatum(function_oid));
  if (!HeapTupleIsValid(tuple))
  {
    elog(ERROR, "cache lookup failed for function %u", function_oid);
  }
  procedure = (Form_pg_proc) GETSTRUCT(tuple);
  if (procedure->prolang != INTERNALlanguageId ||
      procedure->prokind != PROKIND_FUNCTION)
  {
    ReleaseSysCache(tuple);
    return profile;
  }

  source_datum = SysCacheGetAttr(
    PROCOID, tuple, Anum_pg_proc_prosrc, &is_null);
  if (is_null)
  {
    ReleaseSysCache(tuple);
    return profile;
  }
  source = TextDatumGetCString(source_datum);

  if ((strcmp(source, "range_constructor2") == 0 ||
       strcmp(source, "range_constructor3") == 0) &&
      !procedure->proretset && !OidIsValid(procedure->provariadic) &&
      get_typtype(procedure->prorettype) == TYPTYPE_RANGE)
  {
    TypeCacheEntry *range_cache = lookup_type_cache(
      procedure->prorettype, TYPECACHE_RANGE_INFO);
    Oid subtype = range_cache->rngelemtype == NULL
                    ? InvalidOid
                    : range_cache->rngelemtype->type_id;
    bool constructor2 = strcmp(source, "range_constructor2") == 0;
    int expected_arguments = constructor2 ? 2 : 3;

    if (OidIsValid(subtype) &&
        procedure->pronargs == expected_arguments &&
        procedure->proargtypes.values[0] == subtype &&
        procedure->proargtypes.values[1] == subtype &&
        (constructor2 || procedure->proargtypes.values[2] == TEXTOID))
    {
      profile = executor_support_profile(
        EXECUTOR_SUPPORT_COMPARE | EXECUTOR_SUPPORT_RANGE_CANONICAL,
        false, true);
    }
  }
  else if (strcmp(source, "multirange_constructor2") == 0 &&
           !procedure->proretset &&
           get_typtype(procedure->prorettype) == TYPTYPE_MULTIRANGE &&
           procedure->pronargs == 1)
  {
    TypeCacheEntry *multirange_cache = lookup_type_cache(
      procedure->prorettype, TYPECACHE_MULTIRANGE_INFO);
    Oid range_type = multirange_cache->rngtype == NULL
                       ? InvalidOid
                       : multirange_cache->rngtype->type_id;

    if (OidIsValid(range_type) &&
        procedure->provariadic == range_type &&
        get_element_type(procedure->proargtypes.values[0]) == range_type)
    {
      profile = executor_support_profile(
        EXECUTOR_SUPPORT_COMPARE | EXECUTOR_SUPPORT_RANGE_CANONICAL,
        false, true);
    }
  }

  pfree(source);
  ReleaseSysCache(tuple);
  return profile;
}

/*
 * PostgreSQL's generic array/range/multirange/record executors are declared
 * immutable even though they resolve element or subtype support at runtime.
 * Keep that transitive dependency in one version-specific table so every
 * caller (ordinary functions, operators, and aggregate support) agrees.
 */
static ExecutorSupportProfile
executor_support_profile_for_function(Oid function_oid)
{
  switch (function_oid)
  {
    case F_ARRAY_EQ:
    case F_ARRAY_NE:
    case F_RECORD_EQ:
    case F_RECORD_NE:
    case F_ARRAY_POSITION_ANYCOMPATIBLEARRAY_ANYCOMPATIBLE:
    case F_ARRAY_POSITION_ANYCOMPATIBLEARRAY_ANYCOMPATIBLE_INT4:
    case F_ARRAY_POSITIONS:
    case F_ARRAY_REMOVE:
    case F_ARRAY_REPLACE:
    case F_ARRAYOVERLAP:
    case F_ARRAYCONTAINS:
    case F_ARRAYCONTAINED:
      return executor_support_profile(
        EXECUTOR_SUPPORT_EQUAL, true, false);

    case F_BTARRAYCMP:
    case F_ARRAY_LT:
    case F_ARRAY_GT:
    case F_ARRAY_LE:
    case F_ARRAY_GE:
    case F_ARRAY_LARGER:
    case F_ARRAY_SMALLER:
    case F_ARRAY_SORT_ANYARRAY:
    case F_ARRAY_SORT_ANYARRAY_BOOL:
    case F_ARRAY_SORT_ANYARRAY_BOOL_BOOL:
    case F_WIDTH_BUCKET_ANYCOMPATIBLE_ANYCOMPATIBLEARRAY:
    case F_RECORD_LT:
    case F_RECORD_GT:
    case F_RECORD_LE:
    case F_RECORD_GE:
    case F_BTRECORDCMP:
    case F_RECORD_LARGER:
    case F_RECORD_SMALLER:
    case F_RANGE_EQ:
    case F_RANGE_NE:
    case F_RANGE_OVERLAPS:
    case F_RANGE_CONTAINS_ELEM:
    case F_RANGE_CONTAINS:
    case F_ELEM_CONTAINED_BY_RANGE:
    case F_RANGE_CONTAINED_BY:
    case F_RANGE_BEFORE:
    case F_RANGE_AFTER:
    case F_RANGE_OVERLEFT:
    case F_RANGE_OVERRIGHT:
    case F_RANGE_CMP:
    case F_RANGE_LT:
    case F_RANGE_LE:
    case F_RANGE_GE:
    case F_RANGE_GT:
    case F_MULTIRANGE_EQ:
    case F_MULTIRANGE_NE:
    case F_RANGE_OVERLAPS_MULTIRANGE:
    case F_MULTIRANGE_OVERLAPS_RANGE:
    case F_MULTIRANGE_OVERLAPS_MULTIRANGE:
    case F_MULTIRANGE_CONTAINS_ELEM:
    case F_MULTIRANGE_CONTAINS_RANGE:
    case F_MULTIRANGE_CONTAINS_MULTIRANGE:
    case F_ELEM_CONTAINED_BY_MULTIRANGE:
    case F_RANGE_CONTAINED_BY_MULTIRANGE:
    case F_MULTIRANGE_CONTAINED_BY_MULTIRANGE:
    case F_RANGE_BEFORE_MULTIRANGE:
    case F_MULTIRANGE_BEFORE_RANGE:
    case F_MULTIRANGE_BEFORE_MULTIRANGE:
    case F_RANGE_AFTER_MULTIRANGE:
    case F_MULTIRANGE_AFTER_RANGE:
    case F_MULTIRANGE_AFTER_MULTIRANGE:
    case F_RANGE_OVERLEFT_MULTIRANGE:
    case F_MULTIRANGE_OVERLEFT_RANGE:
    case F_MULTIRANGE_OVERLEFT_MULTIRANGE:
    case F_RANGE_OVERRIGHT_MULTIRANGE:
    case F_MULTIRANGE_OVERRIGHT_RANGE:
    case F_MULTIRANGE_OVERRIGHT_MULTIRANGE:
    case F_MULTIRANGE_CMP:
    case F_MULTIRANGE_LT:
    case F_MULTIRANGE_LE:
    case F_MULTIRANGE_GE:
    case F_MULTIRANGE_GT:
    case F_RANGE_CONTAINS_MULTIRANGE:
    case F_MULTIRANGE_CONTAINED_BY_RANGE:
      return executor_support_profile(
        EXECUTOR_SUPPORT_COMPARE, true, false);

    case F_RANGE_ADJACENT:
    case F_RANGE_UNION:
    case F_RANGE_INTERSECT:
    case F_RANGE_MINUS:
    case F_RANGE_MERGE_ANYRANGE_ANYRANGE:
    case F_RANGE_MERGE_ANYMULTIRANGE:
    case F_RANGE_ADJACENT_MULTIRANGE:
    case F_MULTIRANGE_ADJACENT_MULTIRANGE:
    case F_MULTIRANGE_ADJACENT_RANGE:
    case F_MULTIRANGE_UNION:
    case F_MULTIRANGE_MINUS:
    case F_MULTIRANGE_INTERSECT:
    case F_RANGE_AGG_FINALFN:
    case F_MULTIRANGE_AGG_FINALFN:
    case F_RANGE_INTERSECT_AGG_TRANSFN:
    case F_MULTIRANGE_INTERSECT_AGG_TRANSFN:
      return executor_support_profile(
        EXECUTOR_SUPPORT_COMPARE | EXECUTOR_SUPPORT_RANGE_CANONICAL,
        true, false);

    case F_RANGE_IN:
    case F_RANGE_RECV:
    case F_MULTIRANGE_IN:
    case F_MULTIRANGE_RECV:
      return executor_support_profile(
        EXECUTOR_SUPPORT_COMPARE | EXECUTOR_SUPPORT_RANGE_CANONICAL,
        false, true);

    case F_HASH_ARRAY:
    case F_HASH_ARRAY_EXTENDED:
    case F_HASH_RANGE:
    case F_HASH_RANGE_EXTENDED:
    case F_HASH_MULTIRANGE:
    case F_HASH_MULTIRANGE_EXTENDED:
    case F_HASH_RECORD:
    case F_HASH_RECORD_EXTENDED:
      return executor_support_profile(
        EXECUTOR_SUPPORT_HASH, true, false);

    default:
      return dynamic_container_executor_support_profile(function_oid);
  }
}

static bool
range_canonical_support_invokes_volatile(Oid type_oid, int32 typmod)
{
  Oid base_type = getBaseTypeAndTypmod(type_oid, &typmod);
  TypeCacheEntry *type_cache;
  char type_kind;

  if (!OidIsValid(base_type))
  {
    return true;
  }
  type_kind = get_typtype(base_type);
  if (type_kind == TYPTYPE_MULTIRANGE)
  {
    type_cache = lookup_type_cache(base_type, TYPECACHE_MULTIRANGE_INFO);
    return type_cache->rngtype == NULL ||
           range_canonical_support_invokes_volatile(
             type_cache->rngtype->type_id, -1);
  }
  if (type_kind != TYPTYPE_RANGE)
  {
    return false;
  }
  type_cache = lookup_type_cache(base_type, TYPECACHE_RANGE_INFO);
  return OidIsValid(type_cache->rng_canonical_finfo.fn_oid) &&
         function_is_volatile(type_cache->rng_canonical_finfo.fn_oid);
}

static bool
type_executor_support_invokes_volatile(Oid type_oid, int32 typmod,
                                       int dependencies)
{
  RuntimeTypeSupportKind kind;

  for (kind = RUNTIME_SUPPORT_EQUAL;
       kind <= RUNTIME_SUPPORT_HASH;
       kind++)
  {
    int dependency = kind == RUNTIME_SUPPORT_EQUAL
                       ? EXECUTOR_SUPPORT_EQUAL
                       : kind == RUNTIME_SUPPORT_COMPARE
                           ? EXECUTOR_SUPPORT_COMPARE
                           : EXECUTOR_SUPPORT_HASH;
    RuntimeTypeSupportContext context = {0};

    if ((dependencies & dependency) != 0 &&
        type_runtime_support_invokes_volatile(
          type_oid, typmod, kind, &context))
    {
      return true;
    }
  }
  return (dependencies & EXECUTOR_SUPPORT_RANGE_CANONICAL) != 0 &&
         range_canonical_support_invokes_volatile(type_oid, typmod);
}

static bool
executor_support_dependency_invokes_volatile(
  Oid function_oid, const List *args, bool target_entries,
  Oid result_type, int32 result_typmod)
{
  ExecutorSupportProfile profile = executor_support_profile_for_function(
    function_oid);
  ListCell *cell;

  if (profile.dependencies == EXECUTOR_SUPPORT_NONE)
  {
    return false;
  }
  if (profile.inspect_arguments)
  {
    foreach(cell, args)
    {
      const Node *argument = target_entries
                               ? (const Node *) lfirst_node(TargetEntry, cell)->expr
                               : (const Node *) lfirst(cell);

      if (argument == NULL ||
          type_executor_support_invokes_volatile(
            exprType(argument), exprTypmod(argument), profile.dependencies))
      {
        return true;
      }
    }
  }
  return profile.inspect_result &&
         (!OidIsValid(result_type) ||
          type_executor_support_invokes_volatile(
            result_type, result_typmod, profile.dependencies));
}

static bool
operator_argument_support_invokes_volatile(const List *args)
{
  ListCell *cell;

  foreach(cell, args)
  {
    const Node *argument = (const Node *) lfirst(cell);
    RuntimeTypeSupportKind kind;

    if (argument == NULL)
    {
      return true;
    }
    for (kind = RUNTIME_SUPPORT_EQUAL;
         kind <= RUNTIME_SUPPORT_HASH;
         kind++)
    {
      RuntimeTypeSupportContext context = {0};

      if (type_runtime_support_invokes_volatile(
            exprType(argument), exprTypmod(argument), kind, &context))
      {
        return true;
      }
    }
  }
  return false;
}

static bool
scalar_array_hash_support_invokes_volatile(const ScalarArrayOpExpr *expression)
{
#define MIN_ARRAY_SIZE_FOR_HASHED_SAOP 9
  Oid equality_operator = expression->opno;
  RegProcedure left_hash_function;
  RegProcedure right_hash_function;
  RuntimeTypeSupportContext context = {0};
  const Node *left_argument;
  const Node *array_argument;
  PtsArrayShape array_shape;

  if (list_length(expression->args) != 2)
  {
    return true;
  }

  array_argument = (const Node *) lsecond(expression->args);
  array_shape = pts_array_shape_proof(array_argument);
  /* Keep this cutoff synchronized with convert_saop_to_hashed_saop(). */
  if (array_shape.proof == PTS_ARRAY_SHAPE_VALID &&
      (array_shape.is_null ||
       array_shape.nitems < MIN_ARRAY_SIZE_FOR_HASHED_SAOP))
  {
    return false;
  }

  /* A custom plan can fold an external RHS Param to a hashable Const. */
  if (!expression->useOr)
  {
    equality_operator = get_negator(expression->opno);
    if (!OidIsValid(equality_operator))
    {
      return false;
    }
    if (function_is_volatile(get_opcode(equality_operator)))
    {
      return true;
    }
  }
  if (!get_op_hash_functions(equality_operator, &left_hash_function,
                             &right_hash_function) ||
      !OidIsValid(left_hash_function) || !OidIsValid(right_hash_function) ||
      left_hash_function != right_hash_function)
  {
    return false;
  }
  if (function_is_volatile(left_hash_function) ||
      function_is_volatile(right_hash_function))
  {
    return true;
  }
  left_argument = (const Node *) linitial(expression->args);
  return left_argument == NULL ||
         type_runtime_support_invokes_volatile(
           exprType(left_argument), exprTypmod(left_argument),
           RUNTIME_SUPPORT_HASH, &context);
}

typedef enum SortGroupExecution
{
  SG_EXEC_SORT = 1 << 0,
  SG_EXEC_EQUAL = 1 << 1,
  SG_EXEC_HASH = 1 << 2
} SortGroupExecution;

static bool
builtin_sortsupport_always_supplies_comparator(Oid function_oid)
{
  switch (function_oid)
  {
    case F_BTINT2SORTSUPPORT:
    case F_BTINT4SORTSUPPORT:
    case F_BTINT8SORTSUPPORT:
    case F_BTFLOAT4SORTSUPPORT:
    case F_BTFLOAT8SORTSUPPORT:
    case F_BTOIDSORTSUPPORT:
    case F_BTNAMESORTSUPPORT:
    case F_DATE_SORTSUPPORT:
    case F_TIMESTAMP_SORTSUPPORT:
    case F_BTTEXTSORTSUPPORT:
    case F_NUMERIC_SORTSUPPORT:
    case F_UUID_SORTSUPPORT:
    case F_BPCHAR_SORTSUPPORT:
    case F_BYTEA_SORTSUPPORT:
    case F_BTTEXT_PATTERN_SORTSUPPORT:
    case F_BTBPCHAR_PATTERN_SORTSUPPORT:
    case F_MACADDR_SORTSUPPORT:
    case F_NETWORK_SORTSUPPORT:
    case F_RANGE_SORTSUPPORT:
      return true;
    default:
      return false;
  }
}

static bool
ordering_support_invokes_volatile_function(Oid ordering_operator,
                                           Oid concrete_type,
                                           int32 concrete_typmod)
{
  Oid opfamily;
  Oid opcintype;
  Oid order_function;
  Oid sort_support_function;
  CompareType compare_type;

  if (OidIsValid(concrete_type))
  {
    RuntimeTypeSupportContext context = {0};

    if (type_runtime_support_invokes_volatile(
          concrete_type, concrete_typmod, RUNTIME_SUPPORT_COMPARE, &context))
    {
      return true;
    }
  }

  if (!get_ordering_op_properties(ordering_operator, &opfamily,
                                  &opcintype, &compare_type) ||
      !OidIsValid(opfamily) || !OidIsValid(opcintype) ||
      (compare_type != COMPARE_LT && compare_type != COMPARE_GT))
  {
    return true;
  }

  sort_support_function = get_opfamily_proc(
    opfamily, opcintype, opcintype, BTSORTSUPPORT_PROC);
  order_function = get_opfamily_proc(
    opfamily, opcintype, opcintype, BTORDER_PROC);

  if (OidIsValid(sort_support_function) &&
      function_is_volatile(sort_support_function))
  {
    return true;
  }
  if (OidIsValid(sort_support_function) &&
      builtin_sortsupport_always_supplies_comparator(sort_support_function))
  {
    return false;
  }
  if (!OidIsValid(order_function))
  {
    return true;
  }
  return function_is_volatile(order_function);
}

static bool
equality_support_invokes_volatile_function(Oid equality_operator,
                                           Oid concrete_type,
                                           int32 concrete_typmod)
{
  Oid equality_function;

  if (OidIsValid(concrete_type))
  {
    RuntimeTypeSupportContext context = {0};

    if (type_runtime_support_invokes_volatile(
          concrete_type, concrete_typmod, RUNTIME_SUPPORT_EQUAL, &context))
    {
      return true;
    }
  }

  if (!OidIsValid(equality_operator))
  {
    return true;
  }
  equality_function = get_opcode(equality_operator);
  return !OidIsValid(equality_function) ||
         function_is_volatile(equality_function);
}

static bool
hash_support_invokes_volatile_function(Oid equality_operator,
                                       Oid concrete_type,
                                       int32 concrete_typmod)
{
  RegProcedure left_hash_function;
  RegProcedure right_hash_function;

  if (OidIsValid(concrete_type))
  {
    RuntimeTypeSupportContext context = {0};

    if (type_runtime_support_invokes_volatile(
          concrete_type, concrete_typmod, RUNTIME_SUPPORT_HASH, &context))
    {
      return true;
    }
  }

  if (!OidIsValid(equality_operator) ||
      !get_op_hash_functions(equality_operator, &left_hash_function,
                             &right_hash_function) ||
      !OidIsValid(left_hash_function) || !OidIsValid(right_hash_function))
  {
    return true;
  }
  return function_is_volatile(left_hash_function) ||
         function_is_volatile(right_hash_function);
}

static bool
sort_group_clause_invokes_volatile_function(const SortGroupClause *clause,
                                            int execution,
                                            Oid concrete_type,
                                            int32 concrete_typmod)
{
  if ((execution & SG_EXEC_SORT) != 0 && OidIsValid(clause->sortop) &&
      ordering_support_invokes_volatile_function(
        clause->sortop, concrete_type, concrete_typmod))
  {
    return true;
  }
  if ((execution & SG_EXEC_EQUAL) != 0 &&
      equality_support_invokes_volatile_function(
        clause->eqop, concrete_type, concrete_typmod))
  {
    return true;
  }
  if ((execution & SG_EXEC_HASH) != 0 && clause->hashable &&
      hash_support_invokes_volatile_function(
        clause->eqop, concrete_type, concrete_typmod))
  {
    return true;
  }
  return false;
}

static const TargetEntry *
target_entry_by_sortgroupref(const List *target_list, Index sortgroupref)
{
  ListCell *cell;

  foreach(cell, target_list)
  {
    const TargetEntry *target = lfirst_node(TargetEntry, cell);

    if (target->ressortgroupref == sortgroupref)
    {
      return target;
    }
  }
  return NULL;
}

static bool
sort_group_clause_list_invokes_volatile_function(const List *clauses,
                                                 int execution,
                                                 const List *target_list)
{
  ListCell *cell;

  foreach(cell, clauses)
  {
    const SortGroupClause *clause =
      lfirst_node(SortGroupClause, cell);
    const TargetEntry *target = target_entry_by_sortgroupref(
      target_list, clause->tleSortGroupRef);
    Oid concrete_type = target == NULL
                          ? InvalidOid
                          : exprType((const Node *) target->expr);
    int32 concrete_typmod = target == NULL
                              ? -1
                              : exprTypmod((const Node *) target->expr);

    if (sort_group_clause_invokes_volatile_function(
          clause, execution, concrete_type, concrete_typmod))
    {
      return true;
    }
  }
  return false;
}

static bool
set_operation_support_invokes_volatile_function(const Node *node)
{
  if (node == NULL || IsA(node, RangeTblRef))
  {
    return false;
  }
  if (!IsA(node, SetOperationStmt))
  {
    return true;
  }

  {
    const SetOperationStmt *operation = (const SetOperationStmt *) node;
    ListCell *clause_cell;
    ListCell *type_cell;

    forboth(clause_cell, operation->groupClauses,
            type_cell, operation->colTypes)
    {
      const SortGroupClause *clause =
        lfirst_node(SortGroupClause, clause_cell);

      if (sort_group_clause_invokes_volatile_function(
            clause, SG_EXEC_SORT | SG_EXEC_EQUAL | SG_EXEC_HASH,
            lfirst_oid(type_cell), -1))
      {
        return true;
      }
    }

    return set_operation_support_invokes_volatile_function(operation->larg) ||
           set_operation_support_invokes_volatile_function(operation->rarg);
  }
}

static bool
query_sort_group_support_invokes_volatile_function(const Query *query)
{
  ListCell *cell;
  int distinct_execution = SG_EXEC_SORT | SG_EXEC_EQUAL;

  if (!query->hasDistinctOn)
  {
    distinct_execution |= SG_EXEC_HASH;
  }

  if (sort_group_clause_list_invokes_volatile_function(
        query->sortClause, SG_EXEC_SORT, query->targetList) ||
      sort_group_clause_list_invokes_volatile_function(
        query->groupClause, SG_EXEC_SORT | SG_EXEC_EQUAL | SG_EXEC_HASH,
        query->targetList) ||
      sort_group_clause_list_invokes_volatile_function(
        query->distinctClause, distinct_execution, query->targetList) ||
      set_operation_support_invokes_volatile_function(query->setOperations))
  {
    return true;
  }

  foreach(cell, query->windowClause)
  {
    const WindowClause *window = lfirst_node(WindowClause, cell);

    if (sort_group_clause_list_invokes_volatile_function(
          window->partitionClause, SG_EXEC_SORT | SG_EXEC_EQUAL,
          query->targetList) ||
        sort_group_clause_list_invokes_volatile_function(
          window->orderClause, SG_EXEC_SORT | SG_EXEC_EQUAL,
          query->targetList) ||
        (OidIsValid(window->startInRangeFunc) &&
         function_is_volatile(window->startInRangeFunc)) ||
        (OidIsValid(window->endInRangeFunc) &&
         function_is_volatile(window->endInRangeFunc)))
    {
      return true;
    }
  }
  return false;
}

static bool
domain_constraints_invoke_volatile_function(Oid type_oid)
{
  DomainConstraintRef *constraint_ref;
  ListCell *constraint_cell;

  constraint_ref = palloc0(sizeof(DomainConstraintRef));
  InitDomainConstraintRef(type_oid, constraint_ref, CurrentMemoryContext, false);

  foreach(constraint_cell, constraint_ref->constraints)
  {
    DomainConstraintState *constraint =
      lfirst_node(DomainConstraintState, constraint_cell);

    if (constraint->constrainttype == DOM_CONSTRAINT_CHECK &&
        volatile_function_walker((Node *) constraint->check_expr, NULL))
    {
      return true;
    }
  }
  return false;
}

typedef enum RuntimeTypeIoKind
{
  RUNTIME_TYPE_IO_TEXT_INPUT,
  RUNTIME_TYPE_IO_BINARY_RECEIVE,
  RUNTIME_TYPE_IO_TEXT_OUTPUT,
  RUNTIME_TYPE_IO_BINARY_SEND
} RuntimeTypeIoKind;

typedef struct RuntimeTypeIoKey
{
  Oid type_oid;
  int32 typmod;
  RuntimeTypeIoKind kind;
} RuntimeTypeIoKey;

typedef struct RuntimeTypeIoContext
{
  RuntimeTypeIoKey stack[MAX_RUNTIME_TYPE_SUPPORT_DEPTH];
  int depth;
} RuntimeTypeIoContext;

typedef struct RuntimeTypeIoResult
{
  bool supported;
  bool invokes_volatile;
} RuntimeTypeIoResult;

static RuntimeTypeIoResult
runtime_type_io_result(bool supported, bool invokes_volatile)
{
  RuntimeTypeIoResult result = {supported, invokes_volatile};

  return result;
}

static bool
runtime_type_io_is_input(RuntimeTypeIoKind kind)
{
  return kind == RUNTIME_TYPE_IO_TEXT_INPUT ||
         kind == RUNTIME_TYPE_IO_BINARY_RECEIVE;
}

static bool
runtime_type_io_is_output(RuntimeTypeIoKind kind)
{
  return kind == RUNTIME_TYPE_IO_TEXT_OUTPUT ||
         kind == RUNTIME_TYPE_IO_BINARY_SEND;
}

/*
 * Generic container I/O functions are declared immutable, but resolve their
 * nested type's I/O procedure at runtime.  Domain input adds another hidden
 * dependency by executing the domain constraints.  External parameters may
 * arrive in either text or binary format, while CoerceViaIO specifically uses
 * text output followed by text input.
 */
static RuntimeTypeIoResult
type_io_invokes_volatile(Oid type_oid, int32 typmod,
                         RuntimeTypeIoKind kind,
                         RuntimeTypeIoContext *context)
{
  HeapTuple tuple;
  Form_pg_type type;
  Oid io_function = InvalidOid;
  Oid nested_type = InvalidOid;
  int32 nested_typmod = -1;
  char type_kind;
  int stack_index;
  RuntimeTypeIoResult nested_result;

  if (!OidIsValid(type_oid) || context->depth >= MAX_RUNTIME_TYPE_SUPPORT_DEPTH)
  {
    return runtime_type_io_result(true, true);
  }
  for (stack_index = 0; stack_index < context->depth; stack_index++)
  {
    RuntimeTypeIoKey *key = &context->stack[stack_index];

    if (key->type_oid == type_oid && key->typmod == typmod &&
        key->kind == kind)
    {
      return runtime_type_io_result(true, true);
    }
  }
  context->stack[context->depth].type_oid = type_oid;
  context->stack[context->depth].typmod = typmod;
  context->stack[context->depth].kind = kind;
  context->depth++;

  tuple = SearchSysCache1(TYPEOID, ObjectIdGetDatum(type_oid));
  if (!HeapTupleIsValid(tuple))
  {
    context->depth--;
    return runtime_type_io_result(true, true);
  }
  type = (Form_pg_type) GETSTRUCT(tuple);
  type_kind = type->typtype;
  switch (kind)
  {
    case RUNTIME_TYPE_IO_TEXT_INPUT:
      io_function = type->typinput;
      break;
    case RUNTIME_TYPE_IO_BINARY_RECEIVE:
      io_function = type->typreceive;
      break;
    case RUNTIME_TYPE_IO_TEXT_OUTPUT:
      io_function = type->typoutput;
      break;
    case RUNTIME_TYPE_IO_BINARY_SEND:
      io_function = type->typsend;
      break;
  }
  ReleaseSysCache(tuple);

  if (!OidIsValid(io_function))
  {
    context->depth--;
    return runtime_type_io_result(false, false);
  }
  if (function_is_volatile(io_function))
  {
    context->depth--;
    return runtime_type_io_result(true, true);
  }

  if (type_kind == TYPTYPE_DOMAIN)
  {
    Oid base_type = getBaseTypeAndTypmod(type_oid, &typmod);

    if (runtime_type_io_is_input(kind) &&
        domain_constraints_invoke_volatile_function(type_oid))
    {
      context->depth--;
      return runtime_type_io_result(true, true);
    }
    if (!OidIsValid(base_type) || base_type == type_oid)
    {
      context->depth--;
      return runtime_type_io_result(true, true);
    }
    nested_type = base_type;
    nested_typmod = typmod;
  }
  else
  {
    Oid element_type = get_element_type(type_oid);

    if (OidIsValid(element_type))
    {
      nested_type = element_type;
      nested_typmod = runtime_type_io_is_output(kind) ? -1 : typmod;
    }
    else if (type_kind == TYPTYPE_COMPOSITE || type_oid == RECORDOID)
    {
      TupleDesc descriptor = lookup_rowtype_tupdesc_domain(
        type_oid, typmod, true);
      int attribute_index;

      if (descriptor == NULL)
      {
        context->depth--;
        return runtime_type_io_result(true, true);
      }
      for (attribute_index = 0;
           attribute_index < descriptor->natts;
           attribute_index++)
      {
        Form_pg_attribute attribute = TupleDescAttr(descriptor,
                                                    attribute_index);

        if (attribute->attisdropped)
        {
          continue;
        }
        nested_result = type_io_invokes_volatile(
          attribute->atttypid, attribute->atttypmod, kind, context);
        if (nested_result.invokes_volatile)
        {
          ReleaseTupleDesc(descriptor);
          context->depth--;
          return nested_result;
        }
        if (!nested_result.supported)
        {
          ReleaseTupleDesc(descriptor);
          context->depth--;
          return nested_result;
        }
      }
      ReleaseTupleDesc(descriptor);
      context->depth--;
      return runtime_type_io_result(true, false);
    }
    else if (type_kind == TYPTYPE_RANGE)
    {
      TypeCacheEntry *type_cache = lookup_type_cache(
        type_oid, TYPECACHE_RANGE_INFO);

      if (type_cache->rngelemtype == NULL)
      {
        context->depth--;
        return runtime_type_io_result(true, true);
      }
      if (runtime_type_io_is_input(kind) &&
          type_executor_support_invokes_volatile(
            type_oid, typmod,
            EXECUTOR_SUPPORT_COMPARE | EXECUTOR_SUPPORT_RANGE_CANONICAL))
      {
        context->depth--;
        return runtime_type_io_result(true, true);
      }
      nested_type = type_cache->rngelemtype->type_id;
    }
    else if (type_kind == TYPTYPE_MULTIRANGE)
    {
      TypeCacheEntry *type_cache = lookup_type_cache(
        type_oid, TYPECACHE_MULTIRANGE_INFO);

      if (type_cache->rngtype == NULL)
      {
        context->depth--;
        return runtime_type_io_result(true, true);
      }
      if (runtime_type_io_is_input(kind) &&
          type_executor_support_invokes_volatile(
            type_oid, typmod, EXECUTOR_SUPPORT_COMPARE))
      {
        context->depth--;
        return runtime_type_io_result(true, true);
      }
      nested_type = type_cache->rngtype->type_id;
    }
  }

  if (OidIsValid(nested_type))
  {
    nested_result = type_io_invokes_volatile(
      nested_type, nested_typmod, kind, context);
    context->depth--;
    return nested_result;
  }

  context->depth--;
  return runtime_type_io_result(true, false);
}

/* Check one protocol I/O procedure without following container contents. */
static RuntimeTypeIoResult
direct_type_io_invokes_volatile(Oid type_oid, RuntimeTypeIoKind kind)
{
  HeapTuple tuple;
  Form_pg_type type;
  Oid io_function = InvalidOid;

  if (!OidIsValid(type_oid))
  {
    return runtime_type_io_result(true, true);
  }
  tuple = SearchSysCache1(TYPEOID, ObjectIdGetDatum(type_oid));
  if (!HeapTupleIsValid(tuple))
  {
    return runtime_type_io_result(true, true);
  }
  type = (Form_pg_type) GETSTRUCT(tuple);
  switch (kind)
  {
    case RUNTIME_TYPE_IO_TEXT_INPUT:
      io_function = type->typinput;
      break;
    case RUNTIME_TYPE_IO_BINARY_RECEIVE:
      io_function = type->typreceive;
      break;
    case RUNTIME_TYPE_IO_TEXT_OUTPUT:
      io_function = type->typoutput;
      break;
    case RUNTIME_TYPE_IO_BINARY_SEND:
      io_function = type->typsend;
      break;
  }
  ReleaseSysCache(tuple);

  if (!OidIsValid(io_function))
  {
    return runtime_type_io_result(false, false);
  }
  return runtime_type_io_result(true, function_is_volatile(io_function));
}

static RuntimeTypeIoResult result_expression_io_invokes_volatile(
  const Node *expression, RuntimeTypeIoKind kind);

typedef struct RuntimeTypeIoValueContext
{
  int depth;
} RuntimeTypeIoValueContext;

static bool
array_value_io_invokes_element_io(Oid array_type, RuntimeTypeIoKind kind)
{
  /*
   * int2vectorout and oidvectorout format their values directly, while their
   * send functions delegate to array_send.
   */
  return kind == RUNTIME_TYPE_IO_BINARY_SEND ||
         (array_type != INT2VECTOROID && array_type != OIDVECTOROID);
}

static RuntimeTypeIoResult
datum_io_invokes_volatile(Datum value, bool is_null, Oid type_oid,
                          int32 typmod, RuntimeTypeIoKind kind,
                          RuntimeTypeIoValueContext *context)
{
  RuntimeTypeIoResult direct_result;
  Oid base_type;
  Oid element_type;
  char type_kind;

  if (is_null)
  {
    return runtime_type_io_result(true, false);
  }
  if (!OidIsValid(type_oid) || context->depth >= MAX_RUNTIME_TYPE_SUPPORT_DEPTH)
  {
    return runtime_type_io_result(true, true);
  }

  direct_result = direct_type_io_invokes_volatile(type_oid, kind);
  if (!direct_result.supported || direct_result.invokes_volatile)
  {
    return direct_result;
  }
  if (!runtime_type_io_is_output(kind))
  {
    return runtime_type_io_result(true, true);
  }

  base_type = getBaseTypeAndTypmod(type_oid, &typmod);
  if (!OidIsValid(base_type))
  {
    return runtime_type_io_result(true, true);
  }
  element_type = get_element_type(base_type);
  type_kind = get_typtype(base_type);
  context->depth++;

  if (OidIsValid(element_type) &&
      array_value_io_invokes_element_io(base_type, kind))
  {
    ArrayType *array = DatumGetArrayTypeP(value);
    Datum *element_values;
    bool *element_nulls;
    int element_count;
    int16 element_length;
    bool element_by_value;
    char element_alignment;
    int index;

    if (ARR_ELEMTYPE(array) != element_type)
    {
      context->depth--;
      return runtime_type_io_result(true, true);
    }
    get_typlenbyvalalign(element_type, &element_length, &element_by_value,
                        &element_alignment);
    deconstruct_array(array, element_type, element_length, element_by_value,
                      element_alignment, &element_values, &element_nulls,
                      &element_count);
    for (index = 0; index < element_count; index++)
    {
      RuntimeTypeIoResult element_result = datum_io_invokes_volatile(
        element_values[index], element_nulls[index], element_type, -1, kind,
        context);

      if (!element_result.supported || element_result.invokes_volatile)
      {
        pfree(element_values);
        pfree(element_nulls);
        context->depth--;
        return element_result;
      }
    }
    pfree(element_values);
    pfree(element_nulls);
  }
  else if (type_kind == TYPTYPE_COMPOSITE || base_type == RECORDOID)
  {
    HeapTupleHeader record = DatumGetHeapTupleHeader(value);
    Oid record_type = HeapTupleHeaderGetTypeId(record);
    int32 record_typmod = HeapTupleHeaderGetTypMod(record);
    TupleDesc descriptor = lookup_rowtype_tupdesc(record_type, record_typmod);
    HeapTupleData tuple;
    Datum *field_values;
    bool *field_nulls;
    int index;

    tuple.t_len = HeapTupleHeaderGetDatumLength(record);
    ItemPointerSetInvalid(&tuple.t_self);
    tuple.t_tableOid = InvalidOid;
    tuple.t_data = record;
    field_values = palloc(sizeof(Datum) * descriptor->natts);
    field_nulls = palloc(sizeof(bool) * descriptor->natts);
    heap_deform_tuple(&tuple, descriptor, field_values, field_nulls);

    for (index = 0; index < descriptor->natts; index++)
    {
      Form_pg_attribute attribute = TupleDescAttr(descriptor, index);
      RuntimeTypeIoResult field_result;

      if (attribute->attisdropped || field_nulls[index])
      {
        continue;
      }
      field_result = datum_io_invokes_volatile(
        field_values[index], false, attribute->atttypid, attribute->atttypmod,
        kind, context);
      if (!field_result.supported || field_result.invokes_volatile)
      {
        pfree(field_values);
        pfree(field_nulls);
        ReleaseTupleDesc(descriptor);
        context->depth--;
        return field_result;
      }
    }
    pfree(field_values);
    pfree(field_nulls);
    ReleaseTupleDesc(descriptor);
  }
  else if (type_kind == TYPTYPE_RANGE)
  {
    RangeType *range = DatumGetRangeTypeP(value);
    TypeCacheEntry *type_cache = lookup_type_cache(
      RangeTypeGetOid(range), TYPECACHE_RANGE_INFO);
    RangeBound lower;
    RangeBound upper;
    bool empty;

    if (type_cache->rngelemtype == NULL)
    {
      context->depth--;
      return runtime_type_io_result(true, true);
    }
    range_deserialize(type_cache, range, &lower, &upper, &empty);
    if (!empty && !lower.infinite)
    {
      RuntimeTypeIoResult lower_result = datum_io_invokes_volatile(
        lower.val, false, type_cache->rngelemtype->type_id, -1, kind, context);

      if (!lower_result.supported || lower_result.invokes_volatile)
      {
        context->depth--;
        return lower_result;
      }
    }
    if (!empty && !upper.infinite)
    {
      RuntimeTypeIoResult upper_result = datum_io_invokes_volatile(
        upper.val, false, type_cache->rngelemtype->type_id, -1, kind, context);

      if (!upper_result.supported || upper_result.invokes_volatile)
      {
        context->depth--;
        return upper_result;
      }
    }
  }
  else if (type_kind == TYPTYPE_MULTIRANGE)
  {
    MultirangeType *multirange = DatumGetMultirangeTypeP(value);
    TypeCacheEntry *type_cache = lookup_type_cache(
      MultirangeTypeGetOid(multirange), TYPECACHE_MULTIRANGE_INFO);
    RangeType **ranges;
    int32 range_count;
    int32 index;

    if (type_cache->rngtype == NULL)
    {
      context->depth--;
      return runtime_type_io_result(true, true);
    }
    multirange_deserialize(type_cache->rngtype, multirange, &range_count,
                           &ranges);
    for (index = 0; index < range_count; index++)
    {
      RuntimeTypeIoResult range_result = datum_io_invokes_volatile(
        RangeTypePGetDatum(ranges[index]), false,
        type_cache->rngtype->type_id, -1, kind, context);

      if (!range_result.supported || range_result.invokes_volatile)
      {
        pfree(ranges);
        context->depth--;
        return range_result;
      }
    }
    if (ranges != NULL)
    {
      pfree(ranges);
    }
  }

  context->depth--;
  return runtime_type_io_result(true, false);
}

static RuntimeTypeIoResult
array_expression_elements_io_invoke_volatile(const ArrayExpr *array,
                                             RuntimeTypeIoKind kind)
{
  ListCell *cell;

  foreach(cell, array->elements)
  {
    const Node *element = (const Node *) lfirst(cell);
    RuntimeTypeIoResult element_result;

    if (array->multidims)
    {
      if (element == NULL || !IsA(element, ArrayExpr))
      {
        return runtime_type_io_result(true, true);
      }
      element_result = array_expression_elements_io_invoke_volatile(
        (const ArrayExpr *) element, kind);
    }
    else
    {
      element_result = result_expression_io_invokes_volatile(element, kind);
    }
    if (!element_result.supported || element_result.invokes_volatile)
    {
      return element_result;
    }
  }
  return runtime_type_io_result(true, false);
}

/*
 * Anonymous records carry a runtime typmod that is not present in the parsed
 * expression.  RowExpr and ArrayExpr still expose their concrete contents,
 * so follow those shapes instead of treating every anonymous row as opaque.
 */
static RuntimeTypeIoResult
result_expression_io_invokes_volatile(const Node *expression,
                                      RuntimeTypeIoKind kind)
{
  RuntimeTypeIoContext context = {0};
  RuntimeTypeIoValueContext value_context = {0};

  if (expression == NULL)
  {
    return runtime_type_io_result(true, true);
  }
  if (IsA(expression, Const))
  {
    const Const *constant = (const Const *) expression;

    return datum_io_invokes_volatile(
      constant->constvalue, constant->constisnull, constant->consttype,
      constant->consttypmod, kind, &value_context);
  }
  if (IsA(expression, ArrayExpr))
  {
    const ArrayExpr *array = (const ArrayExpr *) expression;
    RuntimeTypeIoResult direct_result = direct_type_io_invokes_volatile(
      array->array_typeid, kind);

    if (!direct_result.supported || direct_result.invokes_volatile)
    {
      return direct_result;
    }
    return array_expression_elements_io_invoke_volatile(array, kind);
  }
  if (IsA(expression, RowExpr) && exprType(expression) == RECORDOID &&
      exprTypmod(expression) < 0)
  {
    const RowExpr *row = (const RowExpr *) expression;
    RuntimeTypeIoResult direct_result = direct_type_io_invokes_volatile(
      RECORDOID, kind);
    ListCell *cell;

    if (!direct_result.supported || direct_result.invokes_volatile)
    {
      return direct_result;
    }
    foreach(cell, row->args)
    {
      RuntimeTypeIoResult field_result =
        result_expression_io_invokes_volatile(
          (const Node *) lfirst(cell), kind);

      if (!field_result.supported || field_result.invokes_volatile)
      {
        return field_result;
      }
    }
    return runtime_type_io_result(true, false);
  }
  return type_io_invokes_volatile(
    exprType(expression), exprTypmod(expression), kind, &context);
}

static bool
query_result_io_invokes_volatile(const Query *query)
{
  const List *targets = query->commandType == CMD_SELECT
                          ? query->targetList
                          : query->returningList;
  ListCell *cell;

  foreach(cell, targets)
  {
    const TargetEntry *target = lfirst_node(TargetEntry, cell);
    RuntimeTypeIoResult text_result;
    RuntimeTypeIoResult binary_result;

    if (target->resjunk)
    {
      continue;
    }
    text_result = result_expression_io_invokes_volatile(
      (const Node *) target->expr, RUNTIME_TYPE_IO_TEXT_OUTPUT);
    binary_result = result_expression_io_invokes_volatile(
      (const Node *) target->expr, RUNTIME_TYPE_IO_BINARY_SEND);
    if (text_result.invokes_volatile ||
        (binary_result.supported && binary_result.invokes_volatile))
    {
      return true;
    }
  }
  return false;
}

static bool
external_parameter_io_invokes_volatile(Oid type_oid, int32 typmod)
{
  RuntimeTypeIoContext text_context = {0};
  RuntimeTypeIoContext binary_context = {0};
  RuntimeTypeIoResult text_result = type_io_invokes_volatile(
    type_oid, typmod, RUNTIME_TYPE_IO_TEXT_INPUT, &text_context);
  RuntimeTypeIoResult binary_result = type_io_invokes_volatile(
    type_oid, typmod, RUNTIME_TYPE_IO_BINARY_RECEIVE, &binary_context);

  return text_result.invokes_volatile ||
         (binary_result.supported && binary_result.invokes_volatile);
}

static bool
parameter_bind_io_invokes_volatile(const Oid *param_types, int param_count)
{
  int index;

  for (index = 0; index < param_count; index++)
  {
    if (external_parameter_io_invokes_volatile(param_types[index], -1))
    {
      return true;
    }
  }
  return false;
}

static bool
xml_type_conversion_invokes_volatile(Oid type_oid, int32 typmod)
{
  Oid element_type = get_base_element_type(type_oid);
  Oid base_type;
  RuntimeTypeIoContext context = {0};
  RuntimeTypeIoResult output_result;

  /* SQL/XML maps arrays element-by-element instead of invoking array_out. */
  if (OidIsValid(element_type))
  {
    return xml_type_conversion_invokes_volatile(element_type, -1);
  }

  base_type = getBaseTypeAndTypmod(type_oid, &typmod);
  switch (base_type)
  {
    /* map_sql_value_to_xml_value has native XSD encodings for these types. */
    case BOOLOID:
    case DATEOID:
    case TIMESTAMPOID:
    case TIMESTAMPTZOID:
#ifdef USE_LIBXML
    case BYTEAOID:
#endif
      return false;
    default:
      break;
  }

  output_result = type_io_invokes_volatile(
    base_type, typmod, RUNTIME_TYPE_IO_TEXT_OUTPUT, &context);
  return !output_result.supported || output_result.invokes_volatile;
}

static bool
xml_conversion_args_invoke_volatile(const List *args)
{
  ListCell *cell;

  foreach(cell, args)
  {
    const Node *argument = (const Node *) lfirst(cell);

    if (argument == NULL ||
        xml_type_conversion_invokes_volatile(
          exprType(argument), exprTypmod(argument)))
    {
      return true;
    }
  }
  return false;
}

static bool
xml_expression_invokes_volatile(const XmlExpr *expression)
{
  switch (expression->op)
  {
    case IS_XMLELEMENT:
      return xml_conversion_args_invoke_volatile(expression->named_args) ||
             xml_conversion_args_invoke_volatile(expression->args);
    case IS_XMLFOREST:
      return xml_conversion_args_invoke_volatile(expression->named_args);
    default:
      return false;
  }
}

static bool
operator_operand_is_execution_relevant_walker(Node *node, void *context)
{
  const PtsQueryScope *scope = (const PtsQueryScope *) context;

  if (node == NULL)
  {
    return false;
  }
  if (IsA(node, Param))
  {
    return ((const Param *) node)->paramkind == PARAM_SUBLINK;
  }
  if (IsA(node, Var))
  {
    const Var *variable = (const Var *) node;
    const PtsQueryScope *owner_scope = pts_query_scope_at_level(
      scope, variable->varlevelsup);

    if (owner_scope != NULL && variable->varno > 0 &&
        variable->varno <= list_length(owner_scope->query->rtable))
    {
      const RangeTblEntry *rte = rt_fetch(
        variable->varno, owner_scope->query->rtable);

      return rte->rtekind != RTE_RESULT;
    }
    return false;
  }
  if (IsA(node, Query))
  {
    return false;
  }
  return expression_tree_walker(
    node, operator_operand_is_execution_relevant_walker, context);
}

static bool
operator_expr_has_execution_relevant_operand(Node *node,
                                             const PtsQueryScope *scope)
{
  return operator_operand_is_execution_relevant_walker(node, (void *) scope);
}

static bool
operator_family_support_type_pair_is_relevant(const Form_pg_amop operator_form,
                                              const Form_pg_amproc support_form)
{
  if (operator_form->amopmethod == BTREE_AM_OID)
  {
    return (support_form->amprocnum == BTORDER_PROC ||
            support_form->amprocnum == BTSORTSUPPORT_PROC) &&
           support_form->amproclefttype == operator_form->amoplefttype &&
           support_form->amprocrighttype == operator_form->amoprighttype;
  }
  if (operator_form->amopmethod == HASH_AM_OID)
  {
    return (support_form->amprocnum == HASHSTANDARD_PROC ||
            support_form->amprocnum == HASHEXTENDED_PROC) &&
           support_form->amproclefttype == support_form->amprocrighttype &&
           (support_form->amproclefttype == operator_form->amoplefttype ||
            support_form->amproclefttype == operator_form->amoprighttype);
  }

  /* Unknown access methods keep their existing conservative closure. */
  return true;
}

static bool
operator_family_support_invokes_volatile_function(Oid operator_oid)
{
  CatCList *operator_memberships;
  int operator_index;
  bool invokes_volatile = false;

  operator_memberships = SearchSysCacheList1(
    AMOPOPID, ObjectIdGetDatum(operator_oid));
  for (operator_index = 0;
       operator_index < operator_memberships->n_members && !invokes_volatile;
       operator_index++)
  {
    HeapTuple operator_tuple =
      &operator_memberships->members[operator_index]->tuple;
    Form_pg_amop operator_form =
      (Form_pg_amop) GETSTRUCT(operator_tuple);
    CatCList *support_functions = SearchSysCacheList1(
      AMPROCNUM, ObjectIdGetDatum(operator_form->amopfamily));
    int support_index;

    for (support_index = 0;
         support_index < support_functions->n_members;
         support_index++)
    {
      HeapTuple support_tuple =
        &support_functions->members[support_index]->tuple;
      Form_pg_amproc support_form =
        (Form_pg_amproc) GETSTRUCT(support_tuple);

      if (operator_family_support_type_pair_is_relevant(operator_form,
                                                        support_form) &&
          OidIsValid(support_form->amproc) &&
          function_is_volatile(support_form->amproc))
      {
        invokes_volatile = true;
        break;
      }
    }
    ReleaseSysCacheList(support_functions);
  }
  ReleaseSysCacheList(operator_memberships);
  return invokes_volatile;
}

static bool
node_invokes_volatile_function(Node *node, const PtsQueryScope *scope)
{
  switch (nodeTag(node))
  {
    case T_Aggref:
    {
      Aggref *aggregate = (Aggref *) node;

      return aggregate_invokes_volatile_function(
               aggregate->aggfnoid, aggregate->args, true,
               AGG_EXECUTION_NONWINDOW,
               aggregate->aggtype, exprTypmod(node)) ||
             json_aggregate_args_invoke_volatile(
               aggregate->aggfnoid, aggregate->args) ||
             sort_group_clause_list_invokes_volatile_function(
               aggregate->aggorder, SG_EXEC_SORT, aggregate->args) ||
             sort_group_clause_list_invokes_volatile_function(
               aggregate->aggdistinct, SG_EXEC_SORT | SG_EXEC_EQUAL,
               aggregate->args);
    }
    case T_WindowFunc:
    {
      WindowFunc *function = (WindowFunc *) node;

      return function->winagg
               ? aggregate_invokes_volatile_function(
                   function->winfnoid, function->args, false,
                   window_aggregate_execution_profile(function, scope),
                   function->wintype, exprTypmod(node))
               : function_is_volatile(function->winfnoid);
    }
    case T_FuncExpr:
    {
      FuncExpr *function = (FuncExpr *) node;

      return function_is_volatile(function->funcid) ||
             json_function_args_invoke_volatile(
               function->funcid, function->args) ||
             executor_support_dependency_invokes_volatile(
               function->funcid, function->args, false,
               function->funcresulttype, exprTypmod(node));
    }
    case T_JsonConstructorExpr:
      return json_constructor_args_invoke_volatile(
        (const JsonConstructorExpr *) node);
    case T_XmlExpr:
      return xml_expression_invokes_volatile((const XmlExpr *) node);
    case T_OpExpr:
    case T_DistinctExpr:
    case T_NullIfExpr:
    {
      OpExpr *expr = (OpExpr *) node;
      Oid function_oid = OidIsValid(expr->opfuncid) ? expr->opfuncid : get_opcode(expr->opno);

      bool inspect_support = operator_expr_has_execution_relevant_operand(
        node, scope);

      return function_is_volatile(function_oid) ||
             executor_support_dependency_invokes_volatile(
               function_oid, expr->args, false,
               expr->opresulttype, exprTypmod(node)) ||
             (inspect_support &&
              (operator_family_support_invokes_volatile_function(expr->opno) ||
               operator_argument_support_invokes_volatile(expr->args)));
    }
    case T_ScalarArrayOpExpr:
    {
      ScalarArrayOpExpr *expr = (ScalarArrayOpExpr *) node;
      Oid function_oid = OidIsValid(expr->opfuncid) ? expr->opfuncid : get_opcode(expr->opno);
      const Node *array_argument = list_length(expr->args) == 2
                                     ? (const Node *) lsecond(expr->args)
                                     : NULL;
      PtsArrayShape array_shape = pts_array_shape_proof(array_argument);

      if (array_shape.proof == PTS_ARRAY_SHAPE_VALID &&
          (array_shape.is_null || array_shape.nitems == 0))
      {
        return false;
      }

      return function_is_volatile(function_oid) ||
             executor_support_dependency_invokes_volatile(
               function_oid, expr->args, false,
               exprType(node), exprTypmod(node)) ||
             scalar_array_hash_support_invokes_volatile(expr) ||
             (operator_expr_has_execution_relevant_operand(node, scope) &&
              (operator_family_support_invokes_volatile_function(expr->opno) ||
               operator_argument_support_invokes_volatile(expr->args)));
    }
    case T_CoerceViaIO:
    {
      CoerceViaIO *expr = (CoerceViaIO *) node;
      RuntimeTypeIoContext input_context = {0};
      RuntimeTypeIoContext output_context = {0};
      RuntimeTypeIoResult input_result = type_io_invokes_volatile(
        expr->resulttype, exprTypmod(node), RUNTIME_TYPE_IO_TEXT_INPUT,
        &input_context);
      RuntimeTypeIoResult output_result = type_io_invokes_volatile(
        exprType((Node *) expr->arg), exprTypmod((Node *) expr->arg),
        RUNTIME_TYPE_IO_TEXT_OUTPUT, &output_context);

      return !input_result.supported || !output_result.supported ||
             input_result.invokes_volatile ||
             output_result.invokes_volatile;
    }
    case T_CoerceToDomain:
      return domain_constraints_invoke_volatile_function(
        ((CoerceToDomain *) node)->resulttype);
    case T_RowCompareExpr:
    {
      RowCompareExpr *row_compare = (RowCompareExpr *) node;
      ListCell *operator_cell;
      ListCell *left_cell;
      ListCell *right_cell;
      bool inspect_support = operator_expr_has_execution_relevant_operand(
        node, scope);

      forthree(operator_cell, row_compare->opnos,
               left_cell, row_compare->largs,
               right_cell, row_compare->rargs)
      {
        Oid operator_oid = lfirst_oid(operator_cell);
        Oid function_oid = get_opcode(operator_oid);
        List *arguments = list_make2(lfirst(left_cell), lfirst(right_cell));
        bool container_invokes_volatile =
          executor_support_dependency_invokes_volatile(
            function_oid, arguments, false,
            BOOLOID, -1);

        list_free(arguments);

        if (function_is_volatile(function_oid) ||
            container_invokes_volatile ||
            (inspect_support &&
             operator_family_support_invokes_volatile_function(operator_oid)))
        {
          return true;
        }
      }
      return false;
    }
    case T_MinMaxExpr:
    {
      MinMaxExpr *minmax = (MinMaxExpr *) node;
      RuntimeTypeSupportContext support_context = {0};

      return list_length(minmax->args) >= 2 &&
             type_runtime_support_invokes_volatile(
               minmax->minmaxtype, exprTypmod(node), RUNTIME_SUPPORT_COMPARE,
               &support_context);
    }
    case T_NextValueExpr:
      return true;
    default:
      return false;
  }
}

static bool
volatile_function_walker(Node *node, void *context)
{
  VolatileFunctionContext *volatile_context =
    (VolatileFunctionContext *) context;

  if (node == NULL)
  {
    return false;
  }
  if (IsA(node, Query))
  {
    return false;
  }
  if (node_invokes_volatile_function(
        node, volatile_context == NULL ? NULL : volatile_context->scope))
  {
    return true;
  }
  return expression_tree_walker(node, volatile_function_walker, context);
}

static bool
query_contains_volatile_functions_visitor(const PtsQueryScope *scope,
                                          void *context)
{
  VolatileFunctionContext volatile_context = {scope};

  (void) context;
  return query_sort_group_support_invokes_volatile_function(scope->query) ||
         query_tree_walker(
           (Query *) scope->query, volatile_function_walker,
           &volatile_context, QTW_IGNORE_CTE_SUBQUERIES);
}

static bool
query_contains_volatile_functions(const Query *query)
{
  return pts_execution_reachable_query_walker(
    query, query_contains_volatile_functions_visitor, NULL);
}

static bool
query_contains_row_marks_visitor(const PtsQueryScope *scope, void *context)
{
  (void) context;
  return scope->query->rowMarks != NIL;
}

static bool
query_contains_row_marks(const Query *query)
{
  return pts_execution_reachable_query_walker(
    query, query_contains_row_marks_visitor, NULL);
}

static void
append_query_summary(StringInfo out, const Query *query,
                     const PtsQueryScope *parent_scope, int depth,
                     bool protocol_output,
                     bool bind_io_invokes_volatile)
{
  PtsQueryScope *scope = pts_make_query_scope(query, parent_scope);
  bool has_volatile_functions = bind_io_invokes_volatile ||
                                query_contains_volatile_functions(query) ||
                                (protocol_output &&
                                 query_result_io_invokes_volatile(query));

  appendStringInfoString(out, "{\"commandType\":");
  append_json_string(out, command_type_name(query->commandType));
  appendStringInfoString(out, ",\"utilityKind\":");
  append_json_string(out, utility_kind_name(query->utilityStmt));
  append_bool_field(
    out, "utilityReturnsTuples",
    utility_returns_tuples_stably(query->utilityStmt));
  appendStringInfo(out, ",\"querySource\":%d,\"canSetTag\":%s",
                   query->querySource, query->canSetTag ? "true" : "false");
  appendStringInfo(out, ",\"resultRelation\":%d", query->resultRelation);
  append_bool_field(out, "hasAggs", query->hasAggs);
  append_bool_field(out, "hasWindowFuncs", query->hasWindowFuncs);
  append_bool_field(out, "hasTargetSRFs", query->hasTargetSRFs);
  append_bool_field(out, "hasSubLinks", query->hasSubLinks);
  append_bool_field(out, "hasModifyingCTE", query->hasModifyingCTE);
  append_bool_field(out, "hasRowSecurity", query->hasRowSecurity);
  append_bool_field(out, "hasRowMarks", query_contains_row_marks(query));
  append_bool_field(out, "hasVolatileFunctions", has_volatile_functions);
  append_list_count_field(out, "groupClauseCount", query->groupClause);
  append_list_count_field(out, "groupingSetsCount", query->groupingSets);
  append_list_count_field(out, "distinctClauseCount", query->distinctClause);
  append_bool_field(out, "hasHavingQual", query->havingQual != NULL);
  append_bool_field(out, "hasLimitOffset", query->limitOffset != NULL);
  append_bool_field(out, "hasLimitCount", query->limitCount != NULL);
  append_bool_field(out, "limitWithTies", query->limitOption == LIMIT_OPTION_WITH_TIES);
  append_bool_field(out, "hasSetOperations", query->setOperations != NULL);
  appendStringInfoString(out, ",\"setOperation\":");
  append_set_operation(out, query->setOperations);
  appendStringInfoString(out, ",\"limitCount\":");
  append_expr_node(out, scope, query->limitCount, depth);
  appendStringInfoChar(out, ',');
  append_target_list(out, scope);
  append_returning_list(out, scope);
  pts_append_dml_analysis(out, query);
  append_cte_list(out, scope, depth);
  append_rtable(out, scope, depth);
  appendStringInfoString(out, ",\"fromTree\":");
  append_from_node(out, scope, (const Node *) query->jointree, depth);
  appendStringInfoString(out, ",\"whereQual\":");
  if (query->jointree == NULL)
  {
    appendStringInfoString(out, "null");
  }
  else
  {
    append_expr_node(out, scope, query->jointree->quals, depth);
  }
  appendStringInfoChar(out, '}');
}

static void
append_param_type_null_admissions(StringInfo out, const Oid *param_types,
                                  int param_count)
{
  PtsNullAdmissionAnalysis *analysis;
  int index;

  analysis = pts_create_null_admission_analysis();

  appendStringInfoString(out, ",\"paramTypeNullAdmissions\":[");
  for (index = 0; index < param_count; index++)
  {
    if (index > 0)
    {
      appendStringInfoChar(out, ',');
    }
    append_json_string(out, pts_null_admission_name(
      OidIsValid(param_types[index])
        ? pts_type_null_admission(analysis, param_types[index])
        : PTS_NULL_UNKNOWN));
  }
  appendStringInfoChar(out, ']');
  pts_destroy_null_admission_analysis(analysis);
}

static void
append_param_usage_null_admissions(StringInfo out,
                                   const PtsParameterUsageEvidence *evidence,
                                   int param_count)
{
  int index;

  appendStringInfoString(out, ",\"paramUsageNullAdmissions\":[");
  for (index = 0; index < param_count; index++)
  {
    if (index > 0)
    {
      appendStringInfoChar(out, ',');
    }
    append_json_string(
      out,
      pts_null_admission_name(evidence[index].seen
                            ? evidence[index].admission
                            : PTS_NULL_UNKNOWN));
  }
  appendStringInfoChar(out, ']');
}

Datum
postgres_typed_sql_analyze(PG_FUNCTION_ARGS)
{
  text *sql_text = PG_GETARG_TEXT_PP(0);
  char *sql = text_to_cstring(sql_text);
  int param_count = 0;
  Oid *param_types = NULL;
  List *raw_trees = pg_parse_query(sql);
  PtsParameterUsageEvidence *param_usage_evidence = NULL;
  int param_usage_count = 0;
  PtsNullAdmissionAnalysis *usage_null_admission_analysis;
  StringInfoData out;
  ListCell *raw_cell;
  bool first_raw = true;

  usage_null_admission_analysis = pts_create_null_admission_analysis();

  initStringInfo(&out);
  appendStringInfoString(&out, "{\"schemaVersion\":10,\"postgresVersionNum\":");
  appendStringInfo(&out, "%d", PG_VERSION_NUM);
  appendStringInfoString(&out, ",\"rawStatementCount\":");
  appendStringInfo(&out, "%d", list_length(raw_trees));
  appendStringInfoString(&out, ",\"statements\":[");

  foreach(raw_cell, raw_trees)
  {
    RawStmt *raw_stmt = lfirst_node(RawStmt, raw_cell);
    List *rewritten_queries =
      pg_analyze_and_rewrite_varparams(raw_stmt, sql, &param_types,
                                       &param_count, NULL);
    bool bind_io_invokes_volatile =
      parameter_bind_io_invokes_volatile(param_types, param_count);
    ListCell *query_cell;
    bool first_query = true;

    if (param_usage_count < param_count)
    {
      int index;

      param_usage_evidence = param_usage_evidence == NULL
                               ? palloc(sizeof(PtsParameterUsageEvidence) * param_count)
                               : repalloc(param_usage_evidence,
                                          sizeof(PtsParameterUsageEvidence) * param_count);
      for (index = param_usage_count; index < param_count; index++)
      {
        param_usage_evidence[index].seen = false;
        param_usage_evidence[index].admission = PTS_NULL_UNKNOWN;
      }
      param_usage_count = param_count;
    }

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

      pts_update_parameter_usage_null_admissions(query, param_usage_evidence,
                                                 param_count,
                                                 usage_null_admission_analysis);

      if (!first_query)
      {
        appendStringInfoChar(&out, ',');
      }
      first_query = false;

      append_query_summary(&out, query, NULL, 10, true,
                           bind_io_invokes_volatile);
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
  appendStringInfoChar(&out, ']');
  append_param_type_null_admissions(&out, param_types, param_count);
  append_param_usage_null_admissions(&out, param_usage_evidence,
                                     param_count);
  appendStringInfoChar(&out, '}');

  pts_destroy_null_admission_analysis(usage_null_admission_analysis);
  if (param_usage_evidence != NULL)
  {
    pfree(param_usage_evidence);
  }

  PG_RETURN_TEXT_P(cstring_to_text(out.data));
}
