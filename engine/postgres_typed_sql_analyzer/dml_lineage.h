#ifndef POSTGRES_TYPED_SQL_DML_LINEAGE_H
#define POSTGRES_TYPED_SQL_DML_LINEAGE_H

#include "postgres.h"
#include "access/attnum.h"
#include "nodes/bitmapset.h"
#include "nodes/parsenodes.h"
#include "null_admission.h"

typedef struct PtsDmlLineageFact
{
  int param_id;
  Oid target_relid;
  AttrNumber target_attnum;
  Oid target_type_oid;
  PtsNullAdmission admission;
  bool direct_assignment;
} PtsDmlLineageFact;

extern List *pts_collect_dml_lineage(const Query *query);

#endif
