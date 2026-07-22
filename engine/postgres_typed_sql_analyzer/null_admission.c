#include "postgres.h"

#include "access/genam.h"
#include "access/htup_details.h"
#include "access/table.h"
#include "catalog/index.h"
#include "catalog/pg_class.h"
#include "catalog/pg_constraint.h"
#include "catalog/pg_inherits.h"
#include "catalog/pg_trigger.h"
#include "catalog/pg_type.h"
#include "commands/trigger.h"
#include "nodes/nodeFuncs.h"
#include "optimizer/optimizer.h"
#include "parser/parsetree.h"
#include "utils/fmgroids.h"
#include "utils/hsearch.h"
#include "utils/lsyscache.h"
#include "utils/rel.h"
#include "utils/relcache.h"
#include "utils/syscache.h"
#include "utils/typcache.h"

#include "null_admission.h"
#include "null_evaluation.h"
#include "query_scope.h"

typedef struct ColumnNullAdmissionKey
{
  Oid relid;
  AttrNumber attnum;
} ColumnNullAdmissionKey;

typedef struct ColumnNullAdmissionEntry
{
  ColumnNullAdmissionKey key;
  PtsNullAdmission admission;
} ColumnNullAdmissionEntry;

typedef struct TypeNullAdmissionEntry
{
  Oid type_oid;
  PtsNullAdmission admission;
} TypeNullAdmissionEntry;

struct PtsNullAdmissionAnalysis
{
  HTAB *type_admissions;
  HTAB *column_admissions;
};

struct PtsDmlWriteEnforcement
{
  bool structural_assignment_identity;
  bool action_unreachable_proof;
  bool old_row_preservation_proof;
  bool complete_target_null_constraints;
  bool has_generated_columns;
  List *match_full_foreign_keys;
};

PtsNullAdmission
pts_combine_null_admission(PtsNullAdmission left, PtsNullAdmission right)
{
  if (left == PTS_NULL_REJECTS || right == PTS_NULL_REJECTS)
    return PTS_NULL_REJECTS;
  if (left == PTS_NULL_UNKNOWN || right == PTS_NULL_UNKNOWN)
    return PTS_NULL_UNKNOWN;
  return PTS_NULL_ADMITS;
}

const char *
pts_null_admission_name(PtsNullAdmission admission)
{
  switch (admission)
  {
    case PTS_NULL_ADMITS: return "accepts";
    case PTS_NULL_REJECTS: return "rejects";
    case PTS_NULL_UNKNOWN: return "unknown";
  }
  return "unknown";
}

PtsNullAdmissionAnalysis *
pts_create_null_admission_analysis(void)
{
  HASHCTL type_control;
  HASHCTL column_control;
  PtsNullAdmissionAnalysis *analysis = palloc(sizeof(*analysis));

  memset(&type_control, 0, sizeof(type_control));
  type_control.keysize = sizeof(Oid);
  type_control.entrysize = sizeof(TypeNullAdmissionEntry);
  analysis->type_admissions = hash_create(
    "typed SQL type NULL admissions", 16, &type_control,
    HASH_ELEM | HASH_BLOBS);
  memset(&column_control, 0, sizeof(column_control));
  column_control.keysize = sizeof(ColumnNullAdmissionKey);
  column_control.entrysize = sizeof(ColumnNullAdmissionEntry);
  analysis->column_admissions = hash_create(
    "typed SQL column NULL admissions", 16, &column_control,
    HASH_ELEM | HASH_BLOBS);
  return analysis;
}

void
pts_destroy_null_admission_analysis(PtsNullAdmissionAnalysis *analysis)
{
  if (analysis == NULL)
    return;
  hash_destroy(analysis->type_admissions);
  hash_destroy(analysis->column_admissions);
  pfree(analysis);
}

static PtsNullAdmission
null_evaluation_admission(PtsNullEvaluation evaluation)
{
  if (evaluation.proof == PTS_NULL_PROOF_FALSE)
    return PTS_NULL_REJECTS;
  if (evaluation.evaluation_safe &&
      (evaluation.proof == PTS_NULL_PROOF_TRUE ||
       evaluation.proof == PTS_NULL_PROOF_NULL))
    return PTS_NULL_ADMITS;
  return PTS_NULL_UNKNOWN;
}

PtsNullAdmission
pts_type_null_admission(PtsNullAdmissionAnalysis *analysis, Oid type_oid)
{
  TypeNullAdmissionEntry *entry;
  HeapTuple tuple;
  Form_pg_type type;
  bool found;
  PtsNullAdmission admission = PTS_NULL_ADMITS;

  entry = analysis == NULL
            ? NULL
            : hash_search(analysis->type_admissions, &type_oid,
                          HASH_FIND, &found);
  if (entry != NULL && found)
    return entry->admission;

  tuple = SearchSysCache1(TYPEOID, ObjectIdGetDatum(type_oid));
  if (!HeapTupleIsValid(tuple))
    elog(ERROR, "cache lookup failed for type %u", type_oid);
  type = (Form_pg_type) GETSTRUCT(tuple);
  if (type->typtype == TYPTYPE_DOMAIN)
  {
    DomainConstraintRef *constraints;
    ListCell *cell;

    constraints = palloc(sizeof(*constraints));
    InitDomainConstraintRef(type_oid, constraints, CurrentMemoryContext, false);
    foreach(cell, constraints->constraints)
    {
      const DomainConstraintState *constraint =
        lfirst_node(DomainConstraintState, cell);

      if (constraint->constrainttype == DOM_CONSTRAINT_NOTNULL)
      {
        admission = PTS_NULL_REJECTS;
        break;
      }
      if (constraint->constrainttype == DOM_CONSTRAINT_CHECK)
        admission = pts_combine_null_admission(
          admission, null_evaluation_admission(pts_check_null_evaluation(
            (const Node *) constraint->check_expr, 0)));
    }
  }
  ReleaseSysCache(tuple);

  if (analysis != NULL)
  {
    entry = hash_search(analysis->type_admissions, &type_oid,
                        HASH_ENTER, &found);
    entry->admission = admission;
  }

  return admission;
}

typedef struct ColumnMentionsContext
{
  Bitmapset *attnums;
  bool whole_row;
} ColumnMentionsContext;

static bool
collect_column_mentions(Node *node, void *opaque)
{
  ColumnMentionsContext *context = opaque;

  if (node == NULL)
    return false;
  if (IsA(node, Var))
  {
    const Var *variable = (const Var *) node;
    if (variable->varlevelsup == 0 && variable->varno == 1)
    {
      if (variable->varattno > 0)
        context->attnums = bms_add_member(context->attnums,
                                           variable->varattno);
      else if (variable->varattno == InvalidAttrNumber)
        context->whole_row = true;
    }
  }
  return expression_tree_walker(node, collect_column_mentions, opaque);
}

static void
update_column_admission(HTAB *cache, Oid relid, AttrNumber attnum,
                        PtsNullEvaluation evaluation)
{
  ColumnNullAdmissionKey key;
  ColumnNullAdmissionEntry *entry;
  bool found;

  memset(&key, 0, sizeof(key));
  key.relid = relid;
  key.attnum = attnum;
  entry = hash_search(cache, &key, HASH_FIND, &found);
  if (found)
    entry->admission = pts_combine_null_admission(
      entry->admission, null_evaluation_admission(evaluation));
}

static void
populate_column_admissions(HTAB *cache, Oid relid)
{
  Relation relation = table_open(relid, AccessShareLock);
  TupleDesc descriptor = RelationGetDescr(relation);
  TupleConstr *constraints = descriptor->constr;
  int index;

  for (index = 0; index < descriptor->natts; index++)
  {
    Form_pg_attribute attribute = TupleDescAttr(descriptor, index);
    ColumnNullAdmissionKey key;
    ColumnNullAdmissionEntry *entry;
    bool found;

    if (attribute->attisdropped)
      continue;
    memset(&key, 0, sizeof(key));
    key.relid = relid;
    key.attnum = attribute->attnum;
    entry = hash_search(cache, &key, HASH_ENTER, &found);
    entry->admission = PTS_NULL_ADMITS;
  }
  if (constraints != NULL)
  {
    for (index = 0; index < constraints->num_check; index++)
    {
      const ConstrCheck *constraint = &constraints->check[index];
      ColumnMentionsContext mentions = {NULL, false};
      Node *check;
      int attnum = -1;

      if (!constraint->ccenforced)
        continue;
      if (!constraint->ccvalid || constraint->ccbin == NULL ||
          contain_mutable_functions((Node *) stringToNode(constraint->ccbin)))
        continue; /* The inspector makes all target admission opaque. */
      check = stringToNode(constraint->ccbin);
      collect_column_mentions(check, &mentions);
      if (mentions.whole_row)
      {
        for (attnum = 1; attnum <= descriptor->natts; attnum++)
          update_column_admission(cache, relid, attnum,
            pts_check_null_evaluation(check, attnum));
      }
      else if (bms_is_empty(mentions.attnums))
      {
        for (attnum = 1; attnum <= descriptor->natts; attnum++)
          update_column_admission(cache, relid, attnum,
            pts_check_null_evaluation(check, attnum));
      }
      else
      {
        while ((attnum = bms_next_member(mentions.attnums, attnum)) >= 0)
          update_column_admission(cache, relid, (AttrNumber) attnum,
            pts_check_null_evaluation(check, (AttrNumber) attnum));
      }
      bms_free(mentions.attnums);
    }
  }
  table_close(relation, AccessShareLock);
}

PtsNullAdmission
pts_column_check_null_admission(PtsNullAdmissionAnalysis *analysis, Oid relid,
                                AttrNumber target_attnum)
{
  HTAB *cache = analysis == NULL ? NULL : analysis->column_admissions;
  ColumnNullAdmissionKey key;
  ColumnNullAdmissionEntry *entry;
  bool found;

  if (cache == NULL)
    return PTS_NULL_UNKNOWN;
  memset(&key, 0, sizeof(key));
  key.relid = relid;
  key.attnum = target_attnum;
  entry = hash_search(cache, &key, HASH_FIND, &found);
  if (!found)
  {
    populate_column_admissions(cache, relid);
    entry = hash_search(cache, &key, HASH_FIND, &found);
  }
  return found ? entry->admission : PTS_NULL_UNKNOWN;
}

PtsNullAdmission
pts_match_full_null_admission(const List *foreign_keys,
                              const List *target_list, int param_id,
                              AttrNumber target_attnum)
{
  PtsNullAdmission admission = PTS_NULL_ADMITS;
  ListCell *cell;

  foreach(cell, foreign_keys)
  {
    const ForeignKeyCacheInfo *foreign_key =
      lfirst_node(ForeignKeyCacheInfo, cell);
    bool applies = false;
    bool saw_null = false;
    bool saw_nonnull = false;
    bool saw_unknown = false;
    int index;

    for (index = 0; index < foreign_key->nkeys; index++)
      applies |= foreign_key->conkey[index] == target_attnum;
    if (!applies)
      continue;
    for (index = 0; index < foreign_key->nkeys; index++)
    {
      AttrNumber attnum = foreign_key->conkey[index];
      const TargetEntry *target = pts_target_entry_by_resno(target_list,
                                                            attnum);
      PtsNullEvaluation evaluation = attnum == target_attnum
        ? pts_make_null_evaluation(PTS_NULL_PROOF_NULL, true, true)
        : target == NULL
          ? pts_make_null_evaluation(PTS_NULL_PROOF_UNKNOWN, false, true)
          : pts_check_parameter_null_evaluation((const Node *) target->expr,
                                                param_id, NULL);

      if (!evaluation.evaluation_safe ||
          evaluation.proof == PTS_NULL_PROOF_UNKNOWN)
        saw_unknown = true;
      else if (evaluation.proof == PTS_NULL_PROOF_NULL)
        saw_null = true;
      else
        saw_nonnull = true;
    }
    if (saw_null && saw_nonnull)
      admission = pts_combine_null_admission(admission, PTS_NULL_REJECTS);
    else if (saw_unknown)
      admission = pts_combine_null_admission(admission, PTS_NULL_UNKNOWN);
  }
  return admission;
}

static bool
relation_has_unvalidated_enforced_constraint(Oid relid)
{
  Relation constraint_relation;
  SysScanDesc scan;
  ScanKeyData key;
  HeapTuple tuple;
  bool found = false;

  constraint_relation = table_open(ConstraintRelationId, AccessShareLock);
  ScanKeyInit(&key, Anum_pg_constraint_conrelid, BTEqualStrategyNumber,
              F_OIDEQ, ObjectIdGetDatum(relid));
  scan = systable_beginscan(constraint_relation,
                            ConstraintRelidTypidNameIndexId, true, NULL, 1,
                            &key);
  while (HeapTupleIsValid(tuple = systable_getnext(scan)))
  {
    Form_pg_constraint constraint = (Form_pg_constraint) GETSTRUCT(tuple);
    if (constraint->conenforced && !constraint->convalidated)
    {
      found = true;
      break;
    }
  }
  systable_endscan(scan);
  table_close(constraint_relation, AccessShareLock);
  return found;
}

PtsDmlWriteEnforcement *
pts_inspect_dml_write_enforcement(const Query *query,
                                  const RangeTblEntry *target_rte,
                                  CmdType action)
{
  PtsDmlWriteEnforcement *result = palloc0(sizeof(*result));
  Oid relid = target_rte == NULL ? InvalidOid : target_rte->relid;
  Relation relation;
  Form_pg_class form;
  TupleDesc descriptor;
  List *foreign_keys;
  List *index_oids;
  ListCell *cell;
  bool identity_opaque = false;
  bool action_unreachable_opaque = false;
  bool preservation_opaque = false;
  bool admission_incomplete = false;
  bool routed_target;
  bool security_boundary;
  bool unvalidated_enforcement;
  int index;

  if (query == NULL || !OidIsValid(relid) ||
      (action != CMD_INSERT && action != CMD_UPDATE))
    return result;

  relation = table_open(relid, AccessShareLock);
  form = RelationGetForm(relation);
  descriptor = RelationGetDescr(relation);
  routed_target = (target_rte->inh && has_subclass(relid)) ||
                  form->relkind == RELKIND_PARTITIONED_TABLE;
  security_boundary = form->relrowsecurity || form->relforcerowsecurity ||
                      query->hasRowSecurity;
  unvalidated_enforcement =
    relation_has_unvalidated_enforced_constraint(relid);
  identity_opaque = form->relkind == RELKIND_FOREIGN_TABLE;
  action_unreachable_opaque =
    form->relkind == RELKIND_FOREIGN_TABLE || security_boundary;
  preservation_opaque = routed_target ||
                        form->relkind == RELKIND_FOREIGN_TABLE ||
                        security_boundary || query->withCheckOptions != NIL ||
                        unvalidated_enforcement;
  admission_incomplete = routed_target || form->relispartition ||
                         form->relkind == RELKIND_FOREIGN_TABLE ||
                         security_boundary || query->withCheckOptions != NIL ||
                         unvalidated_enforcement;

  for (index = 0; index < descriptor->natts; index++)
  {
    Form_pg_attribute attribute = TupleDescAttr(descriptor, index);
    if (!attribute->attisdropped && attribute->attgenerated != '\0')
    {
      result->has_generated_columns = true;
      admission_incomplete = true;
      preservation_opaque = true;
    }
  }
  if (descriptor->constr != NULL)
  {
    for (index = 0; index < descriptor->constr->num_check; index++)
    {
      const ConstrCheck *check = &descriptor->constr->check[index];
      if (check->ccenforced &&
          (!check->ccvalid || check->ccbin == NULL ||
           contain_mutable_functions((Node *) stringToNode(check->ccbin))))
      {
        admission_incomplete = true;
        preservation_opaque = true;
      }
    }
  }

  for (index = 0; relation->trigdesc != NULL &&
                  index < relation->trigdesc->numtriggers; index++)
  {
    const Trigger *trigger = &relation->trigdesc->triggers[index];
    bool relevant =
      (action == CMD_INSERT && TRIGGER_FOR_INSERT(trigger->tgtype)) ||
      (action == CMD_UPDATE && TRIGGER_FOR_UPDATE(trigger->tgtype));
    if (relevant && trigger->tgenabled != TRIGGER_DISABLED &&
        (!trigger->tgisinternal || trigger->tgisclone))
    {
      if (TRIGGER_FOR_BEFORE(trigger->tgtype) ||
          TRIGGER_FOR_INSTEAD(trigger->tgtype))
        identity_opaque = true;
      preservation_opaque = true;
      admission_incomplete = true;
      if (!TRIGGER_FOR_ROW(trigger->tgtype))
        action_unreachable_opaque = true;
    }
  }

  index_oids = RelationGetIndexList(relation);
  foreach(cell, index_oids)
  {
    Oid index_oid = lfirst_oid(cell);
    Relation index_relation = index_open(index_oid, AccessShareLock);
    if (index_relation->rd_index != NULL &&
        (RelationGetIndexExpressions(index_relation) != NIL ||
         RelationGetIndexPredicate(index_relation) != NIL ||
         index_relation->rd_index->indisexclusion ||
         (index_relation->rd_index->indisunique &&
          index_relation->rd_index->indnullsnotdistinct)))
      admission_incomplete = true;
    index_close(index_relation, AccessShareLock);
  }
  list_free(index_oids);

  foreign_keys = copyObject(RelationGetFKeyList(relation));
  foreach(cell, foreign_keys)
  {
    const ForeignKeyCacheInfo *foreign_key =
      lfirst_node(ForeignKeyCacheInfo, cell);
    HeapTuple tuple = SearchSysCache1(CONSTROID,
                                      ObjectIdGetDatum(foreign_key->conoid));
    if (!HeapTupleIsValid(tuple))
    {
      admission_incomplete = true;
      continue;
    }
    if (((Form_pg_constraint) GETSTRUCT(tuple))->conenforced &&
        ((Form_pg_constraint) GETSTRUCT(tuple))->confmatchtype ==
          FKCONSTR_MATCH_FULL)
      result->match_full_foreign_keys =
        lappend(result->match_full_foreign_keys,
                (void *) copyObject(foreign_key));
    ReleaseSysCache(tuple);
  }
  list_free_deep(foreign_keys);
  table_close(relation, AccessShareLock);

  result->structural_assignment_identity = !identity_opaque;
  result->action_unreachable_proof = !action_unreachable_opaque;
  result->old_row_preservation_proof = !preservation_opaque;
  result->complete_target_null_constraints = !admission_incomplete;
  return result;
}

void
pts_release_dml_write_enforcement(PtsDmlWriteEnforcement *enforcement)
{
  if (enforcement == NULL)
    return;
  list_free_deep(enforcement->match_full_foreign_keys);
  pfree(enforcement);
}

bool
pts_dml_write_has_structural_assignment_identity(
  const PtsDmlWriteEnforcement *enforcement)
{
  return enforcement != NULL && enforcement->structural_assignment_identity;
}

bool
pts_dml_write_allows_action_unreachable_proof(
  const PtsDmlWriteEnforcement *enforcement)
{
  return enforcement != NULL && enforcement->action_unreachable_proof;
}

bool
pts_dml_write_allows_old_row_preservation_proof(
  const PtsDmlWriteEnforcement *enforcement)
{
  return enforcement != NULL && enforcement->old_row_preservation_proof;
}

bool
pts_dml_write_has_complete_target_null_constraints(
  const PtsDmlWriteEnforcement *enforcement)
{
  return enforcement != NULL && enforcement->complete_target_null_constraints;
}

bool
pts_dml_write_has_generated_columns(
  const PtsDmlWriteEnforcement *enforcement)
{
  return enforcement != NULL && enforcement->has_generated_columns;
}

const List *
pts_dml_write_match_full_foreign_keys(
  const PtsDmlWriteEnforcement *enforcement)
{
  return enforcement == NULL ? NIL : enforcement->match_full_foreign_keys;
}
