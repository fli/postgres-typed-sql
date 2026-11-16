# Consumer NULL admission inventory

Run the inventory against the consumer's actual project configuration and a captured baseline.

```sh
node scripts/audit-null-admission.mjs <consumer-root> <baseline.json> <output.json> [project-module] [snapshot-root]
```

The optional project module defaults to `dist/project.js` in this repository. Pass its path or a file URL to compare another compiler. The optional snapshot root selects captured query source files; configuration, schema and projection dependencies still come from the consumer root. Without it, query source files also come from the consumer root. The consumer project is opened for analysis and is not written.

Each baseline entry is one declaration. The script compiles the complete original query and then replaces only that declaration with `@nullable`. It records both admissions and diagnostics, source hashes, original parameter analysis when available, and executable hashes after TypeScript transpilation. A gained entry was rejected by the baseline and accepted by the current compiler. Compare input hashes and configuration when interpreting results.

The final report has `complete: true`. While the replay runs, `<output.json>.partial.json` records completed files with `complete: false`. An unexpected original-query failure or another compiler error still stops the run. A partial report does not establish the final inventory counts.

The 143 substitutions in the captured baseline are experiments, not 143 defects. This inventory tests neither SQL rewrites nor combinations of declaration changes. An accepted substitution establishes compiler admission for that query, not that callers should change their declarations.

## Recorded result

The completed 2026-11-16 replay contains 143 individual substitutions across 44 complete query snapshots, using the actual configuration and schema. [The per-declaration inventory](consumer-null-admission.tsv) records the source hashes, outcome, and a named example for every blocker category. The full JSON produced by the replay retains every structured reason.

| Outcome                               | Published beta.30 baseline | Candidate |
| ------------------------------------- | -------------------------: | --------: |
| Strict substitutions accepted         |                          0 |         0 |
| Insufficient proof, `unknown`         |                        142 |       143 |
| Demonstrated rejecting use, `rejects` |                          1 |         0 |

The changed rejection classification is an UPDATE that may affect no rows. Its required destination remains identified, and strict `@nullable` still fails. The compiler retains direct-assignment metadata and CHECK-derived input types separately from row-production certainty.

No declaration in these complete snapshots gains strict proof. The reduced fixtures gain selected-output CTE, subquery, and guarded-write proofs; the original statements retain opaque effects, relevant constraints, dependent inputs, or unsupported analysis. All 44 original queries still compile with their existing directives. Their executable JavaScript hashes match the baseline, every snapshot source hash matches, and all 48 watched consumer input hashes match. The accepted-substitution executable comparison is vacuous because no substitution was accepted; the positive upstream fixtures separately check identical generated executables and one driver query per call.

## Proof cases

The upstream regressions reduce the consumer statements to independent fixtures. They preserve the relevant NULL behavior without requiring a consumer SQL rewrite.

| Case                                              | Proof covered                                                                                                                                   | Boundary retained                                                                                                                                                    |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Description UPDATE using `IS DISTINCT FROM`       | A NULL-safe comparison and a nullable destination can admit NULL.                                                                               | The complete consumer updates also change metadata and execute notification and search triggers. Applicable opaque effects prevent strict proof.                     |
| Playback `source_build_plan_id`                   | Selected input CTE projections preserve NULL through nested projections, comparisons, and nullable writes.                                      | The complete statement includes a deferred package INSERT trigger and index enforcement. The surrounding workflow also performs separate lookups and locks.          |
| NULL-guarded required-column UPDATE               | A projected NULL may select the existing required value. Every assignment must preserve the row and existing enforcement must permit the proof. | An independent `provided` flag can select the NULL arm, so it does not establish admission.                                                                          |
| Module naming override                            | The CHECK is part of destination admission.                                                                                                     | `custom` with NULL is invalid; automatic mode with NULL can be valid. A flat scalar cannot prove the companion relationship. Existing consumer unions remain useful. |
| Asset source patch                                | A nullable patch field can preserve its old value when absent and clear it when explicitly provided as NULL.                                    | A required state field still rejects a provided NULL. The transport placeholder used when absent is caller-owned.                                                    |
| Constant output over a parameter-dependent source | Dependency analysis follows nested row producers even when the selected expression is constant.                                                 | NULL can enable an opaque call or a multirow scalar subquery. Selected-output independence must not erase that relationship.                                         |

## Reading a rejection

`nullAdmission` retains its three outcomes. `accepts` is a compiler proof, `rejects` records a demonstrated rejecting use, and `unknown` means the analysis cannot establish admission. `@bindNull` remains a caller permission regardless of that outcome.

Each parameter analysis also contains `nullAdmissionReasons`. A reason has a stable `code`, a message naming the known use or catalog object, and an optional zero-based `compiledByteOffset`. The offset addresses the compiled SQL, where named parameters have become positional parameters. It is not a column number in the original source. The directive's source line remains the primary error location.

Required destinations and rejecting domains or constraints identify an input-contract failure. Conditional required writes and companion-dependent constraints need a stronger caller contract. Opaque callables, triggers, indexes, and unsupported projections identify the evidence the compiler lacks. Retain caller admission when that responsibility belongs to the application; report a reduced unsupported proof case when the SQL should be provable. No runtime NULL check or additional database query participates in these proofs.

The report field is additive. Existing generated parameter signatures and statement execution remain unchanged. Consumers that enforce exact analysis-object keys or snapshots must include the new field.

Execution certainty stays bounded. Domain casts in nested queries, filtered or potentially empty projections, and unsupported expression positions can remain `unknown`. Required window and sample inputs use separate initialization proofs; conditional or unused windows and sampling joins remain conservative. These limits preserve strict admission while avoiding a false claim that PostgreSQL must reject a bypassed use.
