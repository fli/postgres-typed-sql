#include "postgres.h"

#include "access/nbtree.h"
#include "access/table.h"
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
#include "parser/parsetree.h"
#include "tcop/tcopprot.h"
#include "utils/array.h"
#include "utils/builtins.h"
#include "utils/catcache.h"
#include "utils/fmgroids.h"
#include "utils/hsearch.h"
#include "utils/jsonb.h"
#include "utils/jsonfuncs.h"
#include "utils/lsyscache.h"
#include "utils/memutils.h"
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

struct QueryScope
{
  const Query *query;
  const struct QueryScope *parent;
};

typedef struct VolatileFunctionContext
{
  const QueryScope *scope;
} VolatileFunctionContext;

typedef enum NullProof
{
  NULL_PROOF_NULL,
  NULL_PROOF_TRUE,
  NULL_PROOF_FALSE,
  NULL_PROOF_NONNULL,
  NULL_PROOF_UNKNOWN
} NullProof;

typedef struct NullEvaluation
{
  NullProof proof;
  bool evaluation_safe;
  bool depends_on_subject;
} NullEvaluation;

typedef enum TypeNullAdmission
{
  TYPE_NULL_ADMITS,
  TYPE_NULL_REJECTS,
  TYPE_NULL_UNKNOWN
} TypeNullAdmission;

typedef enum ArrayShapeProof
{
  ARRAY_SHAPE_VALID,
  ARRAY_SHAPE_INVALID,
  ARRAY_SHAPE_UNKNOWN
} ArrayShapeProof;

typedef struct ArrayShape
{
  ArrayShapeProof proof;
  bool is_null;
  int ndims;
  int dims[MAXDIM];
  int lbs[MAXDIM];
  int nitems;
} ArrayShape;

typedef enum ArrayCardinalityProof
{
  ARRAY_CARDINALITY_EMPTY,
  ARRAY_CARDINALITY_NONEMPTY,
  ARRAY_CARDINALITY_UNKNOWN
} ArrayCardinalityProof;

static ArrayShape
unknown_array_shape(void)
{
  ArrayShape shape = {0};

  shape.proof = ARRAY_SHAPE_UNKNOWN;
  return shape;
}

static ArrayShape
invalid_array_shape(void)
{
  ArrayShape shape = {0};

  shape.proof = ARRAY_SHAPE_INVALID;
  return shape;
}

static ArrayShape
array_shape_proof(const Node *node)
{
  ArrayShape shape = {0};

  if (node == NULL)
  {
    return unknown_array_shape();
  }
  if (IsA(node, Const))
  {
    const Const *constant = (const Const *) node;
    ArrayType *value;

    shape.proof = ARRAY_SHAPE_VALID;
    if (constant->constisnull)
    {
      shape.is_null = true;
      return shape;
    }

    value = DatumGetArrayTypeP(constant->constvalue);
    shape.ndims = ARR_NDIM(value);
    if (shape.ndims < 0 || shape.ndims > MAXDIM)
    {
      return invalid_array_shape();
    }
    if (shape.ndims > 0)
    {
      memcpy(shape.dims, ARR_DIMS(value), shape.ndims * sizeof(int));
      memcpy(shape.lbs, ARR_LBOUND(value), shape.ndims * sizeof(int));
    }
    shape.nitems = ArrayGetNItems(shape.ndims, shape.dims);
    return shape;
  }
  if (IsA(node, ArrayExpr))
  {
    const ArrayExpr *array = (const ArrayExpr *) node;
    int element_count = list_length(array->elements);

    shape.proof = ARRAY_SHAPE_VALID;
    if (!array->multidims)
    {
      shape.ndims = 1;
      shape.dims[0] = element_count;
      shape.lbs[0] = 1;
      shape.nitems = element_count;
      return shape;
    }

    {
      ArrayShape first_nonempty = {0};
      ListCell *cell;
      bool saw_empty = false;
      bool saw_nonempty = false;
      bool saw_unknown = false;

      foreach(cell, array->elements)
      {
        ArrayShape child = array_shape_proof((const Node *) lfirst(cell));

        if (child.proof == ARRAY_SHAPE_INVALID)
        {
          return invalid_array_shape();
        }
        if (child.proof == ARRAY_SHAPE_UNKNOWN)
        {
          saw_unknown = true;
          continue;
        }
        if (child.is_null || child.nitems == 0 || child.ndims <= 0)
        {
          saw_empty = true;
          continue;
        }
        if (!saw_nonempty)
        {
          first_nonempty = child;
          saw_nonempty = true;
        }
        else if (child.ndims != first_nonempty.ndims ||
                 memcmp(child.dims, first_nonempty.dims,
                        child.ndims * sizeof(int)) != 0 ||
                 memcmp(child.lbs, first_nonempty.lbs,
                        child.ndims * sizeof(int)) != 0)
        {
          return invalid_array_shape();
        }
      }

      if (saw_unknown)
      {
        return unknown_array_shape();
      }
      if (!saw_nonempty)
      {
        return shape;
      }
      if (saw_empty || first_nonempty.ndims >= MAXDIM)
      {
        return invalid_array_shape();
      }

      shape.ndims = first_nonempty.ndims + 1;
      shape.dims[0] = element_count;
      shape.lbs[0] = 1;
      memcpy(&shape.dims[1], first_nonempty.dims,
             first_nonempty.ndims * sizeof(int));
      memcpy(&shape.lbs[1], first_nonempty.lbs,
             first_nonempty.ndims * sizeof(int));
      if (first_nonempty.nitems > 0 &&
          (Size) element_count > MaxArraySize / (Size) first_nonempty.nitems)
      {
        return unknown_array_shape();
      }
      shape.nitems = element_count * first_nonempty.nitems;
      return shape;
    }
  }
  return unknown_array_shape();
}

static ArrayCardinalityProof
array_cardinality_proof(const Node *node)
{
  ArrayShape shape = array_shape_proof(node);

  if (shape.proof != ARRAY_SHAPE_VALID || shape.is_null)
  {
    return ARRAY_CARDINALITY_UNKNOWN;
  }
  return shape.nitems == 0
           ? ARRAY_CARDINALITY_EMPTY
           : ARRAY_CARDINALITY_NONEMPTY;
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
  NullEvaluation null_evaluation;
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

static NullEvaluation
make_null_evaluation(NullProof proof, bool evaluation_safe,
                     bool depends_on_subject)
{
  NullEvaluation evaluation = {proof, evaluation_safe, depends_on_subject};

  return evaluation;
}

static NullEvaluation
invert_null_evaluation(NullEvaluation evaluation)
{
  if (evaluation.proof == NULL_PROOF_TRUE)
  {
    evaluation.proof = NULL_PROOF_FALSE;
  }
  else if (evaluation.proof == NULL_PROOF_FALSE)
  {
    evaluation.proof = NULL_PROOF_TRUE;
  }
  return evaluation;
}

static NullEvaluation
check_null_evaluation_for_subject_uncached(const Node *expr,
                                           const NullProofSubject *subject);

static NullEvaluation
check_null_evaluation_for_subject(const Node *expr,
                                  const NullProofSubject *subject)
{
  ParameterNodeKey key;
  ParameterNodeAnalysisEntry *entry;
  NullEvaluation evaluation;
  bool found;

  if (expr == NULL || subject->node_analysis == NULL || subject->param_id <= 0)
  {
    return check_null_evaluation_for_subject_uncached(expr, subject);
  }

  memset(&key, 0, sizeof(key));
  key.node = expr;
  key.param_id = subject->param_id;
  entry = hash_search(subject->node_analysis, &key, HASH_FIND, &found);
  if (found && entry->proof_known)
  {
    return entry->null_evaluation;
  }

  evaluation = check_null_evaluation_for_subject_uncached(expr, subject);
  entry = hash_search(subject->node_analysis, &key, HASH_ENTER, &found);
  if (!found)
  {
    entry->mention_known = false;
  }
  entry->null_evaluation = evaluation;
  entry->proof_known = true;
  return evaluation;
}

static NullEvaluation
check_null_evaluation_for_subject_uncached(const Node *expr,
                                           const NullProofSubject *subject)
{
  if (expr == NULL)
  {
    return make_null_evaluation(NULL_PROOF_UNKNOWN, false, true);
  }

  switch (nodeTag(expr))
  {
    case T_CoerceToDomainValue:
      return make_null_evaluation(NULL_PROOF_NULL, true, true);
    case T_Param:
    {
      const Param *parameter = (const Param *) expr;

      return make_null_evaluation(
        subject->param_id > 0 && parameter->paramkind == PARAM_EXTERN &&
            parameter->paramid == subject->param_id
          ? NULL_PROOF_NULL
          : NULL_PROOF_UNKNOWN,
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
        return make_null_evaluation(NULL_PROOF_NULL, true, true);
      }
      return make_null_evaluation(NULL_PROOF_UNKNOWN, true, false);
    }
    case T_Const:
    {
      const Const *constant = (const Const *) expr;

      if (constant->constisnull)
      {
        return make_null_evaluation(NULL_PROOF_NULL, true, false);
      }
      if (constant->consttype == BOOLOID)
      {
        return make_null_evaluation(
          DatumGetBool(constant->constvalue) ? NULL_PROOF_TRUE : NULL_PROOF_FALSE,
          true, false);
      }
      return make_null_evaluation(NULL_PROOF_NONNULL, true, false);
    }
    case T_RelabelType:
      return check_null_evaluation_for_subject(
        (const Node *) ((const RelabelType *) expr)->arg, subject);
    case T_CollateExpr:
      return check_null_evaluation_for_subject(
        (const Node *) ((const CollateExpr *) expr)->arg, subject);
    case T_CoerceViaIO:
    {
      NullEvaluation argument = check_null_evaluation_for_subject(
        (const Node *) ((const CoerceViaIO *) expr)->arg, subject);

      return make_null_evaluation(argument.proof,
                                  argument.evaluation_safe &&
                                    argument.proof == NULL_PROOF_NULL,
                                  argument.depends_on_subject);
    }
    case T_ArrayCoerceExpr:
    {
      NullEvaluation argument = check_null_evaluation_for_subject(
        (const Node *) ((const ArrayCoerceExpr *) expr)->arg, subject);

      return make_null_evaluation(argument.proof,
                                  argument.evaluation_safe &&
                                    argument.proof == NULL_PROOF_NULL,
                                  argument.depends_on_subject);
    }
    case T_ConvertRowtypeExpr:
    {
      NullEvaluation argument = check_null_evaluation_for_subject(
        (const Node *) ((const ConvertRowtypeExpr *) expr)->arg, subject);

      return make_null_evaluation(argument.proof,
                                  argument.evaluation_safe &&
                                    argument.proof == NULL_PROOF_NULL,
                                  argument.depends_on_subject);
    }
    case T_NullTest:
    {
      const NullTest *test = (const NullTest *) expr;
      NullEvaluation argument = check_null_evaluation_for_subject(
        (const Node *) test->arg, subject);

      if (test->argisrow || argument.proof == NULL_PROOF_UNKNOWN)
      {
        return make_null_evaluation(NULL_PROOF_UNKNOWN,
                                    argument.evaluation_safe,
                                    argument.depends_on_subject);
      }
      if (argument.proof == NULL_PROOF_NULL)
      {
        return make_null_evaluation(
          test->nulltesttype == IS_NULL ? NULL_PROOF_TRUE : NULL_PROOF_FALSE,
          argument.evaluation_safe, argument.depends_on_subject);
      }
      return make_null_evaluation(
        test->nulltesttype == IS_NULL ? NULL_PROOF_FALSE : NULL_PROOF_TRUE,
        argument.evaluation_safe, argument.depends_on_subject);
    }
    case T_BooleanTest:
    {
      const BooleanTest *test = (const BooleanTest *) expr;
      NullEvaluation argument = check_null_evaluation_for_subject(
        (const Node *) test->arg, subject);
      NullProof proof;

      if (argument.proof == NULL_PROOF_UNKNOWN ||
          argument.proof == NULL_PROOF_NONNULL)
      {
        return make_null_evaluation(NULL_PROOF_UNKNOWN,
                                    argument.evaluation_safe,
                                    argument.depends_on_subject);
      }
      switch (test->booltesttype)
      {
        case IS_TRUE:
          proof = argument.proof == NULL_PROOF_TRUE ? NULL_PROOF_TRUE : NULL_PROOF_FALSE;
          break;
        case IS_NOT_TRUE:
          proof = argument.proof == NULL_PROOF_TRUE ? NULL_PROOF_FALSE : NULL_PROOF_TRUE;
          break;
        case IS_FALSE:
          proof = argument.proof == NULL_PROOF_FALSE ? NULL_PROOF_TRUE : NULL_PROOF_FALSE;
          break;
        case IS_NOT_FALSE:
          proof = argument.proof == NULL_PROOF_FALSE ? NULL_PROOF_FALSE : NULL_PROOF_TRUE;
          break;
        case IS_UNKNOWN:
          proof = argument.proof == NULL_PROOF_NULL ? NULL_PROOF_TRUE : NULL_PROOF_FALSE;
          break;
        case IS_NOT_UNKNOWN:
          proof = argument.proof == NULL_PROOF_NULL ? NULL_PROOF_FALSE : NULL_PROOF_TRUE;
          break;
        default:
          proof = NULL_PROOF_UNKNOWN;
          break;
      }
      return make_null_evaluation(proof, argument.evaluation_safe,
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
        NullEvaluation argument = check_null_evaluation_for_subject(
          (const Node *) lfirst(cell), subject);

        evaluation_safe = evaluation_safe && argument.evaluation_safe;
        depends_on_subject = depends_on_subject ||
                             argument.depends_on_subject;
        if ((boolean->boolop == AND_EXPR && argument.proof == NULL_PROOF_FALSE) ||
            (boolean->boolop == OR_EXPR && argument.proof == NULL_PROOF_TRUE))
        {
          saw_decisive = true;
        }
        else if (argument.proof == NULL_PROOF_NULL)
        {
          saw_null = true;
        }
        else if (argument.proof == NULL_PROOF_UNKNOWN ||
                 argument.proof == NULL_PROOF_NONNULL)
        {
          saw_unknown = true;
        }
      }

      if (saw_decisive)
      {
        return make_null_evaluation(
          boolean->boolop == AND_EXPR ? NULL_PROOF_FALSE : NULL_PROOF_TRUE,
          evaluation_safe, depends_on_subject);
      }
      if (saw_unknown)
      {
        return make_null_evaluation(NULL_PROOF_UNKNOWN, evaluation_safe,
                                    depends_on_subject);
      }
      if (saw_null)
      {
        return make_null_evaluation(NULL_PROOF_NULL, evaluation_safe,
                                    depends_on_subject);
      }
      return make_null_evaluation(
        boolean->boolop == AND_EXPR ? NULL_PROOF_TRUE : NULL_PROOF_FALSE,
        evaluation_safe, depends_on_subject);
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
        NullEvaluation argument = check_null_evaluation_for_subject(
          (const Node *) lfirst(cell), subject);

        evaluation_safe = evaluation_safe && argument.evaluation_safe;
        depends_on_subject = depends_on_subject ||
                             argument.depends_on_subject;
        if (saw_unknown)
        {
          continue;
        }
        if (argument.proof == NULL_PROOF_NULL)
        {
          continue;
        }
        if (argument.proof == NULL_PROOF_UNKNOWN)
        {
          saw_unknown = true;
          continue;
        }
        return make_null_evaluation(argument.proof, evaluation_safe,
                                    depends_on_subject);
      }
      return make_null_evaluation(
        saw_unknown ? NULL_PROOF_UNKNOWN : NULL_PROOF_NULL,
        evaluation_safe, depends_on_subject);
    }
    case T_FuncExpr:
    {
      const FuncExpr *function = (const FuncExpr *) expr;
      ListCell *cell;
      bool all_arguments_safe = true;
      bool saw_safely_null_argument = false;
      bool depends_on_subject = false;

      foreach(cell, function->args)
      {
        NullEvaluation argument = check_null_evaluation_for_subject(
          (const Node *) lfirst(cell), subject);

        all_arguments_safe = all_arguments_safe && argument.evaluation_safe;
        depends_on_subject = depends_on_subject ||
                             argument.depends_on_subject;
        saw_safely_null_argument = saw_safely_null_argument ||
                                   (argument.evaluation_safe &&
                                    argument.proof == NULL_PROOF_NULL);
      }
      if (!func_strict(function->funcid))
      {
        return make_null_evaluation(NULL_PROOF_UNKNOWN,
                                    all_arguments_safe &&
                                      !depends_on_subject,
                                    depends_on_subject);
      }
      return all_arguments_safe && saw_safely_null_argument
               ? make_null_evaluation(NULL_PROOF_NULL, true,
                                      depends_on_subject)
               : make_null_evaluation(NULL_PROOF_UNKNOWN,
                                      all_arguments_safe &&
                                        !depends_on_subject,
                                      depends_on_subject);
    }
    case T_OpExpr:
    {
      const OpExpr *operation = (const OpExpr *) expr;
      ListCell *cell;
      bool all_arguments_safe = true;
      bool saw_safely_null_argument = false;
      bool depends_on_subject = false;

      foreach(cell, operation->args)
      {
        NullEvaluation argument = check_null_evaluation_for_subject(
          (const Node *) lfirst(cell), subject);

        all_arguments_safe = all_arguments_safe && argument.evaluation_safe;
        depends_on_subject = depends_on_subject ||
                             argument.depends_on_subject;
        saw_safely_null_argument = saw_safely_null_argument ||
                                   (argument.evaluation_safe &&
                                    argument.proof == NULL_PROOF_NULL);
      }
      if (!op_strict(operation->opno))
      {
        return make_null_evaluation(NULL_PROOF_UNKNOWN,
                                    all_arguments_safe &&
                                      !depends_on_subject,
                                    depends_on_subject);
      }
      return all_arguments_safe && saw_safely_null_argument
               ? make_null_evaluation(NULL_PROOF_NULL, true,
                                      depends_on_subject)
               : make_null_evaluation(NULL_PROOF_UNKNOWN,
                                      all_arguments_safe &&
                                        !depends_on_subject,
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
        NullEvaluation element = check_null_evaluation_for_subject(
          (const Node *) lfirst(cell), subject);

        evaluation_safe = evaluation_safe && element.evaluation_safe;
        depends_on_subject = depends_on_subject ||
                             element.depends_on_subject;
      }
      if (array->multidims)
      {
        ArrayShape shape = array_shape_proof(expr);

        evaluation_safe = evaluation_safe &&
                          shape.proof == ARRAY_SHAPE_VALID;
      }
      return make_null_evaluation(NULL_PROOF_NONNULL, evaluation_safe,
                                  depends_on_subject);
    }
    case T_ScalarArrayOpExpr:
    {
      const ScalarArrayOpExpr *operation = (const ScalarArrayOpExpr *) expr;
      const Node *scalar;
      const Node *array;
      ArrayCardinalityProof cardinality;
      NullEvaluation scalar_evaluation;
      NullEvaluation array_evaluation;
      bool evaluation_safe;
      bool depends_on_subject;

      if (!op_strict(operation->opno) || list_length(operation->args) != 2)
      {
        return make_null_evaluation(NULL_PROOF_UNKNOWN, false, true);
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
        return make_null_evaluation(
          operation->useOr ? NULL_PROOF_FALSE : NULL_PROOF_TRUE,
          evaluation_safe, depends_on_subject);
      }
      if (cardinality == ARRAY_CARDINALITY_NONEMPTY &&
          scalar_evaluation.proof == NULL_PROOF_NULL)
      {
        return make_null_evaluation(NULL_PROOF_NULL, evaluation_safe,
                                    depends_on_subject);
      }
      return make_null_evaluation(NULL_PROOF_UNKNOWN,
                                  evaluation_safe && !depends_on_subject,
                                  depends_on_subject);
    }
    default:
      return make_null_evaluation(NULL_PROOF_UNKNOWN, false, true);
  }
}

static NullEvaluation
check_null_evaluation(const Node *expr, AttrNumber target_attnum)
{
  const NullProofSubject subject = {target_attnum, 0, NULL};

  return check_null_evaluation_for_subject(expr, &subject);
}

static NullEvaluation
check_parameter_null_evaluation(const Node *expr, int param_id,
                                HTAB *node_analysis)
{
  const NullProofSubject subject = {0, param_id, node_analysis};

  return check_null_evaluation_for_subject(expr, &subject);
}

static TypeNullAdmission
null_evaluation_admission(NullEvaluation evaluation)
{
  if (evaluation.proof == NULL_PROOF_FALSE)
  {
    return TYPE_NULL_REJECTS;
  }
  if (evaluation.evaluation_safe &&
      (evaluation.proof == NULL_PROOF_TRUE ||
       evaluation.proof == NULL_PROOF_NULL))
  {
    return TYPE_NULL_ADMITS;
  }
  return TYPE_NULL_UNKNOWN;
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
        TypeNullAdmission check_admission = null_evaluation_admission(
          check_null_evaluation((const Node *) constraint->check_expr, 0));

        if (check_admission == TYPE_NULL_REJECTS)
        {
          admission = TYPE_NULL_REJECTS;
          break;
        }
        if (check_admission == TYPE_NULL_UNKNOWN)
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
                             NullEvaluation evaluation)
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
  if (null_evaluation_admission(evaluation) == TYPE_NULL_REJECTS)
  {
    entry->admission = TYPE_NULL_REJECTS;
  }
  else if (null_evaluation_admission(evaluation) == TYPE_NULL_UNKNOWN)
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
  NullEvaluation evaluation;

  if (!node_mentions_external_parameter(expr, &mention_context))
  {
    return;
  }

  evaluation = check_parameter_null_evaluation(expr, context->param_id,
                                               context->node_analysis);
  if (evaluation.proof == NULL_PROOF_NULL && evaluation.evaluation_safe)
  {
    mark_parameter_usage(context, TYPE_NULL_REJECTS);
  }
  else if (evaluation.proof == NULL_PROOF_UNKNOWN ||
           !evaluation.evaluation_safe)
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
      NullEvaluation argument = check_parameter_null_evaluation(
        (const Node *) coerce->arg, context->param_id,
        context->node_analysis);

      mark_parameter_usage(
        context,
        argument.evaluation_safe && argument.proof == NULL_PROOF_NULL
          ? type_null_admission(context->type_admissions,
                                coerce->resulttype)
          : TYPE_NULL_UNKNOWN);
      break;
    }
    case T_FuncExpr:
    {
      const FuncExpr *function = (const FuncExpr *) node;
      NullEvaluation evaluation = check_parameter_null_evaluation(
        node, context->param_id, context->node_analysis);

      if (!func_strict(function->funcid) ||
          evaluation.proof != NULL_PROOF_NULL ||
          !evaluation.evaluation_safe)
      {
        mark_parameter_usage(context, TYPE_NULL_UNKNOWN);
      }
      break;
    }
    case T_OpExpr:
    {
      const OpExpr *operation = (const OpExpr *) node;
      NullEvaluation evaluation = check_parameter_null_evaluation(
        node, context->param_id, context->node_analysis);

      if (!op_strict(operation->opno) ||
          evaluation.proof != NULL_PROOF_NULL ||
          !evaluation.evaluation_safe)
      {
        mark_parameter_usage(context, TYPE_NULL_UNKNOWN);
      }
      break;
    }
    case T_ScalarArrayOpExpr:
    {
      const ScalarArrayOpExpr *operation = (const ScalarArrayOpExpr *) node;
      NullEvaluation evaluation = check_parameter_null_evaluation(
        node, context->param_id, context->node_analysis);

      if (!op_strict(operation->opno) ||
          !evaluation.evaluation_safe ||
          (evaluation.proof != NULL_PROOF_NULL &&
           evaluation.proof != NULL_PROOF_TRUE &&
           evaluation.proof != NULL_PROOF_FALSE))
      {
        mark_parameter_usage(context, TYPE_NULL_UNKNOWN);
      }
      break;
    }
    case T_CoerceViaIO:
    {
      const CoerceViaIO *coerce = (const CoerceViaIO *) node;
      NullEvaluation argument = check_parameter_null_evaluation(
        (const Node *) coerce->arg, context->param_id,
        context->node_analysis);

      if (argument.proof != NULL_PROOF_NULL ||
          !argument.evaluation_safe)
      {
        mark_parameter_usage(context, TYPE_NULL_UNKNOWN);
      }
      break;
    }
    case T_ArrayCoerceExpr:
    {
      const ArrayCoerceExpr *coerce = (const ArrayCoerceExpr *) node;
      NullEvaluation argument = check_parameter_null_evaluation(
        (const Node *) coerce->arg, context->param_id,
        context->node_analysis);

      if (argument.proof != NULL_PROOF_NULL ||
          !argument.evaluation_safe)
      {
        mark_parameter_usage(context, TYPE_NULL_UNKNOWN);
      }
      break;
    }
    case T_ConvertRowtypeExpr:
    {
      const ConvertRowtypeExpr *coerce = (const ConvertRowtypeExpr *) node;
      NullEvaluation argument = check_parameter_null_evaluation(
        (const Node *) coerce->arg, context->param_id,
        context->node_analysis);

      if (argument.proof != NULL_PROOF_NULL ||
          !argument.evaluation_safe)
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
      bool arguments_safe = true;

      foreach(cell, distinct->args)
      {
        const Node *argument = (const Node *) lfirst(cell);
        NullEvaluation evaluation = check_parameter_null_evaluation(
          argument, context->param_id, context->node_analysis);

        arguments_safe = arguments_safe && evaluation.evaluation_safe;
        if (node_mentions_external_parameter(argument, &mention_context) &&
            evaluation.proof == NULL_PROOF_NULL &&
            evaluation.evaluation_safe)
        {
          null_short_circuit = true;
        }
      }
      if (!null_short_circuit || !arguments_safe)
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
    case T_BoolExpr:
    {
      NullEvaluation evaluation = check_parameter_null_evaluation(
        node, context->param_id, context->node_analysis);

      if (!evaluation.evaluation_safe)
      {
        mark_parameter_usage(context, TYPE_NULL_UNKNOWN);
      }
      break;
    }
    case T_Query:
    case T_List:
    case T_TargetEntry:
    case T_NamedArgExpr:
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
                                       check_null_evaluation(check, attnum));
        }
      }
      else
      {
        while ((attnum = bms_next_member(mentions.attnums, attnum)) >= 0)
        {
          update_column_null_admission(cache, relid, (AttrNumber) attnum,
                                       check_null_evaluation(check, (AttrNumber) attnum));
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
      NullEvaluation evaluation = key_attnum == target_attnum
                                    ? make_null_evaluation(NULL_PROOF_NULL, true, true)
                                    : target == NULL
                                        ? make_null_evaluation(NULL_PROOF_UNKNOWN, false, true)
                                        : check_parameter_null_evaluation(
                                            (const Node *) target->expr,
                                            param_id, NULL);

      if (!evaluation.evaluation_safe)
      {
        saw_unknown = true;
      }
      else if (evaluation.proof == NULL_PROOF_NULL)
      {
        saw_null = true;
      }
      else if (evaluation.proof == NULL_PROOF_UNKNOWN)
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
  direct_assignment = value_preserving && unconditional &&
                      !context->has_opaque_enforcement;

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

        if (variable_scope != NULL && var->varno > 0 &&
            var->varno <= list_length(variable_scope->query->rtable))
        {
          const RangeTblEntry *rte = rt_fetch(var->varno, variable_scope->query->rtable);

          if (variable_scope->query->onConflict != NULL &&
              var->varno == variable_scope->query->onConflict->exclRelIndex)
          {
            if (var->varattno > 0)
            {
              const TargetEntry *insert_target = target_entry_by_resno(
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
            QueryScope *child_scope = make_query_scope(rte->subquery, variable_scope);

            enqueue_lineage_work(context, &work, LINEAGE_WORK_QUERY_OUTPUT,
                                 child_scope, (const Node *) rte->subquery,
                                 var->varattno, item_admission,
                                 value_preserving, item->null_propagating,
                                 item->unconditional);
          }
          else if (var->varattno > 0 && rte->rtekind == RTE_CTE)
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
            const QueryScope *owner_scope = query_scope_at_level(
              variable_scope, rte->ctelevelsup);
            const CommonTableExpr *cte = owner_scope == NULL
                                           ? NULL
                                           : cte_by_name(owner_scope->query,
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

static RelationWriteEnforcement
relation_write_enforcement(Oid relid, const RangeTblEntry *target_rte,
                           CmdType command)
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
  /* Descendants can add stricter constraints and triggers than the parent. */
  result.opaque = (target_rte != NULL && target_rte->inh &&
                   has_subclass(relid)) ||
                  relation_form->relkind == RELKIND_PARTITIONED_TABLE ||
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
      relation_write_enforcement(target_relid, target_rte,
                                 query->commandType);

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
      relation_write_enforcement(target_relid, target_rte, CMD_UPDATE);

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
      relation_write_enforcement(target_relid, target_rte, CMD_INSERT);
    RelationWriteEnforcement update_enforcement =
      relation_write_enforcement(target_relid, target_rte, CMD_UPDATE);

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
      append_bool_field(out, "funcVariadic", func->funcvariadic);
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
aggregate_invokes_volatile_function(Oid aggregate_oid, const List *args,
                                    bool target_entries, Oid result_type,
                                    int32 result_typmod)
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
  ArrayShape array_shape;

  if (list_length(expression->args) != 2)
  {
    return true;
  }

  array_argument = (const Node *) lsecond(expression->args);
  array_shape = array_shape_proof(array_argument);
  /* Keep this cutoff synchronized with convert_saop_to_hashed_saop(). */
  if (array_shape.proof == ARRAY_SHAPE_VALID &&
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
  RUNTIME_TYPE_IO_TEXT_OUTPUT
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
  Oid io_function;
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
  io_function = kind == RUNTIME_TYPE_IO_TEXT_INPUT
                  ? type->typinput
                  : kind == RUNTIME_TYPE_IO_BINARY_RECEIVE
                      ? type->typreceive
                      : type->typoutput;
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

    if ((kind == RUNTIME_TYPE_IO_TEXT_INPUT ||
         kind == RUNTIME_TYPE_IO_BINARY_RECEIVE) &&
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
      nested_typmod = kind == RUNTIME_TYPE_IO_TEXT_OUTPUT ? -1 : typmod;
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
      if ((kind == RUNTIME_TYPE_IO_TEXT_INPUT ||
           kind == RUNTIME_TYPE_IO_BINARY_RECEIVE) &&
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
      if ((kind == RUNTIME_TYPE_IO_TEXT_INPUT ||
           kind == RUNTIME_TYPE_IO_BINARY_RECEIVE) &&
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
operator_operand_is_execution_relevant_walker(Node *node, void *context)
{
  const QueryScope *scope = (const QueryScope *) context;

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
    const QueryScope *owner_scope = query_scope_at_level(
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
                                             const QueryScope *scope)
{
  return operator_operand_is_execution_relevant_walker(node, (void *) scope);
}

static bool
operator_family_support_type_pair_is_relevant(const Form_pg_amop operator_form,
                                              const Form_pg_amproc support_form)
{
  if (operator_form->amopmethod != BTREE_AM_OID &&
      operator_form->amopmethod != HASH_AM_OID)
  {
    return true;
  }

  return (support_form->amproclefttype == operator_form->amoplefttype ||
          support_form->amproclefttype == operator_form->amoprighttype) &&
         (support_form->amprocrighttype == operator_form->amoplefttype ||
          support_form->amprocrighttype == operator_form->amoprighttype);
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
node_invokes_volatile_function(Node *node, const QueryScope *scope)
{
  switch (nodeTag(node))
  {
    case T_Aggref:
    {
      Aggref *aggregate = (Aggref *) node;

      return aggregate_invokes_volatile_function(
               aggregate->aggfnoid, aggregate->args, true,
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
    case T_Param:
    {
      Param *param = (Param *) node;

      /*
       * External parameters are represented without their text-input or
       * binary-receive call in the expression tree.  Include those hidden I/O
       * paths, including nested container I/O and domain constraints.
       */
      return param->paramkind == PARAM_EXTERN &&
             external_parameter_io_invokes_volatile(
               param->paramtype, exprTypmod(node));
    }
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

      return type_runtime_support_invokes_volatile(
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
  if (node_invokes_volatile_function(
        node, volatile_context == NULL ? NULL : volatile_context->scope))
  {
    return true;
  }
  if (IsA(node, Query))
  {
    Query *query = (Query *) node;
    QueryScope query_scope = {
      query,
      volatile_context == NULL ? NULL : volatile_context->scope
    };
    VolatileFunctionContext query_context = {&query_scope};

    return query_sort_group_support_invokes_volatile_function(query) ||
           query_tree_walker(query, volatile_function_walker,
                             &query_context, 0);
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
