import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import * as nodeModule from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const archive = resolve(process.argv[2] ?? '')
assert(archive.endsWith('.tgz'), 'Provide the verified package tarball')
const root = await realpath(await mkdtemp(join(tmpdir(), 'typed-sql-node-compat-')))
try {
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', archive, 'esbuild@0.25.12'], {
    cwd: root,
    stdio: 'inherit',
  })
  const require = nodeModule.createRequire(join(root, 'package.json'))
  const { openQueryProject } = await import(pathToFileURL(require.resolve('postgres-typed-sql/project')).href)
  const { createPostgresExecutor } = await import(pathToFileURL(require.resolve('postgres-typed-sql/runtime')).href)
  const { transform } = await import(pathToFileURL(require.resolve('esbuild')).href)
  await writeFile(join(root, 'schema.sql'), 'create table widget (id integer primary key);')
  const query = join(root, 'query.typed.sql')
  await writeFile(query, 'select 7 as value')
  const config = join(root, 'config.mjs')
  await writeFile(
    config,
    `export default {schema:'schema.sql',include:['.'],imports:{runtime:'postgres-typed-sql/adapters/node-postgres',scalars:'postgres-typed-sql/scalars'}}`
  )
  const project = await openQueryProject(config)
  try {
    const source = await project.compile(query, 'select 7 as value')
    const { code } = await transform(source, { loader: 'ts', format: 'esm' })
    const modulePath = join(root, 'query.mjs')
    await writeFile(modulePath, code)
    const { default: execute } = await import(pathToFileURL(modulePath).href)
    const executor = createPostgresExecutor(async () => ({
      rows: [['7']],
      rowCount: 1,
    }))
    assert.deepEqual(await execute(executor, {}), { value: 7 })
    if (typeof nodeModule.registerHooks === 'function') {
      assert.deepEqual(await project.sources(), [query])
      const snapshot = await project.analyzeProject()
      await project.verify(snapshot)
    } else {
      await assert.rejects(project.sources(), /Node.js 22\.15/u)
      await assert.rejects(project.analyzeProject(), /Node.js 22\.15/u)
      await assert.rejects(project.catalog(), /Node.js 22\.15/u)
    }
  } finally {
    await project.close()
  }
} finally {
  await rm(root, { recursive: true, force: true })
}
