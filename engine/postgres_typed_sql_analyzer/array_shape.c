#include "postgres.h"

#include "nodes/primnodes.h"
#include "utils/array.h"
#include "utils/memutils.h"

#include "array_shape.h"

static PtsArrayShape
unknown_array_shape(void)
{
  PtsArrayShape shape = {0};

  shape.proof = PTS_ARRAY_SHAPE_UNKNOWN;
  return shape;
}

static PtsArrayShape
invalid_array_shape(void)
{
  PtsArrayShape shape = {0};

  shape.proof = PTS_ARRAY_SHAPE_INVALID;
  return shape;
}

PtsArrayShape
pts_array_shape_proof(const Node *node)
{
  PtsArrayShape shape = {0};

  if (node == NULL)
  {
    return unknown_array_shape();
  }
  if (IsA(node, Const))
  {
    const Const *constant = (const Const *) node;
    ArrayType *value;

    shape.proof = PTS_ARRAY_SHAPE_VALID;
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

    shape.proof = PTS_ARRAY_SHAPE_VALID;
    if (!array->multidims)
    {
      shape.ndims = 1;
      shape.dims[0] = element_count;
      shape.lbs[0] = 1;
      shape.nitems = element_count;
      return shape;
    }

    {
      PtsArrayShape first_nonempty = {0};
      ListCell *cell;
      bool saw_empty = false;
      bool saw_nonempty = false;
      bool saw_unknown = false;

      foreach(cell, array->elements)
      {
        PtsArrayShape child = pts_array_shape_proof((const Node *) lfirst(cell));

        if (child.proof == PTS_ARRAY_SHAPE_INVALID)
        {
          return invalid_array_shape();
        }
        if (child.proof == PTS_ARRAY_SHAPE_UNKNOWN)
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
