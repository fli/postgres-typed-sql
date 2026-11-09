import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { SqlBuildProject } from '../src/build-project.js'
import { postgresTypedSql } from '../src/vite.js'

const execFileAsync = promisify(execFile)
const imports = { runtime: 'postgres-typed-sql/adapters/node-postgres', scalars: 'postgres-typed-sql/scalars' }

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'typed-sql-build-')))
  const config = join(root, 'config.mjs')
  const schema = join(root, 'schema.sql')
  const helper = join(root, 'helper.mjs')
  const dependency = join(root, 'style.json')
  await writeFile(schema, 'create table widget (id integer primary key, display_name text);')
  await writeFile(helper, "export default {resultColumns: 'camelCase'}")
  await writeFile(dependency, JSON.stringify({ resultColumns: 'preserve' }))
  await writeFile(
    config,
    `import naming from './helper.mjs'; export default {schema:'schema.sql',  imports:${JSON.stringify(imports)}, naming}`
  )
  return { root, config, schema, helper, dependency, source: join(root, 'query.typed.sql') }
}

test('build project refreshes saved inputs, handles parallel requests and recovers after SQL errors', async () => {
  const f = await fixture()
  const project = new SqlBuildProject({ config: f.config, configDependencies: ['style.json'] })
  const sql = 'select id, display_name from widget where id = :id'
  try {
    const [first, second] = await Promise.all([project.compile(f.source, sql), project.compile(f.source, sql)])
    assert.equal(first, second)
    assert.match(first, /readonly displayName: string \| null/u)
    assert.ok(project.watchedFiles.includes(f.helper))
    await writeFile(f.helper, "export default {resultColumns: 'preserve'}")
    assert.match(await project.compile(f.source, sql), /readonly display_name: string \| null/u)
    await writeFile(f.schema, 'create table widget (id integer, display_name text);')
    assert.match(await project.compile(f.source, sql), /resultKind: 'many'/u)
    await assert.rejects(project.compile(f.source, 'select from'))
    assert.match(await project.compile(f.source, sql), /resultKind: 'many'/u)
    await writeFile(f.config, 'invalid javascript !')
    await assert.rejects(project.compile(f.source, sql))
    assert.ok(project.watchedFiles.includes(f.config))
    await writeFile(
      f.config,
      `import {readFileSync} from 'node:fs'; const naming = JSON.parse(readFileSync(new URL('./style.json', import.meta.url))); export default {schema:'schema.sql',imports:${JSON.stringify(imports)},naming}`
    )
    assert.match(await project.compile(f.source, sql), /readonly display_name: string \| null/u)
    await writeFile(f.dependency, JSON.stringify({ resultColumns: 'camelCase' }))
    assert.match(await project.compile(f.source, sql), /readonly displayName: string \| null/u)
  } finally {
    await project.close()
    await rm(f.root, { recursive: true, force: true })
  }
})

test('loader registers dependencies and lets its host process exit after use', async () => {
  const f = await fixture()
  const loader = new URL('../src/turbopack-loader.cjs', import.meta.url)
  const script = `
    const loader = require(${JSON.stringify(loader.pathname)});
    const watched = [];
    loader.call({resourcePath: ${JSON.stringify(f.source)}, getOptions: () => ({config: ${JSON.stringify(f.config)}}),
      addDependency: file => watched.push(file), async: () => (error, code) => {
        if (error) throw error;
        if (!code.includes('displayName') || !watched.includes(${JSON.stringify(f.helper)})) process.exitCode = 1;
      }}, 'select display_name from widget');
  `
  try {
    await execFileAsync(process.execPath, ['-e', script], { timeout: 30000 })
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('Vite accepts missing optional helpers and refreshes when they appear', async () => {
  const f = await fixture()
  const optional = join(f.root, 'optional.mjs')
  await writeFile(
    f.config,
    `let naming = {resultColumns: 'camelCase'};
    try { naming = (await import('./optional.mjs')).default } catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error
    }
    export default {schema:'schema.sql',imports:${JSON.stringify(imports)},naming}`
  )
  const plugin = postgresTypedSql({ config: f.config })
  const watched = new Set<string>()
  const context = { addWatchFile: (file: string) => watched.add(file) }
  const compile = () => plugin.transform.call(context, 'select display_name from widget', f.source)
  try {
    assert.match((await compile())?.code ?? '', /propertyName: "displayName"/u)
    assert.ok(watched.has(optional))
    await writeFile(optional, "export default {resultColumns: 'preserve'}")
    assert.match((await compile())?.code ?? '', /propertyName: "display_name"/u)
  } finally {
    await plugin.closeBundle()
    await rm(f.root, { recursive: true, force: true })
  }
})
