#include "postgres.h"

#include "access/table.h"
#include "fmgr.h"
#include "optimizer/optimizer.h"
#include "utils/rel.h"

#include "null_evaluation.h"

PG_FUNCTION_INFO_V1(postgres_typed_sql_column_check_not_null);

/* A scan may include descendants, so only inherited CHECKs establish a
 * relation-wide result fact. UNKNOWN satisfies CHECK and is not a proof. */
Datum
postgres_typed_sql_column_check_not_null(PG_FUNCTION_ARGS)
{
  Oid relid = PG_GETARG_OID(0);
  int attnum = PG_GETARG_INT32(1);
  Relation relation = table_open(relid, AccessShareLock);
  TupleDesc descriptor = RelationGetDescr(relation);
  TupleConstr *constraints = descriptor->constr;
  bool rejects_null = false;
  int index;

  if (attnum > 0 && attnum <= descriptor->natts && constraints != NULL)
  {
    for (index = 0; index < constraints->num_check; index++)
    {
      const ConstrCheck *constraint = &constraints->check[index];
      Node *check;
      PtsNullEvaluation evaluation;

      if (!constraint->ccenforced || !constraint->ccvalid ||
          constraint->ccnoinherit || constraint->ccbin == NULL)
        continue;
      check = stringToNode(constraint->ccbin);
      if (contain_mutable_functions(check))
        continue;
      evaluation = pts_check_null_evaluation(check, (AttrNumber) attnum);
      if (evaluation.evaluation_safe &&
          evaluation.proof == PTS_NULL_PROOF_FALSE)
      {
        rejects_null = true;
        break;
      }
    }
  }
  table_close(relation, AccessShareLock);
  PG_RETURN_BOOL(rejects_null);
}
