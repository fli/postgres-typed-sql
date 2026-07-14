#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
pack_dir="$project_root/artifacts/npm-pack"
consumer="$project_root/artifacts/npm-consumer"

rm -rf "$pack_dir" "$consumer"
mkdir -p "$pack_dir" "$consumer"

pack_json=$(npm pack "$project_root" --ignore-scripts --pack-destination "$pack_dir" --json)
tarball=$(node -e "const value=JSON.parse(process.argv[1]); process.stdout.write(value[0].filename)" "$pack_json")

cp -R "$project_root/test/consumer/." "$consumer/"
cd "$consumer"
npm install --ignore-scripts --no-audit --no-fund "$pack_dir/$tarball"

before=$(find node_modules -type f -exec shasum -a 256 {} \; | sort | shasum -a 256 | awk '{print $1}')
node smoke.mjs
"$project_root/node_modules/.bin/tsc" --project tsconfig.json
after=$(find node_modules -type f -exec shasum -a 256 {} \; | sort | shasum -a 256 | awk '{print $1}')

if [ "$before" != "$after" ]; then
  echo 'The installed package modified files under node_modules while running.' >&2
  exit 1
fi

node -e "const p=require('./node_modules/postgres-typed-sql/package.json'); for (const key of ['preinstall','install','postinstall','prepare']) if (p.scripts?.[key]) throw new Error('lifecycle script: '+key)"

if tar -tzf "$pack_dir/$tarball" | grep -E '(^|/)source/|(^|/)test/|(^|/)engine/'; then
  echo 'The npm tarball contains publisher-only source.' >&2
  exit 1
fi

shasum -a 256 "$pack_dir/$tarball"
du -h "$pack_dir/$tarball"
