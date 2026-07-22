#include "postgres.h"

#include "access/table.h"
#include "lib/stringinfo.h"
#include "nodes/nodeFuncs.h"
#include "parser/parsetree.h"
#include "utils/hsearch.h"
#include "utils/rel.h"

#include "dml_analysis.h"
#include "dml_lineage.h"
#include "null_admission.h"
#include "null_evaluation.h"
#include "null_substitution.h"

typedef struct ParamCollector { Bitmapset *params; } ParamCollector;

typedef struct DirectOutputKey
{
  int param_id;
  Oid target_relid;
  AttrNumber target_attnum;
  Oid target_type_oid;
} DirectOutputKey;

typedef struct AdmissionOutputKey
{
  int param_id;
  enum AdmissionOutputKind
  {
    ADMISSION_ACTION_UNREACHABLE,
    ADMISSION_ROW_VALUES_PRESERVED,
    ADMISSION_DIRECT_ACCEPTS,
    ADMISSION_DIRECT_REJECTS,
    ADMISSION_UNRESOLVED
  } kind;
} AdmissionOutputKey;

static const char *
admission_output_admission(enum AdmissionOutputKind kind)
{
  switch (kind)
  {
    case ADMISSION_ACTION_UNREACHABLE:
    case ADMISSION_ROW_VALUES_PRESERVED:
    case ADMISSION_DIRECT_ACCEPTS:
      return pts_null_admission_name(PTS_NULL_ADMITS);
    case ADMISSION_DIRECT_REJECTS:
      return pts_null_admission_name(PTS_NULL_REJECTS);
    case ADMISSION_UNRESOLVED:
      return pts_null_admission_name(PTS_NULL_UNKNOWN);
  }
  pg_unreachable();
}

static const char *
admission_output_basis(enum AdmissionOutputKind kind)
{
  switch (kind)
  {
    case ADMISSION_ACTION_UNREACHABLE:
      return "action_unreachable_when_null";
    case ADMISSION_ROW_VALUES_PRESERVED:
      return "row_values_preserved_when_null";
    case ADMISSION_DIRECT_ACCEPTS:
    case ADMISSION_DIRECT_REJECTS:
      return "direct_target_null_admission";
    case ADMISSION_UNRESOLVED:
      return "unresolved";
  }
  pg_unreachable();
}

static bool
collect_params(Node *node, void *opaque)
{
  ParamCollector *collector = opaque;

  if (node == NULL)
    return false;
  if (IsA(node, Param))
  {
    const Param *param = (const Param *) node;

    if (param->paramkind == PARAM_EXTERN && param->paramid > 0)
      collector->params = bms_add_member(collector->params, param->paramid);
    return false;
  }
  return expression_tree_walker(node, collect_params, opaque);
}

static bool
whole_row_preserved(const Query *query, int param_id,
                    const RangeTblEntry *target_rte)
{
  Relation relation;
  TupleDesc descriptor;
  ListCell *cell;

  if (target_rte == NULL || !OidIsValid(target_rte->relid))
    return false;
  relation = table_open(target_rte->relid, AccessShareLock);
  descriptor = RelationGetDescr(relation);
  foreach(cell, query->targetList)
  {
    const TargetEntry *target = lfirst_node(TargetEntry, cell);
    PtsNullSubstitutionContext context;

    if (target->resjunk || target->resno <= 0)
      continue;
    if (target->resno > descriptor->natts ||
        TupleDescAttr(descriptor, target->resno - 1)->attisdropped)
    {
      table_close(relation, AccessShareLock);
      return false;
    }
    context.query = query;
    context.param_id = param_id;
    context.target_attnum = target->resno;
    context.old_target_nullness =
      TupleDescAttr(descriptor, target->resno - 1)->attnotnull
        ? PTS_OLD_TARGET_NULLNESS_NONNULL
        : PTS_OLD_TARGET_NULLNESS_UNKNOWN;
    if (!pts_null_substitution_preserves_old_target(
          (const Node *) target->expr, &context))
    {
      table_close(relation, AccessShareLock);
      return false;
    }
  }
  table_close(relation, AccessShareLock);
  return true;
}

static Bitmapset *
prove_action_wide_admissions(const Query *query)
{
  const RangeTblEntry *target_rte = NULL;
  PtsDmlWriteEnforcement *enforcement;
  ParamCollector collector = {NULL};
  Bitmapset *proven = NULL;
  ListCell *cell;
  int param_id = -1;

  if (query->commandType != CMD_UPDATE || query->resultRelation <= 0 ||
      query->resultRelation > list_length(query->rtable))
    return NULL;
  target_rte = rt_fetch(query->resultRelation, query->rtable);
  enforcement = pts_inspect_dml_write_enforcement(query, target_rte, CMD_UPDATE);
  if (query->onConflict != NULL || query->mergeActionList != NIL ||
      query->querySource != QSRC_ORIGINAL ||
      !pts_dml_write_allows_action_unreachable_proof(enforcement))
  {
    pts_release_dml_write_enforcement(enforcement);
    return NULL;
  }

  foreach(cell, query->targetList)
  {
    const TargetEntry *target = lfirst_node(TargetEntry, cell);

    if (!target->resjunk && target->resno > 0)
      collect_params((Node *) target->expr, &collector);
  }
  while ((param_id = bms_next_member(collector.params, param_id)) >= 0)
  {
    PtsNullEvaluation predicate = query->jointree == NULL ||
                                  query->jointree->quals == NULL
      ? pts_make_null_evaluation(PTS_NULL_PROOF_TRUE, true, false)
      : pts_check_parameter_null_evaluation(query->jointree->quals, param_id,
                                            NULL);

    if (predicate.evaluation_safe &&
        (predicate.proof == PTS_NULL_PROOF_FALSE ||
         predicate.proof == PTS_NULL_PROOF_NULL))
    {
      proven = bms_add_member(proven, param_id);
    }
    else if (pts_dml_write_allows_old_row_preservation_proof(enforcement) &&
             predicate.evaluation_safe &&
             (predicate.proof == PTS_NULL_PROOF_TRUE ||
              predicate.proof == PTS_NULL_PROOF_UNKNOWN) &&
             whole_row_preserved(query, param_id, target_rte))
    {
      proven = bms_add_member(proven, param_id);
    }
  }
  bms_free(collector.params);
  pts_release_dml_write_enforcement(enforcement);
  return proven;
}

static bool
same_admission_key(const AdmissionOutputKey *left,
                   const AdmissionOutputKey *right)
{
  return left->param_id == right->param_id &&
         left->kind == right->kind;
}

void
pts_append_dml_analysis(StringInfo out, const Query *query)
{
  List *lineage = pts_collect_dml_lineage(query);
  Bitmapset *action_proven_params = prove_action_wide_admissions(query);
  List *direct_keys = NIL;
  List *admission_keys = NIL;
  ListCell *cell;
  bool first = true;

  appendStringInfoString(out, ",\"dmlDirectAssignments\":[");
  foreach(cell, lineage)
  {
    const PtsDmlLineageFact *fact = lfirst(cell);
    DirectOutputKey key;
    ListCell *seen_cell;
    bool seen = false;

    if (!fact->direct_assignment)
      continue;
    memset(&key, 0, sizeof(key));
    key.param_id = fact->param_id;
    key.target_relid = fact->target_relid;
    key.target_attnum = fact->target_attnum;
    key.target_type_oid = fact->target_type_oid;
    foreach(seen_cell, direct_keys)
      if (memcmp(lfirst(seen_cell), &key, sizeof(key)) == 0) { seen = true; break; }
    if (seen)
      continue;
    direct_keys = lappend(direct_keys, palloc(sizeof(key)));
    memcpy(llast(direct_keys), &key, sizeof(key));
    if (!first) appendStringInfoChar(out, ',');
    first = false;
    appendStringInfo(out,
      "{\"paramId\":%d,\"targetRelid\":%u,\"targetAttnum\":%d,\"targetTypeOid\":%u}",
      key.param_id, key.target_relid, key.target_attnum, key.target_type_oid);
  }
  appendStringInfoString(out, "],\"dmlParameterNullAdmissions\":[");
  first = true;

  for (int param_id = -1;
       (param_id = bms_next_member(action_proven_params, param_id)) >= 0;)
  {
    enum AdmissionOutputKind kind;
    PtsNullEvaluation predicate = query->jointree == NULL ||
                                  query->jointree->quals == NULL
      ? pts_make_null_evaluation(PTS_NULL_PROOF_TRUE, true, false)
      : pts_check_parameter_null_evaluation(query->jointree->quals, param_id, NULL);
    kind = predicate.evaluation_safe &&
           (predicate.proof == PTS_NULL_PROOF_FALSE ||
            predicate.proof == PTS_NULL_PROOF_NULL)
      ? ADMISSION_ACTION_UNREACHABLE : ADMISSION_ROW_VALUES_PRESERVED;
    if (!first) appendStringInfoChar(out, ',');
    first = false;
    appendStringInfo(out, "{\"paramId\":%d,\"admission\":\"%s\",\"basis\":\"%s\"}",
                     param_id, admission_output_admission(kind),
                     admission_output_basis(kind));
  }
  foreach(cell, lineage)
  {
    const PtsDmlLineageFact *fact = lfirst(cell);
    AdmissionOutputKey key = {
      fact->param_id,
      fact->admission == PTS_NULL_ADMITS ? ADMISSION_DIRECT_ACCEPTS
        : fact->admission == PTS_NULL_REJECTS ? ADMISSION_DIRECT_REJECTS
        : ADMISSION_UNRESOLVED
    };
    ListCell *seen_cell;
    bool seen = bms_is_member(fact->param_id, action_proven_params);

    foreach(seen_cell, admission_keys)
      if (same_admission_key(lfirst(seen_cell), &key)) { seen = true; break; }
    if (seen)
      continue;
    {
      AdmissionOutputKey *copy = palloc(sizeof(*copy));
      *copy = key;
      admission_keys = lappend(admission_keys, copy);
    }
    if (!first) appendStringInfoChar(out, ',');
    first = false;
    appendStringInfo(out, "{\"paramId\":%d,\"admission\":\"%s\",\"basis\":\"%s\"}",
                     key.param_id, admission_output_admission(key.kind),
                     admission_output_basis(key.kind));
  }
  appendStringInfoChar(out, ']');
  list_free_deep(admission_keys);
  list_free_deep(direct_keys);
  bms_free(action_proven_params);
  list_free_deep(lineage);
}
