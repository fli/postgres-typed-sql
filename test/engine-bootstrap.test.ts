import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'

const projectRoot = resolve(import.meta.dirname, '../..')
const nativeSourceDirectory = resolve(projectRoot, 'engine/postgres_typed_sql_analyzer')

async function nativeSources(): Promise<string[]> {
  return (await readdir(nativeSourceDirectory))
    .filter((name) => name === 'Makefile' || name.endsWith('.c') || name.endsWith('.h'))
    .sort()
}

async function copyIdentityFixture(): Promise<string> {
  const sources = await nativeSources()
  const root = await mkdtemp(resolve(tmpdir(), 'postgres-typed-sql-engine-identity-'))
  await mkdir(resolve(root, 'scripts'), { recursive: true })
  await mkdir(resolve(root, 'patches'), { recursive: true })
  await mkdir(resolve(root, 'engine/postgres_typed_sql_analyzer'), { recursive: true })
  await cp(resolve(projectRoot, 'scripts/prepare-engine.sh'), resolve(root, 'scripts/prepare-engine.sh'))
  await cp(
    resolve(projectRoot, 'patches/postgres-pglite-analyzer.patch'),
    resolve(root, 'patches/postgres-pglite-analyzer.patch')
  )
  await Promise.all(
    sources.map((nativeSource) =>
      cp(
        resolve(projectRoot, 'engine/postgres_typed_sql_analyzer', nativeSource),
        resolve(root, 'engine/postgres_typed_sql_analyzer', nativeSource)
      )
    )
  )
  return root
}

function identity(root: string): string {
  return execFileSync('sh', [resolve(root, 'scripts/prepare-engine.sh'), '--print-identity'], {
    cwd: root,
    encoding: 'utf8',
  })
}

test('engine cache identity declares every native input', async (context) => {
  const root = await copyIdentityFixture()
  const sources = await nativeSources()
  context.after(() => rm(root, { force: true, recursive: true }))
  const output = identity(root)

  assert.match(output, /^key=[0-9a-f]+$/m)
  assert.match(output, /^cache-format=4$/m)
  assert.match(output, /^pglite-revision=25d0a55e1f1e4c59f26d9e125150dda88a33fd00$/m)
  assert.match(output, /^postgres-pglite-revision=7b4ee5086055dc5e54ae1e13e487888249438e68$/m)
  assert.match(output, /^postgres-pglite-patch=[0-9a-f]+$/m)
  assert.deepEqual(
    [...output.matchAll(/^native-source:([^=]+)=/gm)].map((match) => match[1]),
    sources.map((nativeSource) => `engine/postgres_typed_sql_analyzer/${nativeSource}`)
  )
  for (const nativeSource of sources) {
    assert.match(
      output,
      new RegExp(
        `^native-source:engine/postgres_typed_sql_analyzer/${nativeSource.replace('.', '\\.')}=[0-9a-f]+$`,
        'm'
      )
    )
  }
  assert.match(output, /^platform=.+$/m)
  assert.match(output, /^architecture=.+$/m)
  assert.match(output, /^node-abi=.+$/m)
  assert.match(output, /^pnpm-version=.+$/m)
})

test('engine cache identity invalidates when each native input or patch changes', async (context) => {
  const sources = await nativeSources()
  const roots: string[] = []
  context.after(() => Promise.all(roots.map((root) => rm(root, { force: true, recursive: true }))))

  for (const input of [
    ...sources.map((nativeSource) => `engine/postgres_typed_sql_analyzer/${nativeSource}`),
    'patches/postgres-pglite-analyzer.patch',
  ]) {
    const root = await copyIdentityFixture()
    roots.push(root)
    const before = identity(root).match(/^key=(.+)$/m)?.[1]
    const inputPath = resolve(root, input)
    await writeFile(inputPath, `${await readFile(inputPath, 'utf8')}\n/* identity test */\n`)
    const after = identity(root).match(/^key=(.+)$/m)?.[1]

    assert.notEqual(after, before, `${input} did not invalidate the engine cache identity`)
  }
})

test('staging validation rejects output built for another analyzer identity', async (context) => {
  const root = await copyIdentityFixture()
  context.after(() => rm(root, { force: true, recursive: true }))
  const source = resolve(root, 'source/pglite')
  await mkdir(resolve(source, 'packages/pglite/dist'), { recursive: true })
  await mkdir(resolve(source, 'postgres-pglite/dist/extensions/other'), { recursive: true })
  await writeFile(resolve(source, 'postgres-pglite/dist/extensions/other/postgres_typed_sql_analyzer.tar.gz'), '')
  await writeFile(resolve(source, '.postgres-typed-sql-build-identity'), 'stale\n')

  assert.throws(() => {
    try {
      execFileSync('sh', [resolve(root, 'scripts/prepare-engine.sh'), '--verify-built'], {
        cwd: root,
        stdio: 'pipe',
      })
    } catch (error) {
      assert.match(String((error as { stderr?: Buffer }).stderr), /native engine build is stale/)
      throw error
    }
  })
})

test('engine preparation refuses to overwrite an invalid external source directory', async (context) => {
  const root = await copyIdentityFixture()
  const externalSource = resolve(root, 'external-pglite')
  const sentinel = resolve(externalSource, 'keep-me.txt')
  context.after(() => rm(root, { force: true, recursive: true }))
  await mkdir(externalSource)
  await writeFile(sentinel, 'user-owned\n')

  assert.throws(() => {
    try {
      execFileSync('sh', [resolve(root, 'scripts/prepare-engine.sh')], {
        cwd: root,
        env: { ...process.env, PGLITE_SOURCE_DIR: externalSource },
        stdio: 'pipe',
      })
    } catch (error) {
      assert.match(
        String((error as { stderr?: Buffer }).stderr),
        /Refusing to initialize the non-Git PGLITE_SOURCE_DIR/
      )
      throw error
    }
  })
  assert.equal(await readFile(sentinel, 'utf8'), 'user-owned\n')
})
