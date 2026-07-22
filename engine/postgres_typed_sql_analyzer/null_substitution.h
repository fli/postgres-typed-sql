#ifndef POSTGRES_TYPED_SQL_NULL_SUBSTITUTION_H
#define POSTGRES_TYPED_SQL_NULL_SUBSTITUTION_H

#include "postgres.h"
#include "nodes/parsenodes.h"
#include "utils/array.h"
#include "utils/hsearch.h"

#include "null_evaluation.h"

typedef enum PtsOldTargetNullness
{
  PTS_OLD_TARGET_NULLNESS_UNKNOWN,
  PTS_OLD_TARGET_NULLNESS_NULL,
  PTS_OLD_TARGET_NULLNESS_NONNULL
} PtsOldTargetNullness;

typedef struct PtsNullSubstitutionContext
{
  const Query *query;
  int param_id;
  AttrNumber target_attnum;
  PtsOldTargetNullness old_target_nullness;
} PtsNullSubstitutionContext;

extern bool pts_null_substitution_preserves_old_target(
  const Node *expr, const PtsNullSubstitutionContext *context);

#endif
