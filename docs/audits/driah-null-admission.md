# Driah NULL admission inventory

Run the inventory against the consumer's actual project configuration and a captured baseline.

```sh
node scripts/audit-null-admission.mjs <consumer-root> <baseline.json> <output.json> [project-module] [snapshot-root]
```

The optional project module defaults to `dist/project.js` in this repository. Pass its path or a file URL to compare another compiler. The optional snapshot root selects captured query source files; configuration, schema and projection dependencies still come from the consumer root. Without it, query source files also come from the consumer root. The consumer project is opened for analysis and is not written.

Each baseline entry is one declaration. The script compiles the complete original query and then replaces only that declaration with `@nullable`. It records both admissions and diagnostics, source hashes, original parameter analysis when available, and executable hashes after TypeScript transpilation. A gained entry was rejected by the baseline and accepted by the current compiler. Compare input hashes and configuration when interpreting results.

The 143 substitutions in the captured baseline are experiments, not 143 defects. This inventory tests neither SQL rewrites nor combinations of declaration changes. An accepted substitution establishes compiler admission for that query, not that callers should change their declarations.
