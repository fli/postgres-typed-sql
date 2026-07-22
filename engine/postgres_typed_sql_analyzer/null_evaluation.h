#ifndef POSTGRES_TYPED_SQL_NULL_EVALUATION_H
#define POSTGRES_TYPED_SQL_NULL_EVALUATION_H

#include "postgres.h"
#include "nodes/nodes.h"

typedef enum PtsNullProof
{
  PTS_NULL_PROOF_NULL,
  PTS_NULL_PROOF_TRUE,
  PTS_NULL_PROOF_FALSE,
  PTS_NULL_PROOF_NONNULL,
  PTS_NULL_PROOF_UNKNOWN
} PtsNullProof;

typedef struct PtsNullEvaluation
{
  PtsNullProof proof;
  bool evaluation_safe;
  bool depends_on_subject;
} PtsNullEvaluation;

typedef struct PtsParameterNodeAnalysis PtsParameterNodeAnalysis;

extern PtsNullEvaluation pts_make_null_evaluation(PtsNullProof proof,
                                                  bool evaluation_safe,
                                                  bool depends_on_subject);
extern PtsNullEvaluation pts_check_null_evaluation(const Node *expr,
                                                   AttrNumber target_attnum);
extern PtsNullEvaluation pts_check_parameter_null_evaluation(
  const Node *expr, int param_id, PtsParameterNodeAnalysis *node_analysis);
extern PtsParameterNodeAnalysis *pts_create_parameter_node_analysis(void);
extern void pts_destroy_parameter_node_analysis(
  PtsParameterNodeAnalysis *analysis);
extern bool pts_node_mentions_external_parameter(
  const Node *node, int param_id, PtsParameterNodeAnalysis *analysis);

#endif
