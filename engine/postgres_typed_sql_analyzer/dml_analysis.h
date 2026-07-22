#ifndef POSTGRES_TYPED_SQL_DML_ANALYSIS_H
#define POSTGRES_TYPED_SQL_DML_ANALYSIS_H

#include "postgres.h"
#include "lib/stringinfo.h"
#include "nodes/parsenodes.h"

extern void pts_append_dml_analysis(StringInfo out, const Query *query);

#endif
