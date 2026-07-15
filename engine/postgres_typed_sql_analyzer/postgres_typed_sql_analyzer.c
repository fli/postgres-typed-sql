#include "postgres.h"

#include "access/table.h"
#include "catalog/pg_aggregate.h"
#include "catalog/pg_attribute.h"
#include "catalog/pg_class.h"
#include "catalog/pg_constraint.h"
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
#include "parser/parsetree.h"
#include "tcop/tcopprot.h"
#include "utils/array.h"
#include "utils/builtins.h"
#include "utils/hsearch.h"
#include "utils/jsonb.h"
#include "utils/lsyscache.h"
#include "utils/rel.h"
#include "utils/relcache.h"
#include "utils/syscache.h"
#include "utils/typcache.h"

PG_MODULE_MAGIC;

PG_FUNCTION_INFO_V1(postgres_typed_sql_analyze);

typedef struct QueryScope QueryScope;

static void append_expr_node(StringInfo out, const QueryScope *scope, const Node *expr, int depth);
static void append_query_summary(StringInfo out, const Query *query, const QueryScope *parent_scope, int depth);
static void append_from_node(StringInfo out, const QueryScope *scope, const Node *node, int depth);
static void append_rtable(StringInfo out, const QueryScope *scope, int depth);
static void append_set_operation(StringInfo out, const Node *node);
static const char *command_type_name(CmdType command_type);
static void append_json_string(StringInfo out, const char *value);
static void append_bool_field(StringInfo out, const char *name, bool value);
static void append_oid_field(StringInfo out, const char *name, Oid value);
static void append_optional_name_field(StringInfo out, const char *name, const char *value);
static bool query_contains_volatile_functions(const Query *query);
static bool volatile_function_walker(Node *node, void *context);
static bool query_contains_row_marks(const Query *query);
static bool row_marks_walker(Node *node, void *context);

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

struct QueryScope
{
  const Query *query;
  const struct QueryScope *parent;
};

typedef enum NullProof
{
  NULL_PROOF_NULL,
  NULL_PROOF_TRUE,
  NULL_PROOF_FALSE,
  NULL_PROOF_NONNULL,
  NULL_PROOF_UNKNOWN
} NullProof;

typedef enum TypeNullAdmission
{
  TYPE_NULL_ADMITS,
  TYPE_NULL_REJECTS,
  TYPE_NULL_UNKNOWN
} TypeNullAdmission;

typedef enum ArrayCardinalityProof
{
  ARRAY_CARDINALITY_EMPTY,
  ARRAY_CARDINALITY_NONEMPTY,
  ARRAY_CARDINALITY_UNKNOWN
} ArrayCardinalityProof;

static ArrayCardinalityProof
array_cardinality_proof(const Node *node)
{
  if (node == NULL)
  {
    return ARRAY_CARDINALITY_UNKNOWN;
  }
  if (IsA(node, Const))
  {
    const Const *constant = (const Const *) node;
    ArrayType *value;

    if (constant->constisnull)
    {
      return ARRAY_CARDINALITY_UNKNOWN;
    }
    value = DatumGetArrayTypeP(constant->constvalue);
    return ArrayGetNItems(ARR_NDIM(value), ARR_DIMS(value)) == 0
             ? ARRAY_CARDINALITY_EMPTY
             : ARRAY_CARDINALITY_NONEMPTY;
  }
  if (IsA(node, ArrayExpr))
  {
    const ArrayExpr *array = (const ArrayExpr *) node;
    ListCell *cell;
    bool saw_unknown = false;

    if (array->elements == NIL)
    {
      return ARRAY_CARDINALITY_EMPTY;
    }
    if (!array->multidims)
    {
      return ARRAY_CARDINALITY_NONEMPTY;
    }
    foreach(cell, array->elements)
    {
      ArrayCardinalityProof child =
        array_cardinality_proof((const Node *) lfirst(cell));

      if (child == ARRAY_CARDINALITY_NONEMPTY)
      {
        return ARRAY_CARDINALITY_NONEMPTY;
      }
      if (child == ARRAY_CARDINALITY_UNKNOWN)
      {
        saw_unknown = true;
      }
    }
    return saw_unknown ? ARRAY_CARDINALITY_UNKNOWN : ARRAY_CARDINALITY_EMPTY;
  }
  return ARRAY_CARDINALITY_UNKNOWN;
}

typedef struct DmlParameterTargetKey
{
  int param_id;
  Oid target_relid;
  AttrNumber target_attnum;
  const char *source;
  TypeNullAdmission target_null_admission;
  bool direct_assignment;
} DmlParameterTargetKey;

typedef struct TypeNullAdmissionEntry
{
  Oid type_oid;
  TypeNullAdmission admission;
} TypeNullAdmissionEntry;

typedef struct ColumnNullAdmissionKey
{
  Oid relid;
  AttrNumber attnum;
} ColumnNullAdmissionKey;

typedef struct ColumnNullAdmissionEntry
{
  ColumnNullAdmissionKey key;
  TypeNullAdmission admission;
} ColumnNullAdmissionEntry;

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
  TypeNullAdmission null_admission;
  bool value_preserving;
  bool null_propagating;
  bool unconditional;
} LineageVisitKey;

typedef struct LineageWorkItem
{
  LineageWorkKind kind;
  const QueryScope *scope;
  const Node *node;
  AttrNumber output_attnum;
  TypeNullAdmission null_admission;
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
  StringInfo out;
  Oid target_relid;
  AttrNumber target_attnum;
  const char *source;
  bool *first;
  HTAB *facts;
  HTAB *type_admissions;
  HTAB *column_admissions;
  HTAB *visited;
  const List *target_list;
  const List *match_full_foreign_keys;
  bool has_additional_constraints;
  bool has_opaque_enforcement;
} DmlLineageContext;

typedef struct RelationWriteEnforcement
{
  bool has_generated_columns;
  bool opaque;
  List *match_full_foreign_keys;
} RelationWriteEnforcement;

typedef struct NullProofSubject
{
  AttrNumber target_attnum;
  int param_id;
  HTAB *node_analysis;
} NullProofSubject;

typedef struct ParameterNodeKey
{
  const Node *node;
  int param_id;
} ParameterNodeKey;

typedef struct ParameterNodeAnalysisEntry
{
  ParameterNodeKey key;
  NullProof proof;
  bool proof_known;
  bool mentions_parameter;
  bool mention_known;
} ParameterNodeAnalysisEntry;

typedef struct ParameterMentionContext
{
  int param_id;
  HTAB *node_analysis;
} ParameterMentionContext;

typedef struct ParameterUsageEvidence
{
  bool seen;
  TypeNullAdmission admission;
} ParameterUsageEvidence;

typedef struct ParameterUsageContext
{
  int param_id;
  ParameterUsageEvidence evidence;
  HTAB *type_admissions;
  HTAB *node_analysis;
} ParameterUsageContext;

static NullProof
invert_null_proof(NullProof proof)
{
  if (proof == NULL_PROOF_TRUE)
  {
    return NULL_PROOF_FALSE;
  }
  if (proof == NULL_PROOF_FALSE)
  {
    return NULL_PROOF_TRUE;
  }
  return proof;
}

static NullProof
check_null_proof_for_subject_uncached(const Node *expr,
                                      const NullProofSubject *subject);

static NullProof
check_null_proof_for_subject(const Node *expr, const NullProofSubject *subject)
{
  ParameterNodeKey key;
  ParameterNodeAnalysisEntry *entry;
  NullProof proof;
  bool found;

  if (expr == NULL || subject->node_analysis == NULL || subject->param_id <= 0)
  {
    return check_null_proof_for_subject_uncached(expr, subject);
  }

  memset(&key, 0, sizeof(key));
  key.node = expr;
  key.param_id = subject->param_id;
  entry = hash_search(subject->node_analysis, &key, HASH_FIND, &found);
  if (found && entry->proof_known)
  {
    return entry->proof;
  }

  proof = check_null_proof_for_subject_uncached(expr, subject);
  entry = hash_search(subject->node_analysis, &key, HASH_ENTER, &found);
  if (!found)
  {
    entry->mention_known = false;
  }
  entry->proof = proof;
  entry->proof_known = true;
  return proof;
}

static NullProof
check_null_proof_for_subject_uncached(const Node *expr,
                                      const NullProofSubject *subject)
{
  if (expr == NULL)
  {
    return NULL_PROOF_UNKNOWN;
  }

  switch (nodeTag(expr))
  {
    case T_CoerceToDomainValue:
      return NULL_PROOF_NULL;
    case T_Param:
    {
      const Param *parameter = (const Param *) expr;

      return subject->param_id > 0 && parameter->paramkind == PARAM_EXTERN &&
             parameter->paramid == subject->param_id
               ? NULL_PROOF_NULL
               : NULL_PROOF_UNKNOWN;
    }
    case T_Var:
    {
      const Var *variable = (const Var *) expr;

      if (subject->target_attnum > 0 && variable->varlevelsup == 0 && variable->varno == 1 &&
          variable->varattno == subject->target_attnum)
      {
        return NULL_PROOF_NULL;
      }
      return NULL_PROOF_UNKNOWN;
    }
    case T_Const:
    {
      const Const *constant = (const Const *) expr;

      if (constant->constisnull)
      {
        return NULL_PROOF_NULL;
      }
      if (constant->consttype == BOOLOID)
      {
        return DatumGetBool(constant->constvalue) ? NULL_PROOF_TRUE : NULL_PROOF_FALSE;
      }
      return NULL_PROOF_NONNULL;
    }
    case T_RelabelType:
      return check_null_proof_for_subject((const Node *) ((const RelabelType *) expr)->arg,
                                          subject);
    case T_CollateExpr:
      return check_null_proof_for_subject((const Node *) ((const CollateExpr *) expr)->arg,
                                          subject);
    case T_CoerceViaIO:
      return check_null_proof_for_subject((const Node *) ((const CoerceViaIO *) expr)->arg,
                                          subject);
    case T_ArrayCoerceExpr:
      return check_null_proof_for_subject((const Node *) ((const ArrayCoerceExpr *) expr)->arg,
                                          subject);
    case T_ConvertRowtypeExpr:
      return check_null_proof_for_subject((const Node *) ((const ConvertRowtypeExpr *) expr)->arg,
                                          subject);
    case T_NullTest:
    {
      const NullTest *test = (const NullTest *) expr;
      NullProof argument = check_null_proof_for_subject((const Node *) test->arg, subject);

      if (test->argisrow || argument == NULL_PROOF_UNKNOWN)
      {
        return NULL_PROOF_UNKNOWN;
      }
      if (argument == NULL_PROOF_NULL)
      {
        return test->nulltesttype == IS_NULL ? NULL_PROOF_TRUE : NULL_PROOF_FALSE;
      }
      return test->nulltesttype == IS_NULL ? NULL_PROOF_FALSE : NULL_PROOF_TRUE;
    }
    case T_BooleanTest:
    {
      const BooleanTest *test = (const BooleanTest *) expr;
      NullProof argument = check_null_proof_for_subject((const Node *) test->arg, subject);

      if (argument == NULL_PROOF_UNKNOWN || argument == NULL_PROOF_NONNULL)
      {
        return NULL_PROOF_UNKNOWN;
      }
      switch (test->booltesttype)
      {
        case IS_TRUE:
          return argument == NULL_PROOF_TRUE ? NULL_PROOF_TRUE : NULL_PROOF_FALSE;
        case IS_NOT_TRUE:
          return argument == NULL_PROOF_TRUE ? NULL_PROOF_FALSE : NULL_PROOF_TRUE;
        case IS_FALSE:
          return argument == NULL_PROOF_FALSE ? NULL_PROOF_TRUE : NULL_PROOF_FALSE;
        case IS_NOT_FALSE:
          return argument == NULL_PROOF_FALSE ? NULL_PROOF_FALSE : NULL_PROOF_TRUE;
        case IS_UNKNOWN:
          return argument == NULL_PROOF_NULL ? NULL_PROOF_TRUE : NULL_PROOF_FALSE;
        case IS_NOT_UNKNOWN:
          return argument == NULL_PROOF_NULL ? NULL_PROOF_FALSE : NULL_PROOF_TRUE;
      }
      return NULL_PROOF_UNKNOWN;
    }
    case T_BoolExpr:
    {
      const BoolExpr *boolean = (const BoolExpr *) expr;
      ListCell *cell;
      bool saw_null = false;
      bool saw_unknown = false;

      if (boolean->boolop == NOT_EXPR && list_length(boolean->args) == 1)
      {
        return invert_null_proof(
          check_null_proof_for_subject((const Node *) linitial(boolean->args), subject));
      }

      foreach(cell, boolean->args)
      {
        NullProof argument = check_null_proof_for_subject((const Node *) lfirst(cell), subject);

        if (boolean->boolop == AND_EXPR && argument == NULL_PROOF_FALSE)
        {
          return NULL_PROOF_FALSE;
        }
        if (boolean->boolop == OR_EXPR && argument == NULL_PROOF_TRUE)
        {
          return NULL_PROOF_TRUE;
        }
        if (argument == NULL_PROOF_NULL)
        {
          saw_null = true;
        }
        else if (argument == NULL_PROOF_UNKNOWN || argument == NULL_PROOF_NONNULL)
        {
          saw_unknown = true;
        }
      }

      if (saw_unknown)
      {
        return NULL_PROOF_UNKNOWN;
      }
      if (saw_null)
      {
        return NULL_PROOF_NULL;
      }
      return boolean->boolop == AND_EXPR ? NULL_PROOF_TRUE : NULL_PROOF_FALSE;
    }
    case T_CoalesceExpr:
    {
      const CoalesceExpr *coalesce = (const CoalesceExpr *) expr;
      ListCell *cell;

      foreach(cell, coalesce->args)
      {
        NullProof argument = check_null_proof_for_subject((const Node *) lfirst(cell), subject);

        if (argument == NULL_PROOF_NULL)
        {
          continue;
        }
        return argument;
      }
      return NULL_PROOF_NULL;
    }
    case T_FuncExpr:
    {
      const FuncExpr *function = (const FuncExpr *) expr;
      ListCell *cell;

      if (!func_strict(function->funcid))
      {
        return NULL_PROOF_UNKNOWN;
      }
      foreach(cell, function->args)
      {
        if (check_null_proof_for_subject((const Node *) lfirst(cell), subject) == NULL_PROOF_NULL)
        {
          return NULL_PROOF_NULL;
        }
      }
      return NULL_PROOF_UNKNOWN;
    }
    case T_OpExpr:
    {
      const OpExpr *operation = (const OpExpr *) expr;
      ListCell *cell;

      if (!op_strict(operation->opno))
      {
        return NULL_PROOF_UNKNOWN;
      }
      foreach(cell, operation->args)
      {
        if (check_null_proof_for_subject((const Node *) lfirst(cell), subject) == NULL_PROOF_NULL)
        {
          return NULL_PROOF_NULL;
        }
      }
      return NULL_PROOF_UNKNOWN;
    }
    case T_ScalarArrayOpExpr:
    {
      const ScalarArrayOpExpr *operation = (const ScalarArrayOpExpr *) expr;
      const Node *scalar;
      const Node *array;
      ArrayCardinalityProof cardinality;

      if (!op_strict(operation->opno) || list_length(operation->args) != 2)
      {
        return NULL_PROOF_UNKNOWN;
      }
      scalar = (const Node *) linitial(operation->args);
      array = (const Node *) lsecond(operation->args);
      cardinality = array_cardinality_proof(array);
      if (cardinality == ARRAY_CARDINALITY_EMPTY)
      {
        return operation->useOr ? NULL_PROOF_FALSE : NULL_PROOF_TRUE;
      }
      if (cardinality == ARRAY_CARDINALITY_NONEMPTY &&
          check_null_proof_for_subject(scalar, subject) == NULL_PROOF_NULL)
      {
        return NULL_PROOF_NULL;
      }
      return NULL_PROOF_UNKNOWN;
    }
    default:
      return NULL_PROOF_UNKNOWN;
  }
}

static NullProof
check_null_proof(const Node *expr, AttrNumber target_attnum)
{
  const NullProofSubject subject = {target_attnum, 0, NULL};

  return check_null_proof_for_subject(expr, &subject);
}

static NullProof
check_parameter_null_proof(const Node *expr, int param_id,
                           HTAB *node_analysis)
{
  const NullProofSubject subject = {0, param_id, node_analysis};

  return check_null_proof_for_subject(expr, &subject);
}

static TypeNullAdmission
type_null_admission(HTAB *cache, Oid type_oid)
{
  TypeNullAdmissionEntry lookup_key;
  TypeNullAdmissionEntry *entry;
  HeapTuple tuple;
  Form_pg_type type;
  bool found;
  TypeNullAdmission admission = TYPE_NULL_ADMITS;

  memset(&lookup_key, 0, sizeof(lookup_key));
  lookup_key.type_oid = type_oid;
  entry = hash_search(cache, &lookup_key, HASH_FIND, &found);
  if (found)
  {
    return entry->admission;
  }

  tuple = SearchSysCache1(TYPEOID, ObjectIdGetDatum(type_oid));
  if (!HeapTupleIsValid(tuple))
  {
    elog(ERROR, "cache lookup failed for type %u", type_oid);
  }
  type = (Form_pg_type) GETSTRUCT(tuple);

  if (type->typtype == TYPTYPE_DOMAIN)
  {
    DomainConstraintRef *constraints;
    ListCell *cell;

    constraints = palloc(sizeof(DomainConstraintRef));
    InitDomainConstraintRef(type_oid, constraints, CurrentMemoryContext, false);
    foreach(cell, constraints->constraints)
    {
      const DomainConstraintState *constraint = lfirst_node(DomainConstraintState, cell);

      if (constraint->constrainttype == DOM_CONSTRAINT_NOTNULL)
      {
        admission = TYPE_NULL_REJECTS;
        break;
      }
      if (constraint->constrainttype == DOM_CONSTRAINT_CHECK)
      {
        NullProof proof = check_null_proof((const Node *) constraint->check_expr, 0);

        if (proof == NULL_PROOF_FALSE)
        {
          admission = TYPE_NULL_REJECTS;
          break;
        }
        if (proof != NULL_PROOF_TRUE && proof != NULL_PROOF_NULL)
        {
          admission = TYPE_NULL_UNKNOWN;
        }
      }
    }
  }

  ReleaseSysCache(tuple);
  entry = hash_search(cache, &lookup_key, HASH_ENTER, &found);
  entry->admission = admission;
  return admission;
}

typedef struct ColumnMentionsContext
{
  Bitmapset *attnums;
  bool whole_row;
} ColumnMentionsContext;

static bool
collect_column_mentions_walker(Node *node, void *walker_context)
{
  ColumnMentionsContext *context = (ColumnMentionsContext *) walker_context;

  if (node == NULL)
  {
    return false;
  }
  if (IsA(node, Var))
  {
    const Var *variable = (const Var *) node;

    if (variable->varlevelsup == 0 && variable->varno == 1)
    {
      if (variable->varattno > 0)
      {
        context->attnums = bms_add_member(context->attnums, variable->varattno);
      }
      else if (variable->varattno == InvalidAttrNumber)
      {
        context->whole_row = true;
      }
    }
  }
  return expression_tree_walker(node, collect_column_mentions_walker, walker_context);
}

static void
update_column_null_admission(HTAB *cache, Oid relid, AttrNumber attnum,
                             NullProof proof)
{
  ColumnNullAdmissionKey key;
  ColumnNullAdmissionEntry *entry;
  bool found;

  memset(&key, 0, sizeof(key));
  key.relid = relid;
  key.attnum = attnum;
  entry = hash_search(cache, &key, HASH_FIND, &found);
  if (!found || entry->admission == TYPE_NULL_REJECTS)
  {
    return;
  }
  if (proof == NULL_PROOF_FALSE)
  {
    entry->admission = TYPE_NULL_REJECTS;
  }
  else if (proof != NULL_PROOF_TRUE && proof != NULL_PROOF_NULL)
  {
    entry->admission = TYPE_NULL_UNKNOWN;
  }
}

static TypeNullAdmission
combine_null_admission(TypeNullAdmission left, TypeNullAdmission right)
{
  if (left == TYPE_NULL_REJECTS || right == TYPE_NULL_REJECTS)
  {
    return TYPE_NULL_REJECTS;
  }
  if (left == TYPE_NULL_UNKNOWN || right == TYPE_NULL_UNKNOWN)
  {
    return TYPE_NULL_UNKNOWN;
  }
  return TYPE_NULL_ADMITS;
}

static bool
node_mentions_external_parameter(const Node *node,
                                 ParameterMentionContext *context);

static bool
node_mentions_external_parameter_walker(Node *node, void *walker_context)
{
  ParameterMentionContext *context = (ParameterMentionContext *) walker_context;

  return node_mentions_external_parameter(node, context);
}

static bool
node_mentions_external_parameter(const Node *node,
                                 ParameterMentionContext *context)
{
  ParameterNodeKey key;
  ParameterNodeAnalysisEntry *entry;
  bool found;
  bool mentions_parameter;

  if (node == NULL)
  {
    return false;
  }

  memset(&key, 0, sizeof(key));
  key.node = node;
  key.param_id = context->param_id;
  entry = hash_search(context->node_analysis, &key, HASH_FIND, &found);
  if (found && entry->mention_known)
  {
    return entry->mentions_parameter;
  }

  if (IsA(node, Param))
  {
    const Param *param = (const Param *) node;

    mentions_parameter = param->paramkind == PARAM_EXTERN &&
                         param->paramid == context->param_id;
  }
  else if (IsA(node, Query))
  {
    mentions_parameter = query_tree_walker(
      (Query *) node, node_mentions_external_parameter_walker, context,
      QTW_EXAMINE_SORTGROUP);
  }
  else
  {
    mentions_parameter = expression_tree_walker(
      (Node *) node, node_mentions_external_parameter_walker, context);
  }

  entry = hash_search(context->node_analysis, &key, HASH_ENTER, &found);
  if (!found)
  {
    entry->proof_known = false;
  }
  entry->mentions_parameter = mentions_parameter;
  entry->mention_known = true;
  return mentions_parameter;
}

static void
mark_parameter_usage(ParameterUsageContext *context,
                     TypeNullAdmission admission)
{
  if (!context->evidence.seen)
  {
    context->evidence.seen = true;
    context->evidence.admission = admission;
    return;
  }
  context->evidence.admission = combine_null_admission(
    context->evidence.admission, admission);
}

static void
merge_parameter_usage_evidence(ParameterUsageEvidence *target,
                               const ParameterUsageEvidence *source)
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
  target->admission = combine_null_admission(target->admission,
                                             source->admission);
}

static void
mark_required_nonnull_parameter_usage(ParameterUsageContext *context,
                                      const Node *expr)
{
  ParameterMentionContext mention_context = {
    context->param_id,
    context->node_analysis
  };
  NullProof proof;

  if (!node_mentions_external_parameter(expr, &mention_context))
  {
    return;
  }

  proof = check_parameter_null_proof(expr, context->param_id,
                                     context->node_analysis);
  if (proof == NULL_PROOF_NULL)
  {
    mark_parameter_usage(context, TYPE_NULL_REJECTS);
  }
  else if (proof == NULL_PROOF_UNKNOWN)
  {
    mark_parameter_usage(context, TYPE_NULL_UNKNOWN);
  }
}

static bool
parameter_usage_null_admission_walker(Node *node, void *walker_context)
{
  ParameterUsageContext *context = (ParameterUsageContext *) walker_context;
  ParameterMentionContext mention_context = {
    context->param_id,
    context->node_analysis
  };
  bool mentions_parameter;

  if (node == NULL)
  {
    return false;
  }
  if (context->evidence.seen &&
      context->evidence.admission == TYPE_NULL_REJECTS)
  {
    return true;
  }

  /* PostgreSQL's query_tree_walker deliberately does not visit utilityStmt. */
  if (IsA(node, Query) && ((Query *) node)->utilityStmt != NULL)
  {
    mark_parameter_usage(context, TYPE_NULL_UNKNOWN);
  }

  mentions_parameter = node_mentions_external_parameter(node,
                                                         &mention_context);
  if (!mentions_parameter)
  {
    return false;
  }

  switch (nodeTag(node))
  {
    case T_Param:
      mark_parameter_usage(context, TYPE_NULL_ADMITS);
      break;
    case T_CoerceToDomain:
    {
      const CoerceToDomain *coerce = (const CoerceToDomain *) node;
      NullProof argument = check_parameter_null_proof((const Node *) coerce->arg,
                                                      context->param_id,
                                                      context->node_analysis);

      mark_parameter_usage(
        context,
        argument == NULL_PROOF_NULL
          ? type_null_admission(context->type_admissions,
                                coerce->resulttype)
          : TYPE_NULL_UNKNOWN);
      break;
    }
    case T_FuncExpr:
    {
      const FuncExpr *function = (const FuncExpr *) node;

      if (!func_strict(function->funcid) ||
          check_parameter_null_proof(node, context->param_id,
                                     context->node_analysis) != NULL_PROOF_NULL)
      {
        mark_parameter_usage(context, TYPE_NULL_UNKNOWN);
      }
      break;
    }
    case T_OpExpr:
    {
      const OpExpr *operation = (const OpExpr *) node;

      if (!op_strict(operation->opno) ||
          check_parameter_null_proof(node, context->param_id,
                                     context->node_analysis) != NULL_PROOF_NULL)
      {
        mark_parameter_usage(context, TYPE_NULL_UNKNOWN);
      }
      break;
    }
    case T_ScalarArrayOpExpr:
    {
      const ScalarArrayOpExpr *operation = (const ScalarArrayOpExpr *) node;
      NullProof proof = check_parameter_null_proof(node, context->param_id,
                                                   context->node_analysis);

      if (!op_strict(operation->opno) ||
          (proof != NULL_PROOF_NULL && proof != NULL_PROOF_TRUE &&
           proof != NULL_PROOF_FALSE))
      {
        mark_parameter_usage(context, TYPE_NULL_UNKNOWN);
      }
      break;
    }
    case T_CoerceViaIO:
    {
      const CoerceViaIO *coerce = (const CoerceViaIO *) node;

      if (check_parameter_null_proof((const Node *) coerce->arg,
                                     context->param_id,
                                     context->node_analysis) != NULL_PROOF_NULL)
      {
        mark_parameter_usage(context, TYPE_NULL_UNKNOWN);
      }
      break;
    }
    case T_ArrayCoerceExpr:
    {
      const ArrayCoerceExpr *coerce = (const ArrayCoerceExpr *) node;

      if (check_parameter_null_proof((const Node *) coerce->arg,
                                     context->param_id,
                                     context->node_analysis) != NULL_PROOF_NULL)
      {
        mark_parameter_usage(context, TYPE_NULL_UNKNOWN);
      }
      break;
    }
    case T_ConvertRowtypeExpr:
    {
      const ConvertRowtypeExpr *coerce = (const ConvertRowtypeExpr *) node;

      if (check_parameter_null_proof((const Node *) coerce->arg,
                                     context->param_id,
                                     context->node_analysis) != NULL_PROOF_NULL)
      {
        mark_parameter_usage(context, TYPE_NULL_UNKNOWN);
      }
      break;
    }
    case T_DistinctExpr:
    {
      const DistinctExpr *distinct = (const DistinctExpr *) node;
      ListCell *cell;
      bool null_short_circuit = false;

      foreach(cell, distinct->args)
      {
        const Node *argument = (const Node *) lfirst(cell);

        if (node_mentions_external_parameter(argument, &mention_context) &&
            check_parameter_null_proof(argument, context->param_id,
                                       context->node_analysis) == NULL_PROOF_NULL)
        {
          null_short_circuit = true;
          break;
        }
      }
      if (!null_short_circuit)
      {
        mark_parameter_usage(context, TYPE_NULL_UNKNOWN);
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
    case T_Query:
    case T_List:
    case T_TargetEntry:
    case T_NamedArgExpr:
    case T_BoolExpr:
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
      mark_parameter_usage(context, TYPE_NULL_UNKNOWN);
      break;
  }

  if (context->evidence.seen &&
      context->evidence.admission == TYPE_NULL_REJECTS)
  {
    return true;
  }
  if (IsA(node, Query))
  {
    return query_tree_walker((Query *) node,
                             parameter_usage_null_admission_walker,
                             walker_context, QTW_EXAMINE_SORTGROUP);
  }
  return expression_tree_walker(node,
                                parameter_usage_null_admission_walker,
                                walker_context);
}

static void
update_parameter_usage_null_admissions(const Query *query,
                                       ParameterUsageEvidence *evidence,
                                       int param_count,
                                       HTAB *type_admissions)
{
  HASHCTL control;
  HTAB *node_analysis;
  int index;

  memset(&control, 0, sizeof(control));
  control.keysize = sizeof(ParameterNodeKey);
  control.entrysize = sizeof(ParameterNodeAnalysisEntry);
  node_analysis = hash_create("typed SQL parameter node analysis", 128,
                              &control, HASH_ELEM | HASH_BLOBS);

  for (index = 0; index < param_count; index++)
  {
    ParameterUsageContext context = {
      index + 1,
      {false, TYPE_NULL_UNKNOWN},
      type_admissions,
      node_analysis
    };

    parameter_usage_null_admission_walker((Node *) query, &context);
    merge_parameter_usage_evidence(&evidence[index], &context.evidence);
  }

  hash_destroy(node_analysis);
}

static void
populate_column_null_admissions(HTAB *cache, Oid relid)
{
  Relation relation;
  TupleDesc descriptor;
  TupleConstr *constraints;
  int index;

  relation = table_open(relid, AccessShareLock);
  descriptor = RelationGetDescr(relation);
  constraints = descriptor->constr;
  for (index = 0; index < descriptor->natts; index++)
  {
    Form_pg_attribute attribute = TupleDescAttr(descriptor, index);
    ColumnNullAdmissionKey key;
    ColumnNullAdmissionEntry *entry;
    bool found;

    if (attribute->attisdropped)
    {
      continue;
    }
    memset(&key, 0, sizeof(key));
    key.relid = relid;
    key.attnum = attribute->attnum;
    entry = hash_search(cache, &key, HASH_ENTER, &found);
    entry->admission = TYPE_NULL_ADMITS;
  }
  if (constraints != NULL)
  {
    for (index = 0; index < constraints->num_check; index++)
    {
      const ConstrCheck *constraint = &constraints->check[index];
      Node *check;
      ColumnMentionsContext mentions = {NULL, false};
      int attnum = -1;

      if (!constraint->ccenforced)
      {
        continue;
      }
      check = stringToNode(constraint->ccbin);
      collect_column_mentions_walker(check, &mentions);
      if (mentions.whole_row)
      {
        for (attnum = 1; attnum <= descriptor->natts; attnum++)
        {
          update_column_null_admission(cache, relid, attnum,
                                       check_null_proof(check, attnum));
        }
      }
      else
      {
        while ((attnum = bms_next_member(mentions.attnums, attnum)) >= 0)
        {
          update_column_null_admission(cache, relid, (AttrNumber) attnum,
                                       check_null_proof(check, (AttrNumber) attnum));
        }
      }
      bms_free(mentions.attnums);
    }
  }
  table_close(relation, AccessShareLock);
}

static TypeNullAdmission
column_check_null_admission(HTAB *cache, Oid relid, AttrNumber target_attnum)
{
  ColumnNullAdmissionKey key;
  ColumnNullAdmissionEntry *entry;
  bool found;

  memset(&key, 0, sizeof(key));
  key.relid = relid;
  key.attnum = target_attnum;
  entry = hash_search(cache, &key, HASH_FIND, &found);
  if (!found)
  {
    populate_column_null_admissions(cache, relid);
    entry = hash_search(cache, &key, HASH_FIND, &found);
  }
  return found ? entry->admission : TYPE_NULL_UNKNOWN;
}

static const char *
null_admission_name(TypeNullAdmission admission)
{
  switch (admission)
  {
    case TYPE_NULL_ADMITS:
      return "accepts";
    case TYPE_NULL_REJECTS:
      return "rejects";
    case TYPE_NULL_UNKNOWN:
      return "unknown";
  }
  return "unknown";
}

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

static TypeNullAdmission
match_full_null_admission(const List *foreign_keys, const List *target_list,
                          int param_id, AttrNumber target_attnum)
{
  TypeNullAdmission admission = TYPE_NULL_ADMITS;
  ListCell *foreign_key_cell;

  foreach(foreign_key_cell, foreign_keys)
  {
    const ForeignKeyCacheInfo *foreign_key =
      lfirst_node(ForeignKeyCacheInfo, foreign_key_cell);
    bool applies_to_target = false;
    bool saw_null = false;
    bool saw_nonnull = false;
    bool saw_unknown = false;
    int key_index;

    for (key_index = 0; key_index < foreign_key->nkeys; key_index++)
    {
      if (foreign_key->conkey[key_index] == target_attnum)
      {
        applies_to_target = true;
        break;
      }
    }
    if (!applies_to_target)
    {
      continue;
    }

    for (key_index = 0; key_index < foreign_key->nkeys; key_index++)
    {
      AttrNumber key_attnum = foreign_key->conkey[key_index];
      const TargetEntry *target = target_entry_by_resno(target_list, key_attnum);
      NullProof proof = key_attnum == target_attnum
                          ? NULL_PROOF_NULL
                          : target == NULL
                              ? NULL_PROOF_UNKNOWN
                              : check_parameter_null_proof((const Node *) target->expr,
                                                           param_id, NULL);

      if (proof == NULL_PROOF_NULL)
      {
        saw_null = true;
      }
      else if (proof == NULL_PROOF_UNKNOWN)
      {
        saw_unknown = true;
      }
      else
      {
        saw_nonnull = true;
      }
    }

    if (saw_null && saw_nonnull)
    {
      admission = combine_null_admission(admission, TYPE_NULL_REJECTS);
    }
    else if (saw_unknown)
    {
      admission = combine_null_admission(admission, TYPE_NULL_UNKNOWN);
    }
  }

  return admission;
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
unwrap_direct_assignment_expr(DmlLineageContext *context, const Node *expr,
                              TypeNullAdmission *null_admission,
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

        *null_admission = combine_null_admission(
          *null_admission,
          type_null_admission(context->type_admissions, coerce->resulttype));
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
                            TypeNullAdmission path_admission,
                            bool value_preserving, bool null_propagating,
                            bool unconditional)
{
  HeapTuple tuple;
  Form_pg_attribute attribute;
  DmlParameterTargetKey lookup_key;
  Oid type_oid;
  char *type_name;
  TypeNullAdmission target_admission;
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
  target_admission = null_propagating ? path_admission : TYPE_NULL_UNKNOWN;
  if (null_propagating && attribute->attnotnull)
  {
    target_admission = TYPE_NULL_REJECTS;
  }
  if (null_propagating)
  {
    target_admission = combine_null_admission(
      target_admission, type_null_admission(context->type_admissions, type_oid));
    target_admission = combine_null_admission(
      target_admission,
      column_check_null_admission(context->column_admissions,
                                  context->target_relid, context->target_attnum));
    target_admission = combine_null_admission(
      target_admission,
      match_full_null_admission(context->match_full_foreign_keys,
                                context->target_list, param_id,
                                context->target_attnum));
    if (context->has_additional_constraints)
    {
      target_admission = combine_null_admission(target_admission,
                                                TYPE_NULL_UNKNOWN);
    }
  }
  if (context->has_opaque_enforcement)
  {
    target_admission = TYPE_NULL_UNKNOWN;
  }
  if (!unconditional && target_admission == TYPE_NULL_REJECTS)
  {
    target_admission = TYPE_NULL_UNKNOWN;
  }
  direct_assignment = value_preserving && unconditional;

  memset(&lookup_key, 0, sizeof(lookup_key));
  lookup_key.param_id = param_id;
  lookup_key.target_relid = context->target_relid;
  lookup_key.target_attnum = context->target_attnum;
  lookup_key.source = context->source;
  lookup_key.target_null_admission = target_admission;
  lookup_key.direct_assignment = direct_assignment;
  hash_search(context->facts, &lookup_key, HASH_ENTER, &found);
  if (found)
  {
    ReleaseSysCache(tuple);
    return;
  }

  type_name = OidIsValid(type_oid)
                ? format_type_extended(type_oid, attribute->atttypmod, FORMAT_TYPE_TYPEMOD_GIVEN)
                : NULL;

  if (!*context->first)
  {
    appendStringInfoChar(context->out, ',');
  }
  *context->first = false;

  appendStringInfo(context->out,
                   "{\"paramId\":%d,\"targetRelid\":%u,\"targetAttnum\":%d,\"targetAttname\":",
                   param_id, context->target_relid, context->target_attnum);
  append_json_string(context->out, NameStr(attribute->attname));
  append_bool_field(context->out, "directAssignment", direct_assignment);
  append_bool_field(context->out, "targetNullable", target_admission == TYPE_NULL_ADMITS);
  appendStringInfoString(context->out, ",\"targetNullAdmission\":");
  append_json_string(context->out, null_admission_name(target_admission));
  append_oid_field(context->out, "targetTypeOid", type_oid);
  append_optional_name_field(context->out, "targetTypeName", type_name);
  appendStringInfoString(context->out, ",\"source\":");
  append_json_string(context->out, context->source);
  appendStringInfoChar(context->out, '}');

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
enqueue_lineage_work(DmlLineageContext *context, LineageWorkQueue *work,
                     LineageWorkKind kind, const QueryScope *scope,
                     const Node *node, AttrNumber output_attnum,
                     TypeNullAdmission null_admission,
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

static QueryScope *
make_query_scope(const Query *query, const QueryScope *parent)
{
  QueryScope *scope = palloc(sizeof(QueryScope));

  scope->query = query;
  scope->parent = parent;
  return scope;
}

static bool query_output_is_unconditional_at_depth(const Query *query, int depth);

static bool
from_node_is_unconditional(const Query *query, const Node *node, int depth)
{
  if (node == NULL || depth <= 0)
  {
    return false;
  }
  if (IsA(node, RangeTblRef))
  {
    const RangeTblRef *reference = (const RangeTblRef *) node;
    const RangeTblEntry *rte;

    if (reference->rtindex <= 0 ||
        reference->rtindex > list_length(query->rtable))
    {
      return false;
    }
    rte = rt_fetch(reference->rtindex, query->rtable);
    switch (rte->rtekind)
    {
      case RTE_RESULT:
        return true;
      case RTE_VALUES:
        return rte->values_lists != NIL;
      case RTE_SUBQUERY:
        return rte->subquery != NULL &&
               query_output_is_unconditional_at_depth(rte->subquery, depth - 1);
      case RTE_CTE:
      {
        const CommonTableExpr *cte = rte->ctelevelsup == 0
                                       ? cte_by_name(query, rte->ctename)
                                       : NULL;

        return cte != NULL && !cte->cterecursive && cte->ctequery != NULL &&
               IsA(cte->ctequery, Query) &&
               query_output_is_unconditional_at_depth((const Query *) cte->ctequery,
                                                        depth - 1);
      }
      default:
        return false;
    }
  }
  if (IsA(node, JoinExpr))
  {
    const JoinExpr *join = (const JoinExpr *) node;
    bool left = from_node_is_unconditional(query, join->larg, depth - 1);
    bool right = from_node_is_unconditional(query, join->rarg, depth - 1);

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
query_output_is_unconditional_at_depth(const Query *query, int depth)
{
  ListCell *from_cell;

  if (depth <= 0 || (query->commandType != CMD_SELECT &&
                     query->commandType != CMD_INSERT) ||
      query->hasTargetSRFs ||
      query->havingQual != NULL || query->limitOffset != NULL ||
      query->limitCount != NULL)
  {
    return false;
  }
  if (query->hasAggs && query->groupClause == NIL &&
      query->groupingSets == NIL)
  {
    return true;
  }
  if (query->jointree == NULL || query->jointree->quals != NULL)
  {
    return false;
  }
  foreach(from_cell, query->jointree->fromlist)
  {
    if (!from_node_is_unconditional(query, (const Node *) lfirst(from_cell),
                                    depth - 1))
    {
      return false;
    }
  }
  return true;
}

static bool
query_output_is_unconditional(const Query *query)
{
  return query_output_is_unconditional_at_depth(query, 16);
}

typedef struct UnknownLineageWalkerContext
{
  DmlLineageContext *lineage;
  LineageWorkQueue *work;
  const QueryScope *scope;
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
                                  TYPE_NULL_UNKNOWN, false, false, false);
    }
    return false;
  }
  if (IsA(node, Var))
  {
    enqueue_lineage_work(context->lineage, context->work, LINEAGE_WORK_EXPR,
                         context->scope, node, 0, TYPE_NULL_UNKNOWN,
                         false, false, false);
    return false;
  }
  if (IsA(node, Query))
  {
    QueryScope *query_scope = make_query_scope((const Query *) node, context->scope);
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
append_direct_parameter_targets(DmlLineageContext *context, const QueryScope *scope,
                                const Node *expr, TypeNullAdmission null_admission,
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
                           query_output_is_unconditional(item->scope->query);

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
        target = target_entry_by_resno(item->scope->query->targetList,
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

        if (set->op == SETOP_UNION)
        {
          enqueue_lineage_work(context, &work, LINEAGE_WORK_SET_OPERATION,
                               item->scope, set->larg, item->output_attnum,
                               item->null_admission, item->value_preserving,
                               item->null_propagating, item->unconditional);
          enqueue_lineage_work(context, &work, LINEAGE_WORK_SET_OPERATION,
                               item->scope, set->rarg, item->output_attnum,
                               item->null_admission, item->value_preserving,
                               item->null_propagating, item->unconditional);
        }
        else
        {
          enqueue_lineage_work(context, &work, LINEAGE_WORK_SET_OPERATION,
                               item->scope, set->larg, item->output_attnum,
                               item->null_admission, item->value_preserving,
                               item->null_propagating, false);
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
            QueryScope *child_scope = make_query_scope(rte->subquery, item->scope);

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
      TypeNullAdmission item_admission = item->null_admission;
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
        const QueryScope *variable_scope = query_scope_at_level(item->scope,
                                                                var->varlevelsup);

        if (var->varnullingrels != NULL)
        {
          value_preserving = false;
        }

        if (variable_scope != NULL && var->varattno > 0 && var->varno > 0 &&
            var->varno <= list_length(variable_scope->query->rtable))
        {
          const RangeTblEntry *rte = rt_fetch(var->varno, variable_scope->query->rtable);

          if (rte->rtekind == RTE_VALUES)
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
          else if (rte->rtekind == RTE_SUBQUERY && rte->subquery != NULL)
          {
            QueryScope *child_scope = make_query_scope(rte->subquery, variable_scope);

            enqueue_lineage_work(context, &work, LINEAGE_WORK_QUERY_OUTPUT,
                                 child_scope, (const Node *) rte->subquery,
                                 var->varattno, item_admission,
                                 value_preserving, item->null_propagating,
                                 item->unconditional);
          }
          else if (rte->rtekind == RTE_CTE)
          {
            const QueryScope *owner_scope = query_scope_at_level(variable_scope,
                                                                 rte->ctelevelsup);
            const CommonTableExpr *cte = owner_scope == NULL
                                           ? NULL
                                           : cte_by_name(owner_scope->query, rte->ctename);
            const Query *cte_query = cte == NULL ? NULL : (const Query *) cte->ctequery;

            if (cte_query != NULL)
            {
              QueryScope *cte_scope = make_query_scope(cte_query, owner_scope);

              enqueue_lineage_work(context, &work, LINEAGE_WORK_QUERY_OUTPUT,
                                   cte_scope, (const Node *) cte_query,
                                   var->varattno, item_admission,
                                   value_preserving, item->null_propagating,
                                   item->unconditional);
            }
          }
          else if (rte->rtekind == RTE_JOIN &&
                   var->varattno <= list_length(rte->joinaliasvars))
          {
            enqueue_lineage_work(context, &work, LINEAGE_WORK_EXPR,
                                 variable_scope,
                                 (const Node *) list_nth(rte->joinaliasvars,
                                                        var->varattno - 1),
                                 0, item_admission, value_preserving,
                                 item->null_propagating, item->unconditional);
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

static RelationWriteEnforcement
relation_write_enforcement(Oid relid, CmdType command)
{
  Relation relation;
  Form_pg_class relation_form;
  TupleDesc descriptor;
  TriggerDesc *trigger_desc;
  RelationWriteEnforcement result = {false, false, NIL};
  List *foreign_keys;
  ListCell *foreign_key_cell;
  int attribute_index;
  int trigger_index;

  if (!OidIsValid(relid))
  {
    return result;
  }

  relation = table_open(relid, AccessShareLock);
  relation_form = RelationGetForm(relation);
  result.opaque = relation_form->relkind == RELKIND_PARTITIONED_TABLE ||
                  relation_form->relkind == RELKIND_FOREIGN_TABLE ||
                  relation_form->relrowsecurity || relation_form->relforcerowsecurity;
  descriptor = RelationGetDescr(relation);
  for (attribute_index = 0;
       !result.has_generated_columns && attribute_index < descriptor->natts;
       attribute_index++)
  {
    Form_pg_attribute attribute = TupleDescAttr(descriptor, attribute_index);

    result.has_generated_columns = !attribute->attisdropped &&
                                   attribute->attgenerated != '\0';
  }
  trigger_desc = relation->trigdesc;
  foreign_keys = copyObject(RelationGetFKeyList(relation));

  foreach(foreign_key_cell, foreign_keys)
  {
    const ForeignKeyCacheInfo *foreign_key =
      lfirst_node(ForeignKeyCacheInfo, foreign_key_cell);
    HeapTuple tuple = SearchSysCache1(CONSTROID,
                                      ObjectIdGetDatum(foreign_key->conoid));

    if (!HeapTupleIsValid(tuple))
    {
      result.opaque = true;
      continue;
    }
    if (((Form_pg_constraint) GETSTRUCT(tuple))->conenforced &&
        ((Form_pg_constraint) GETSTRUCT(tuple))->confmatchtype == FKCONSTR_MATCH_FULL)
    {
      result.match_full_foreign_keys =
        lappend(result.match_full_foreign_keys, copyObject(foreign_key));
    }
    ReleaseSysCache(tuple);
  }
  list_free_deep(foreign_keys);

  for (trigger_index = 0;
       !result.opaque && trigger_desc != NULL && trigger_index < trigger_desc->numtriggers;
       trigger_index++)
  {
    const Trigger *trigger = &trigger_desc->triggers[trigger_index];
    bool relevant_event =
      (command == CMD_INSERT && (trigger->tgtype & TRIGGER_TYPE_INSERT) != 0) ||
      (command == CMD_UPDATE && (trigger->tgtype & TRIGGER_TYPE_UPDATE) != 0);

    if (relevant_event && trigger->tgenabled != TRIGGER_DISABLED &&
        (!trigger->tgisinternal || trigger->tgisclone))
    {
      result.opaque = true;
    }
  }

  table_close(relation, AccessShareLock);
  return result;
}

static void
append_targets_from_list(StringInfo out, const QueryScope *scope, const List *target_list,
                         Oid target_relid, const char *source, bool unconditional,
                         bool has_additional_constraints,
                         const RelationWriteEnforcement *enforcement,
                         bool *first,
                         HTAB *facts, HTAB *type_admissions, HTAB *column_admissions)
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
      context.out = out;
      context.target_relid = target_relid;
      context.target_attnum = target->resno;
      context.source = source;
      context.first = first;
      context.facts = facts;
      context.type_admissions = type_admissions;
      context.column_admissions = column_admissions;
      context.target_list = target_list;
      context.match_full_foreign_keys = enforcement->match_full_foreign_keys;
      context.has_additional_constraints = has_additional_constraints;
      context.has_opaque_enforcement = enforcement->opaque;
      context.visited = hash_create("typed SQL DML lineage visits", 32,
                                    &visited_control, HASH_ELEM | HASH_BLOBS);
      append_direct_parameter_targets(&context, scope, (const Node *) target->expr,
                                      TYPE_NULL_ADMITS, unconditional);
      hash_destroy(context.visited);
    }
  }
}

static void
append_dml_parameter_targets(StringInfo out, const Query *query)
{
  const RangeTblEntry *target_rte = NULL;
  Oid target_relid = InvalidOid;
  bool first = true;
  HASHCTL fact_control;
  HASHCTL type_control;
  HASHCTL column_control;
  HTAB *facts;
  HTAB *type_admissions;
  HTAB *column_admissions;
  QueryScope scope = {query, NULL};

  memset(&fact_control, 0, sizeof(fact_control));
  fact_control.keysize = sizeof(DmlParameterTargetKey);
  fact_control.entrysize = sizeof(DmlParameterTargetKey);
  facts = hash_create("typed SQL DML parameter target facts", 32,
                      &fact_control, HASH_ELEM | HASH_BLOBS);
  memset(&type_control, 0, sizeof(type_control));
  type_control.keysize = sizeof(Oid);
  type_control.entrysize = sizeof(TypeNullAdmissionEntry);
  type_admissions = hash_create("typed SQL type NULL admissions", 16,
                                &type_control, HASH_ELEM | HASH_BLOBS);
  memset(&column_control, 0, sizeof(column_control));
  column_control.keysize = sizeof(ColumnNullAdmissionKey);
  column_control.entrysize = sizeof(ColumnNullAdmissionEntry);
  column_admissions = hash_create("typed SQL column NULL admissions", 16,
                                  &column_control, HASH_ELEM | HASH_BLOBS);

  appendStringInfoString(out, ",\"dmlParameterTargets\":[");

  if (query->resultRelation > 0 && query->resultRelation <= list_length(query->rtable))
  {
    target_rte = rt_fetch(query->resultRelation, query->rtable);
    target_relid = target_rte->relid;
  }

  if (OidIsValid(target_relid) &&
      (query->commandType == CMD_INSERT || query->commandType == CMD_UPDATE))
  {
    RelationWriteEnforcement enforcement =
      relation_write_enforcement(target_relid, query->commandType);

    append_targets_from_list(out, &scope, query->targetList, target_relid,
                             command_type_name(query->commandType),
                             query->commandType == CMD_INSERT &&
                             query_output_is_unconditional(query),
                             query->withCheckOptions != NIL ||
                             enforcement.has_generated_columns,
                             &enforcement,
                             &first,
                             facts, type_admissions, column_admissions);
    list_free_deep(enforcement.match_full_foreign_keys);
  }

  if (OidIsValid(target_relid) && query->onConflict != NULL &&
      query->onConflict->action == ONCONFLICT_UPDATE)
  {
    RelationWriteEnforcement enforcement =
      relation_write_enforcement(target_relid, CMD_UPDATE);

    append_targets_from_list(out, &scope, query->onConflict->onConflictSet,
                             target_relid, "ON_CONFLICT_UPDATE", false,
                             query->withCheckOptions != NIL ||
                             enforcement.has_generated_columns,
                             &enforcement, &first,
                             facts, type_admissions, column_admissions);
    list_free_deep(enforcement.match_full_foreign_keys);
  }

  if (OidIsValid(target_relid) && query->commandType == CMD_MERGE)
  {
    ListCell *cell;
    RelationWriteEnforcement insert_enforcement =
      relation_write_enforcement(target_relid, CMD_INSERT);
    RelationWriteEnforcement update_enforcement =
      relation_write_enforcement(target_relid, CMD_UPDATE);

    foreach(cell, query->mergeActionList)
    {
      const MergeAction *action = lfirst_node(MergeAction, cell);

      if (action->commandType == CMD_INSERT)
      {
        append_targets_from_list(out, &scope, action->targetList,
                                 target_relid, "MERGE_INSERT", false,
                                 query->withCheckOptions != NIL ||
                                 insert_enforcement.has_generated_columns,
                                 &insert_enforcement, &first,
                                 facts, type_admissions, column_admissions);
      }
      else if (action->commandType == CMD_UPDATE)
      {
        append_targets_from_list(out, &scope, action->targetList,
                                 target_relid, "MERGE_UPDATE", false,
                                 query->withCheckOptions != NIL ||
                                 update_enforcement.has_generated_columns,
                                 &update_enforcement, &first,
                                 facts, type_admissions, column_admissions);
      }
    }
    list_free_deep(insert_enforcement.match_full_foreign_keys);
    list_free_deep(update_enforcement.match_full_foreign_keys);
  }

  appendStringInfoChar(out, ']');
  hash_destroy(column_admissions);
  hash_destroy(type_admissions);
  hash_destroy(facts);
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
append_expr_list(StringInfo out, const QueryScope *scope, const char *name, const List *exprs, int depth)
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
append_target_expr_list(StringInfo out, const QueryScope *scope, const char *name, const List *targets, int depth)
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
append_expr_specific_fields(StringInfo out, const QueryScope *scope, const Node *expr)
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
      const QueryScope *owner_scope = query_scope_at_level(scope, var->varlevelsup);
      appendStringInfo(out, ",\"varno\":%u,\"varattno\":%d,\"varlevelsup\":%u",
                       var->varno, var->varattno, var->varlevelsup);
      append_bitmapset_field(out, "varnullingrels", var->varnullingrels);

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
append_expr_node(StringInfo out, const QueryScope *scope, const Node *expr, int depth)
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
      appendStringInfoString(out, ",\"arg\":");
      append_expr_node(out, scope, (const Node *) relabel->arg, depth - 1);
      break;
    }
    case T_CoerceViaIO:
    {
      const CoerceViaIO *coerce = (const CoerceViaIO *) expr;
      appendStringInfoString(out, ",\"arg\":");
      append_expr_node(out, scope, (const Node *) coerce->arg, depth - 1);
      break;
    }
    case T_CoerceToDomain:
    {
      const CoerceToDomain *coerce = (const CoerceToDomain *) expr;
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
        append_query_summary(out, (const Query *) sublink->subselect, scope, depth - 1);
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
append_cte_list(StringInfo out, const QueryScope *scope, int depth)
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
      append_query_summary(out, cte_query, scope, depth - 1);
    }
    appendStringInfoChar(out, '}');
  }
  appendStringInfoChar(out, ']');
}

static void
append_target_list(StringInfo out, const QueryScope *scope)
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
append_returning_list(StringInfo out, const QueryScope *scope)
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
append_rtable(StringInfo out, const QueryScope *scope, int depth)
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
      append_query_summary(out, rte->subquery, scope, depth - 1);
    }
    appendStringInfoChar(out, '}');
    index++;
  }
  appendStringInfoChar(out, ']');
}

static void
append_from_list(StringInfo out, const QueryScope *scope, const char *name, const List *nodes, int depth)
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
append_from_node(StringInfo out, const QueryScope *scope, const Node *node, int depth)
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

static bool
aggregate_invokes_volatile_function(Oid aggregate_oid)
{
  HeapTuple tuple;
  Form_pg_aggregate aggregate;
  Oid support_function_oids[8];
  int index;

  tuple = SearchSysCache1(AGGFNOID, ObjectIdGetDatum(aggregate_oid));
  if (!HeapTupleIsValid(tuple))
  {
    elog(ERROR, "cache lookup failed for aggregate %u", aggregate_oid);
  }

  aggregate = (Form_pg_aggregate) GETSTRUCT(tuple);
  support_function_oids[0] = aggregate->aggtransfn;
  support_function_oids[1] = aggregate->aggfinalfn;
  support_function_oids[2] = aggregate->aggcombinefn;
  support_function_oids[3] = aggregate->aggserialfn;
  support_function_oids[4] = aggregate->aggdeserialfn;
  support_function_oids[5] = aggregate->aggmtransfn;
  support_function_oids[6] = aggregate->aggminvtransfn;
  support_function_oids[7] = aggregate->aggmfinalfn;
  ReleaseSysCache(tuple);

  for (index = 0; index < lengthof(support_function_oids); index++)
  {
    Oid function_oid = support_function_oids[index];

    if (OidIsValid(function_oid) && function_is_volatile(function_oid))
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

static bool
node_invokes_volatile_function(Node *node)
{
  switch (nodeTag(node))
  {
    case T_Aggref:
      return aggregate_invokes_volatile_function(((Aggref *) node)->aggfnoid);
    case T_WindowFunc:
    {
      WindowFunc *function = (WindowFunc *) node;

      return function->winagg
               ? aggregate_invokes_volatile_function(function->winfnoid)
               : function_is_volatile(function->winfnoid);
    }
    case T_FuncExpr:
      return function_is_volatile(((FuncExpr *) node)->funcid);
    case T_Param:
    {
      Param *param = (Param *) node;

      /*
       * An explicitly domain-typed external parameter is represented as a
       * Param of the domain type, without a surrounding CoerceToDomain node.
       * PostgreSQL still applies the domain constraints while receiving the
       * parameter value, so their volatility is part of executing the query.
       */
      return param->paramkind == PARAM_EXTERN &&
             get_typtype(param->paramtype) == TYPTYPE_DOMAIN &&
             domain_constraints_invoke_volatile_function(param->paramtype);
    }
    case T_OpExpr:
    case T_DistinctExpr:
    case T_NullIfExpr:
    {
      OpExpr *expr = (OpExpr *) node;
      Oid function_oid = OidIsValid(expr->opfuncid) ? expr->opfuncid : get_opcode(expr->opno);

      return function_is_volatile(function_oid);
    }
    case T_ScalarArrayOpExpr:
    {
      ScalarArrayOpExpr *expr = (ScalarArrayOpExpr *) node;
      Oid function_oid = OidIsValid(expr->opfuncid) ? expr->opfuncid : get_opcode(expr->opno);

      return function_is_volatile(function_oid);
    }
    case T_CoerceViaIO:
    {
      CoerceViaIO *expr = (CoerceViaIO *) node;
      Oid function_oid;
      Oid type_io_parameter;
      bool type_is_varlena;

      getTypeInputInfo(expr->resulttype, &function_oid, &type_io_parameter);
      if (function_is_volatile(function_oid))
      {
        return true;
      }
      getTypeOutputInfo(exprType((Node *) expr->arg), &function_oid, &type_is_varlena);
      return function_is_volatile(function_oid);
    }
    case T_CoerceToDomain:
      return domain_constraints_invoke_volatile_function(
        ((CoerceToDomain *) node)->resulttype);
    case T_RowCompareExpr:
    {
      ListCell *operator_cell;

      foreach(operator_cell, ((RowCompareExpr *) node)->opnos)
      {
        if (function_is_volatile(get_opcode(lfirst_oid(operator_cell))))
        {
          return true;
        }
      }
      return false;
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
  if (node == NULL)
  {
    return false;
  }
  if (node_invokes_volatile_function(node))
  {
    return true;
  }
  if (IsA(node, Query))
  {
    return query_tree_walker((Query *) node, volatile_function_walker, context, 0);
  }
  return expression_tree_walker(node, volatile_function_walker, context);
}

static bool
query_contains_volatile_functions(const Query *query)
{
  return volatile_function_walker((Node *) query, NULL);
}

static bool
row_marks_walker(Node *node, void *context)
{
  if (node == NULL)
  {
    return false;
  }
  if (IsA(node, Query))
  {
    Query *query = (Query *) node;

    if (query->rowMarks != NIL)
    {
      return true;
    }
    return query_tree_walker(query, row_marks_walker, context, 0);
  }
  return expression_tree_walker(node, row_marks_walker, context);
}

static bool
query_contains_row_marks(const Query *query)
{
  return row_marks_walker((Node *) query, NULL);
}

static void
append_query_summary(StringInfo out, const Query *query, const QueryScope *parent_scope, int depth)
{
  QueryScope *scope = make_query_scope(query, parent_scope);

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
  append_bool_field(out, "hasRowMarks", query_contains_row_marks(query));
  append_bool_field(out, "hasVolatileFunctions", query_contains_volatile_functions(query));
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
  append_dml_parameter_targets(out, query);
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

static void
append_param_type_null_admissions(StringInfo out, const Oid *param_types,
                                  int param_count)
{
  HASHCTL control;
  HTAB *cache;
  int index;

  memset(&control, 0, sizeof(control));
  control.keysize = sizeof(Oid);
  control.entrysize = sizeof(TypeNullAdmissionEntry);
  cache = hash_create("typed SQL parameter type NULL admissions", 16,
                      &control, HASH_ELEM | HASH_BLOBS);

  appendStringInfoString(out, ",\"paramTypeNullAdmissions\":[");
  for (index = 0; index < param_count; index++)
  {
    if (index > 0)
    {
      appendStringInfoChar(out, ',');
    }
    append_json_string(out, null_admission_name(
      OidIsValid(param_types[index])
        ? type_null_admission(cache, param_types[index])
        : TYPE_NULL_UNKNOWN));
  }
  appendStringInfoChar(out, ']');
  hash_destroy(cache);
}

static void
append_param_usage_null_admissions(StringInfo out,
                                   const ParameterUsageEvidence *evidence,
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
      null_admission_name(evidence[index].seen
                            ? evidence[index].admission
                            : TYPE_NULL_UNKNOWN));
  }
  appendStringInfoChar(out, ']');
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
  ParameterUsageEvidence *param_usage_evidence = NULL;
  int param_usage_count = 0;
  HASHCTL usage_type_control;
  HTAB *usage_type_admissions;
  StringInfoData out;
  ListCell *raw_cell;
  bool first_raw = true;

  memset(&usage_type_control, 0, sizeof(usage_type_control));
  usage_type_control.keysize = sizeof(Oid);
  usage_type_control.entrysize = sizeof(TypeNullAdmissionEntry);
  usage_type_admissions = hash_create("typed SQL parameter usage type NULL admissions",
                                      16, &usage_type_control,
                                      HASH_ELEM | HASH_BLOBS);

  initStringInfo(&out);
  appendStringInfoString(&out, "{\"schemaVersion\":6,\"postgresVersionNum\":");
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

    if (param_usage_count < param_count)
    {
      int index;

      param_usage_evidence = param_usage_evidence == NULL
                               ? palloc(sizeof(ParameterUsageEvidence) * param_count)
                               : repalloc(param_usage_evidence,
                                          sizeof(ParameterUsageEvidence) * param_count);
      for (index = param_usage_count; index < param_count; index++)
      {
        param_usage_evidence[index].seen = false;
        param_usage_evidence[index].admission = TYPE_NULL_UNKNOWN;
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

      update_parameter_usage_null_admissions(query, param_usage_evidence,
                                             param_count,
                                             usage_type_admissions);

      if (!first_query)
      {
        appendStringInfoChar(&out, ',');
      }
      first_query = false;

      append_query_summary(&out, query, NULL, 10);
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

  hash_destroy(usage_type_admissions);
  if (param_usage_evidence != NULL)
  {
    pfree(param_usage_evidence);
  }

  PG_RETURN_TEXT_P(cstring_to_text(out.data));
}
