#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
source_dir=${PGLITE_SOURCE_DIR:-"$project_root/source/pglite"}

"$project_root/scripts/prepare-engine.sh"
pnpm --dir "$source_dir" install --frozen-lockfile --ignore-scripts
pnpm --dir "$source_dir" wasm:build
pnpm --dir "$source_dir" ts:build
