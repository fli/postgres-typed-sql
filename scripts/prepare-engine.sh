#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
source_dir=${PGLITE_SOURCE_DIR:-"$project_root/source/pglite"}
postgres_dir="$source_dir/postgres-pglite"
analyzer_dir="$postgres_dir/pglite/other_extensions/postgres_typed_sql_analyzer"
pglite_repository=${PGLITE_SOURCE_REPOSITORY:-https://github.com/electric-sql/pglite.git}
pglite_revision=25d0a55e1f1e4c59f26d9e125150dda88a33fd00
postgres_revision=7b4ee5086055dc5e54ae1e13e487888249438e68

if [ ! -d "$source_dir/.git" ]; then
  mkdir -p "$(dirname "$source_dir")"
  git clone "$pglite_repository" "$source_dir"
fi

actual_revision=$(git -C "$source_dir" rev-parse HEAD)
if [ "$actual_revision" != "$pglite_revision" ]; then
  if ! git -C "$source_dir" diff --quiet || ! git -C "$source_dir" diff --cached --quiet; then
    echo "Refusing to switch a modified PGlite source tree." >&2
    exit 1
  fi
  git -C "$source_dir" checkout --detach "$pglite_revision"
fi

git -C "$source_dir" submodule update --init --recursive

actual_postgres_revision=$(git -C "$postgres_dir" rev-parse HEAD)
if [ "$actual_postgres_revision" != "$postgres_revision" ]; then
  echo "Expected postgres-pglite revision $postgres_revision, got $actual_postgres_revision" >&2
  exit 1
fi

if git -C "$postgres_dir" apply --reverse --check "$project_root/patches/postgres-pglite-analyzer.patch" 2>/dev/null; then
  :
elif git -C "$postgres_dir" diff --quiet && git -C "$postgres_dir" diff --cached --quiet; then
  git -C "$postgres_dir" apply "$project_root/patches/postgres-pglite-analyzer.patch"
else
  echo "The PostgreSQL source tree has unexpected modifications." >&2
  exit 1
fi

mkdir -p "$analyzer_dir"
cp \
  "$project_root/engine/postgres_typed_sql_analyzer/postgres_typed_sql_analyzer.c" \
  "$project_root/engine/postgres_typed_sql_analyzer/Makefile" \
  "$analyzer_dir/"
