#ifndef POSTGRES_TYPED_SQL_NULL_ADMISSION_H
#define POSTGRES_TYPED_SQL_NULL_ADMISSION_H

#include "postgres.h"

#include "nodes/bitmapset.h"
#include "nodes/parsenodes.h"

typedef enum PtsNullAdmission
{
  PTS_NULL_ADMITS,
  PTS_NULL_REJECTS,
  PTS_NULL_UNKNOWN
} PtsNullAdmission;

typedef struct PtsNullAdmissionAnalysis PtsNullAdmissionAnalysis;

/* Opaque: callers must use the capability queries below. */
typedef struct PtsDmlWriteEnforcement PtsDmlWriteEnforcement;

extern PtsNullAdmission pts_combine_null_admission(PtsNullAdmission left,
                                                   PtsNullAdmission right);
extern const char *pts_null_admission_name(PtsNullAdmission admission);
extern PtsNullAdmissionAnalysis *pts_create_null_admission_analysis(void);
extern void pts_destroy_null_admission_analysis(
  PtsNullAdmissionAnalysis *analysis);
extern PtsNullAdmission pts_type_null_admission(
  PtsNullAdmissionAnalysis *analysis, Oid type_oid);
extern PtsNullAdmission pts_column_check_null_admission(
  PtsNullAdmissionAnalysis *analysis, Oid relid, AttrNumber target_attnum);
extern PtsNullAdmission pts_match_full_null_admission(
  const List *foreign_keys, const List *target_list, int param_id,
  AttrNumber target_attnum);

extern PtsDmlWriteEnforcement *pts_inspect_dml_write_enforcement(
  const Query *query, const RangeTblEntry *target_rte, CmdType action);
extern void pts_release_dml_write_enforcement(
  PtsDmlWriteEnforcement *enforcement);

extern bool pts_dml_write_has_structural_assignment_identity(
  const PtsDmlWriteEnforcement *enforcement);
extern bool pts_dml_write_allows_action_unreachable_proof(
  const PtsDmlWriteEnforcement *enforcement);
extern bool pts_dml_write_allows_old_row_preservation_proof(
  const PtsDmlWriteEnforcement *enforcement);
extern bool pts_dml_write_has_complete_target_null_constraints(
  const PtsDmlWriteEnforcement *enforcement);
extern bool pts_dml_write_has_generated_columns(
  const PtsDmlWriteEnforcement *enforcement);
extern const List *pts_dml_write_match_full_foreign_keys(
  const PtsDmlWriteEnforcement *enforcement);

#endif
