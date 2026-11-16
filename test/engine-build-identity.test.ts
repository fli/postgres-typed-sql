import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, copyFile, readFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
test('engine build refuses changed source identity before publishing its cache', async () => {
  const root = await mkdtemp(join(tmpdir(), 'engine-identity-'))
  try {
    await mkdir(join(root, 'scripts'))
    await mkdir(join(root, 'bin'))
    await mkdir(join(root, 'source/pglite'), { recursive: true })
    await copyFile(resolve('scripts/build-engine.sh'), join(root, 'scripts/build-engine.sh'))
    await writeFile(join(root, 'identity'), 'initial')
    await writeFile(
      join(root, 'scripts/prepare-engine.sh'),
      `#!/bin/sh\ncase "$1" in\n--print-identity) printf 'key='; cat '${root}/identity';;\n--mark-built) touch '${root}/marked';;\n'') if [ "$MUTATE_PREPARE" = yes ]; then echo changed > '${root}/identity'; fi;;\nesac\n`,
      { mode: 0o755 }
    )
    await writeFile(join(root, 'bin/docker'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    await writeFile(
      join(root, 'bin/pnpm'),
      `#!/bin/sh\nif [ "$MUTATE_BUILD" = yes ]; then echo changed > '${root}/identity'; fi\n`,
      { mode: 0o755 }
    )
    const env = {
      ...process.env,
      PATH: `${root}/bin:${process.env.PATH}`,
      PGLITE_SOURCE_DIR: join(root, 'source/pglite'),
      MUTATE_BUILD: 'yes',
      MUTATE_PREPARE: 'no',
    }
    const prepared = spawnSync('sh', [join(root, 'scripts/build-engine.sh')], {
      env: { ...env, MUTATE_BUILD: 'no', MUTATE_PREPARE: 'yes' },
      encoding: 'utf8',
    })
    assert.equal(prepared.status, 1)
    assert.match(prepared.stderr, /Engine sources changed during preparation/)
    await assert.rejects(access(join(root, 'marked')))
    await writeFile(join(root, 'identity'), 'initial')
    const changed = spawnSync('sh', [join(root, 'scripts/build-engine.sh')], { env, encoding: 'utf8' })
    assert.equal(changed.status, 1)
    assert.match(changed.stderr, /Engine sources changed during the build/)
    await assert.rejects(access(join(root, 'marked')))
    const stable = spawnSync('sh', [join(root, 'scripts/build-engine.sh')], {
      env: { ...env, MUTATE_BUILD: 'no' },
      encoding: 'utf8',
    })
    assert.equal(stable.status, 0, stable.stderr)
    assert.equal(
      (await readFile(join(root, 'source/pglite/.postgres-typed-sql-build-identity'), 'utf8')).trim(),
      'changed'
    )
    await access(join(root, 'marked'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
