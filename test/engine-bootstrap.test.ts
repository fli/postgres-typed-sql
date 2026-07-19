import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'

const projectRoot = resolve(import.meta.dirname, '../..')

async function copyIdentityFixture(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'postgres-typed-sql-engine-identity-'))
  await mkdir(resolve(root, 'scripts'), { recursive: true })
  await mkdir(resolve(root, 'patches'), { recursive: true })
  await mkdir(resolve(root, 'engine/postgres_typed_sql_analyzer'), { recursive: true })
  await cp(resolve(projectRoot, 'scripts/prepare-engine.sh'), resolve(root, 'scripts/prepare-engine.sh'))
  await cp(
    resolve(projectRoot, 'patches/postgres-pglite-analyzer.patch'),
    resolve(root, 'patches/postgres-pglite-analyzer.patch')
  )
  await cp(
    resolve(projectRoot, 'engine/postgres_typed_sql_analyzer/postgres_typed_sql_analyzer.c'),
    resolve(root, 'engine/postgres_typed_sql_analyzer/postgres_typed_sql_analyzer.c')
  )
  await cp(
    resolve(projectRoot, 'engine/postgres_typed_sql_analyzer/Makefile'),
    resolve(root, 'engine/postgres_typed_sql_analyzer/Makefile')
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
  context.after(() => rm(root, { force: true, recursive: true }))
  const output = identity(root)

  assert.match(output, /^key=[0-9a-f]+$/m)
  assert.match(output, /^cache-format=1$/m)
  assert.match(output, /^pglite-revision=25d0a55e1f1e4c59f26d9e125150dda88a33fd00$/m)
  assert.match(output, /^postgres-pglite-revision=7b4ee5086055dc5e54ae1e13e487888249438e68$/m)
  assert.match(output, /^postgres-pglite-patch=[0-9a-f]+$/m)
  assert.match(output, /^analyzer-c=[0-9a-f]+$/m)
  assert.match(output, /^analyzer-makefile=[0-9a-f]+$/m)
  assert.match(output, /^platform=.+$/m)
  assert.match(output, /^architecture=.+$/m)
  assert.match(output, /^node-abi=.+$/m)
  assert.match(output, /^pnpm-version=.+$/m)
})

test('engine cache identity invalidates exactly when a native input changes', async (context) => {
  const root = await copyIdentityFixture()
  context.after(() => rm(root, { force: true, recursive: true }))
  const before = identity(root)
  const analyzer = resolve(root, 'engine/postgres_typed_sql_analyzer/postgres_typed_sql_analyzer.c')
  await writeFile(analyzer, `${await readFile(analyzer, 'utf8')}\n/* identity test */\n`)
  const afterAnalyzerChange = identity(root)

  assert.notEqual(afterAnalyzerChange.match(/^key=(.+)$/m)?.[1], before.match(/^key=(.+)$/m)?.[1])

  const patch = resolve(root, 'patches/postgres-pglite-analyzer.patch')
  await writeFile(patch, `${await readFile(patch, 'utf8')}\n`)
  const afterPatchChange = identity(root)

  assert.notEqual(afterPatchChange.match(/^key=(.+)$/m)?.[1], afterAnalyzerChange.match(/^key=(.+)$/m)?.[1])
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
