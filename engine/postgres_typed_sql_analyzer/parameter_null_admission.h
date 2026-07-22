#ifndef POSTGRES_TYPED_SQL_PARAMETER_NULL_ADMISSION_H
#define POSTGRES_TYPED_SQL_PARAMETER_NULL_ADMISSION_H

#include "postgres.h"
#include "nodes/parsenodes.h"

#include "null_admission.h"

typedef struct PtsParameterUsageEvidence
{
  bool seen;
  PtsNullAdmission admission;
} PtsParameterUsageEvidence;

extern void pts_update_parameter_usage_null_admissions(
  const Query *query, PtsParameterUsageEvidence *evidence, int param_count,
  PtsNullAdmissionAnalysis *null_admission_analysis);

#endif
