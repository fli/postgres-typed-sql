#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
default_source_dir="$project_root/source/pglite"
source_dir=${PGLITE_SOURCE_DIR:-"$default_source_dir"}
pglite_repository=${PGLITE_SOURCE_REPOSITORY:-https://github.com/electric-sql/pglite.git}
pglite_revision=25d0a55e1f1e4c59f26d9e125150dda88a33fd00
postgres_revision=7b4ee5086055dc5e54ae1e13e487888249438e68
cache_format=4
managed_source=false
native_source_manifest=$(
  for native_source_path in \
    "$project_root/engine/postgres_typed_sql_analyzer/Makefile" \
    "$project_root/engine/postgres_typed_sql_analyzer/"*.c \
    "$project_root/engine/postgres_typed_sql_analyzer/"*.h
  do
    if [ -f "$native_source_path" ]; then
      basename "$native_source_path"
    fi
  done | LC_ALL=C sort
)

if [ "$source_dir" = "$default_source_dir" ]; then
  managed_source=true
fi

hash_file() {
  git hash-object "$1"
}

native_source_identity() {
  for native_source in $native_source_manifest; do
    native_path="engine/postgres_typed_sql_analyzer/$native_source"
    native_hash=$(hash_file "$project_root/$native_path")
    printf 'native-source:%s=%s\n' "$native_path" "$native_hash"
  done
}

identity_manifest() {
  cat <<EOF
cache-format=$cache_format
pglite-repository=$pglite_repository
pglite-revision=$pglite_revision
postgres-pglite-revision=$postgres_revision
postgres-pglite-patch=$(hash_file "$project_root/patches/postgres-pglite-analyzer.patch")
$(native_source_identity)
platform=$(uname -s)
architecture=$(uname -m)
node-abi=$(node -p 'process.versions.modules')
pnpm-version=$(pnpm --version)
EOF
}

identity=$(identity_manifest)
identity_key=$(printf '%s\n' "$identity" | git hash-object --stdin)
build_identity_file="$source_dir/.postgres-typed-sql-build-identity"
managed_identity_file="$project_root/source/.pglite-cache-identity"
cache_root=
cache_entry=
prepared_cache=
built_cache=

initialize_cache_paths() {
  if [ -n "$cache_root" ]; then
    return
  fi
  if [ -n "${POSTGRES_TYPED_SQL_ENGINE_CACHE_DIR:-}" ]; then
    cache_root=$POSTGRES_TYPED_SQL_ENGINE_CACHE_DIR
  else
    git_common_dir=$(git -C "$project_root" rev-parse --path-format=absolute --git-common-dir)
    cache_root="$git_common_dir/postgres-typed-sql-engine-cache"
  fi
  cache_entry="$cache_root/entries/$identity_key"
  prepared_cache="$cache_entry/prepared"
  built_cache="$cache_entry/built"
}

write_identity_file() {
  target=$1
  {
    printf 'key=%s\n' "$identity_key"
    printf '%s\n' "$identity"
  } >"$target"
}

copy_if_changed() {
  source=$1
  target=$2
  if [ ! -f "$target" ] || ! cmp -s "$source" "$target"; then
    cp "$source" "$target"
  fi
}

prepare_source_tree() {
  tree=$1
  tree_postgres="$tree/postgres-pglite"
  tree_analyzer="$tree_postgres/pglite/other_extensions/postgres_typed_sql_analyzer"

  actual_revision=$(git -C "$tree" rev-parse HEAD)
  if [ "$actual_revision" != "$pglite_revision" ]; then
    echo "Expected PGlite revision $pglite_revision, got $actual_revision" >&2
    return 1
  fi

  git -C "$tree" submodule update --init --recursive --depth 1 --jobs 8

  actual_postgres_revision=$(git -C "$tree_postgres" rev-parse HEAD)
  if [ "$actual_postgres_revision" != "$postgres_revision" ]; then
    echo "Expected postgres-pglite revision $postgres_revision, got $actual_postgres_revision" >&2
    return 1
  fi

  if git -C "$tree_postgres" apply --reverse --check \
    "$project_root/patches/postgres-pglite-analyzer.patch" 2>/dev/null; then
    :
  elif git -C "$tree_postgres" diff --quiet &&
    git -C "$tree_postgres" diff --cached --quiet; then
    git -C "$tree_postgres" apply "$project_root/patches/postgres-pglite-analyzer.patch"
  else
    echo "The PostgreSQL source tree has unexpected modifications." >&2
    return 1
  fi

  rm -rf "$tree_analyzer"
  mkdir -p "$tree_analyzer"
  for native_source in $native_source_manifest; do
    copy_if_changed \
      "$project_root/engine/postgres_typed_sql_analyzer/$native_source" \
      "$tree_analyzer/$native_source"
  done
}

clone_cold_source() {
  target=$1
  mkdir -p "$target"
  git -C "$target" init
  git -C "$target" remote add origin "$pglite_repository"
  git -C "$target" fetch --depth 1 origin "$pglite_revision"
  git -C "$target" checkout --detach FETCH_HEAD
  git -C "$target" submodule update --init --recursive --depth 1 --jobs 8
  prepare_source_tree "$target"
}

lock_dir=
temporary_cache=
release_lock() {
  if [ -n "$temporary_cache" ] && [ -d "$temporary_cache" ]; then
    rm -rf "$temporary_cache"
  fi
  if [ -n "$lock_dir" ] && [ -d "$lock_dir" ]; then
    rm -rf "$lock_dir"
  fi
}

acquire_cache_lock() {
  mkdir -p "$cache_root/locks"
  lock_dir="$cache_root/locks/$identity_key"
  host=$(hostname)
  attempts=0

  while ! mkdir "$lock_dir" 2>/dev/null; do
    if [ -f "$lock_dir/owner" ]; then
      owner_pid=$(sed -n 's/^pid=//p' "$lock_dir/owner" | sed -n '1p')
      owner_alive=false
      if [ -n "$owner_pid" ] && kill -0 "$owner_pid" 2>/dev/null; then
        owner_command=$(ps -p "$owner_pid" -o command= 2>/dev/null || true)
        case "$owner_command" in
          *prepare-engine.sh*) owner_alive=true ;;
        esac
      fi
      if [ "$owner_alive" = false ]; then
        stale_lock="$lock_dir.stale.$$"
        if mv "$lock_dir" "$stale_lock" 2>/dev/null; then
          rm -rf "$stale_lock"
          continue
        fi
      fi
    fi

    attempts=$((attempts + 1))
    if [ "$attempts" -eq 1800 ]; then
      echo "Timed out waiting for engine cache lock $lock_dir" >&2
      exit 1
    fi
    if [ $((attempts % 30)) -eq 0 ]; then
      echo "Waiting for another worktree to finish engine cache $identity_key..." >&2
    fi
    sleep 1
  done

  {
    printf 'pid=%s\n' "$$"
    printf 'host=%s\n' "$host"
  } >"$lock_dir/owner"
  trap release_lock EXIT
  trap 'exit 130' HUP INT TERM
}

remove_abandoned_identity_temps() {
  for abandoned in "$cache_root/tmp/$identity_key".*; do
    if [ -d "$abandoned" ]; then
      rm -rf "$abandoned"
    fi
  done
}

same_file_identity() {
  first=$1
  second=$2
  if [ "$(uname -s)" = Darwin ]; then
    [ "$(stat -f '%d:%i' "$first")" = "$(stat -f '%d:%i' "$second")" ]
  else
    [ "$(stat -c '%d:%i' "$first")" = "$(stat -c '%d:%i' "$second")" ]
  fi
}

copy_private_tree() {
  cache_source=$1
  target=$2
  copy_mode="full copy"
  start_time=$(date +%s)

  if [ "$(uname -s)" = Darwin ] && /bin/cp -cR "$cache_source" "$target" 2>/dev/null; then
    copy_mode="APFS copy-on-write clone"
  else
    if [ -e "$target" ]; then
      rm -rf "$target"
    fi
    cp -R "$cache_source" "$target"
  fi

  mutable_probe="postgres-pglite/pglite/other_extensions/postgres_typed_sql_analyzer/postgres_typed_sql_analyzer.c"
  if same_file_identity "$cache_source/$mutable_probe" "$target/$mutable_probe"; then
    echo "Engine cache copy shares mutable file identity with its source; refusing unsafe setup." >&2
    rm -rf "$target"
    exit 1
  fi

  elapsed=$(( $(date +%s) - start_time ))
  echo "Created private engine source via $copy_mode in ${elapsed}s." >&2
}

ensure_prepared_cache() {
  initialize_cache_paths
  if [ -f "$prepared_cache/complete" ]; then
    return
  fi

  mkdir -p "$cache_root/tmp" "$cache_root/entries"
  acquire_cache_lock
  remove_abandoned_identity_temps
  if [ -f "$prepared_cache/complete" ]; then
    release_lock
    lock_dir=
    trap - EXIT HUP INT TERM
    return
  fi

  mkdir -p "$cache_entry"
  temporary_cache=$(mktemp -d "$cache_root/tmp/$identity_key.prepared.XXXXXX")
  echo "Preparing cold shared engine source cache $identity_key..." >&2
  clone_cold_source "$temporary_cache/source"
  pnpm --dir "$temporary_cache/source" install --frozen-lockfile --ignore-scripts
  write_identity_file "$temporary_cache/identity"
  : >"$temporary_cache/complete"
  mv "$temporary_cache" "$prepared_cache"
  temporary_cache=
  release_lock
  lock_dir=
  trap - EXIT HUP INT TERM
}

seed_managed_source() {
  initialize_cache_paths
  if [ -f "$built_cache/complete" ]; then
    cache_source="$built_cache/source"
    cache_kind=built
  else
    ensure_prepared_cache
    cache_source="$prepared_cache/source"
    cache_kind=prepared
  fi

  mkdir -p "$(dirname "$source_dir")"
  for abandoned in "$project_root/source/.pglite.tmp."*; do
    if [ -d "$abandoned" ]; then
      rm -rf "$abandoned"
    fi
  done
  temporary_source="$project_root/source/.pglite.tmp.$$"
  trap 'if [ -n "$temporary_source" ] && [ -d "$temporary_source" ]; then rm -rf "$temporary_source"; fi' EXIT
  trap 'exit 130' HUP INT TERM
  echo "Seeding $cache_kind engine cache $identity_key." >&2
  copy_private_tree "$cache_source" "$temporary_source"
  mv "$temporary_source" "$source_dir"
  temporary_source=
  trap - EXIT HUP INT TERM
  write_identity_file "$managed_identity_file"
}

publish_built_cache() {
  if [ "$managed_source" != true ]; then
    return
  fi
  initialize_cache_paths
  if [ -f "$built_cache/complete" ]; then
    return
  fi

  mkdir -p "$cache_root/tmp" "$cache_root/entries" "$cache_entry"
  acquire_cache_lock
  remove_abandoned_identity_temps
  if [ -f "$built_cache/complete" ]; then
    release_lock
    lock_dir=
    trap - EXIT HUP INT TERM
    return
  fi

  temporary_cache=$(mktemp -d "$cache_root/tmp/$identity_key.built.XXXXXX")
  echo "Publishing reusable built engine cache $identity_key..." >&2
  copy_private_tree "$source_dir" "$temporary_cache/source"
  write_identity_file "$temporary_cache/identity"
  : >"$temporary_cache/complete"
  mv "$temporary_cache" "$built_cache"
  temporary_cache=
  release_lock
  lock_dir=
  trap - EXIT HUP INT TERM
}

verify_built() {
  if [ ! -f "$build_identity_file" ]; then
    echo "The native engine has not been built for the current analyzer inputs." >&2
    echo "Run pnpm build:engine before staging or testing the package." >&2
    exit 1
  fi
  built_key=$(sed -n '1p' "$build_identity_file")
  if [ "$built_key" != "$identity_key" ]; then
    echo "The native engine build is stale for the current analyzer inputs." >&2
    echo "Expected $identity_key, found $built_key. Run pnpm build:engine." >&2
    exit 1
  fi

  test -d "$source_dir/packages/pglite/dist"
  test -f \
    "$source_dir/postgres-pglite/dist/extensions/other/postgres_typed_sql_analyzer.tar.gz"
}

case "${1:-}" in
  --print-identity)
    printf 'key=%s\n' "$identity_key"
    printf '%s\n' "$identity"
    exit 0
    ;;
  --verify-built)
    verify_built
    exit 0
    ;;
  --mark-built)
    verify_built
    publish_built_cache
    exit 0
    ;;
  "")
    ;;
  *)
    echo "Usage: $0 [--print-identity|--verify-built|--mark-built]" >&2
    exit 2
    ;;
esac

if [ ! -d "$source_dir/.git" ]; then
  if [ "$managed_source" = true ]; then
    if [ -e "$source_dir" ] || [ -L "$source_dir" ]; then
      invalid_source="$project_root/source/.pglite.invalid.$$"
      echo "Quarantining invalid managed engine source at $invalid_source." >&2
      mv "$source_dir" "$invalid_source"
    else
      invalid_source=
    fi
    seed_managed_source
    if [ -n "$invalid_source" ]; then
      rm -rf "$invalid_source"
    fi
  else
    if [ -e "$source_dir" ] || [ -L "$source_dir" ]; then
      echo "Refusing to initialize the non-Git PGLITE_SOURCE_DIR: $source_dir" >&2
      echo "Move or remove that path, or point PGLITE_SOURCE_DIR at a valid PGlite checkout." >&2
      exit 1
    fi
    mkdir -p "$(dirname "$source_dir")"
    clone_cold_source "$source_dir"
  fi
else
  if ! prepare_source_tree "$source_dir"; then
    if [ "$managed_source" = true ] && [ -f "$managed_identity_file" ]; then
      echo "Replacing incompatible managed engine source with exact cache state." >&2
      rm -rf "$source_dir"
      seed_managed_source
    else
      exit 1
    fi
  fi
  if [ "$managed_source" = true ]; then
    write_identity_file "$managed_identity_file"
  fi
fi
