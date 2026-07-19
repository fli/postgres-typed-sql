#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
source_dir=${PGLITE_SOURCE_DIR:-"$project_root/source/pglite"}

"$project_root/scripts/prepare-engine.sh"
rm -f "$source_dir/.postgres-typed-sql-build-identity"
pnpm --dir "$source_dir" install --frozen-lockfile --ignore-scripts
pnpm --dir "$source_dir" wasm:build
pnpm --dir "$source_dir" ts:build

identity=$("$project_root/scripts/prepare-engine.sh" --print-identity | sed -n 's/^key=//p' | sed -n '1p')
printf '%s\n' "$identity" >"$source_dir/.postgres-typed-sql-build-identity"
"$project_root/scripts/prepare-engine.sh" --mark-built
