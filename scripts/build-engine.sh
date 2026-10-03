#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
source_dir=${PGLITE_SOURCE_DIR:-"$project_root/source/pglite"}

"$project_root/scripts/prepare-engine.sh"
builder_image=electricsql/pglite-builder:3.1.74-7
if ! docker image inspect "$builder_image" >/dev/null 2>&1; then
  if ! docker pull "$builder_image"; then
    # The upstream registry can stop serving an image while the pinned source
    # still includes its builder recipe. Rebuild that same toolchain locally.
    docker build --tag "$builder_image" "$source_dir/postgres-pglite/pglite/builder"
  fi
fi
rm -f "$source_dir/.postgres-typed-sql-build-identity"
pnpm --dir "$source_dir" install --frozen-lockfile --ignore-scripts
pnpm --dir "$source_dir" wasm:build
pnpm --dir "$source_dir" ts:build

identity=$("$project_root/scripts/prepare-engine.sh" --print-identity | sed -n 's/^key=//p' | sed -n '1p')
printf '%s\n' "$identity" >"$source_dir/.postgres-typed-sql-build-identity"
"$project_root/scripts/prepare-engine.sh" --mark-built
