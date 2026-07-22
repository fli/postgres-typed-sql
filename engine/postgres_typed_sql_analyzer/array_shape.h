#ifndef POSTGRES_TYPED_SQL_ARRAY_SHAPE_H
#define POSTGRES_TYPED_SQL_ARRAY_SHAPE_H

#include "postgres.h"
#include "nodes/nodes.h"
#include "utils/array.h"

typedef enum PtsArrayShapeProof
{
  PTS_ARRAY_SHAPE_VALID,
  PTS_ARRAY_SHAPE_INVALID,
  PTS_ARRAY_SHAPE_UNKNOWN
} PtsArrayShapeProof;

typedef struct PtsArrayShape
{
  PtsArrayShapeProof proof;
  bool is_null;
  int ndims;
  int dims[MAXDIM];
  int lbs[MAXDIM];
  int nitems;
} PtsArrayShape;

extern PtsArrayShape pts_array_shape_proof(const Node *node);

#endif
