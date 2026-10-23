import { setTimeout, clearTimeout } from 'node:timers'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { verifyMapperLanguageServer, verifyMapperWatch } from './content-mapper-typescript-check.mjs'

const root = resolve(import.meta.dirname, '..')
const consumer = resolve(root, 'artifacts/direct-import-consumer')
const packs = resolve(root, 'artifacts/direct-import-pack')
await rm(consumer, { recursive: true, force: true })
await mkdir(consumer, { recursive: true })
await mkdir(packs, { recursive: true })
const run = (command, args, options = {}) =>
  execFileSync(command, args, { cwd: consumer, encoding: 'utf8', ...options })
const [{ filename }] = JSON.parse(run('npm', ['pack', root, '--ignore-scripts', '--pack-destination', packs, '--json']))
await writeFile(resolve(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
run('npm', [
  'install',
  '--ignore-scripts',
  '--no-audit',
  '--no-fund',
  resolve(packs, filename),
  'typescript@7.1.0-beta',
  'esbuild@0.25.12',
])
for (const entry of await readdir(resolve(root, 'test/consumer'))) {
  if (entry.endsWith('.typed.sql') || entry === 'schema.sql' || entry === 'runtime-facade.mts') {
    await cp(resolve(root, 'test/consumer', entry), resolve(consumer, entry))
  }
}
for (const file of ['consume.mts', 'execute.mts']) {
  const text = (await readFile(resolve(root, 'test/consumer', file), 'utf8')).replaceAll('.typed-sql.js', '.typed.sql')
  await writeFile(resolve(consumer, file), text)
}
await writeFile(
  resolve(consumer, 'config-helper.mjs'),
  "export default {resultColumns:'camelCase',structuredJsonFields:'camelCase'}\n"
)
await writeFile(
  resolve(consumer, 'postgres-typed-sql.config.mjs'),
  `import naming from './config-helper.mjs'
export default { schema: ['schema.sql'], codecProfile: 'node-postgres', naming,
imports: {runtime:'./runtime-facade.mjs',scalars:'postgres-typed-sql/scalars'}}
`
)
await writeFile(
  resolve(consumer, 'tsconfig.json'),
  JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, module: 'nodenext', target: 'es2023', types: [] },
    files: ['consume.mts', 'execute.mts', 'runtime-facade.mts'],
    contentMappers: [
      {
        package: 'postgres-typed-sql',
        extensions: ['.typed.sql'],
        options: { config: './postgres-typed-sql.config.mjs' },
      },
    ],
  })
)
const tsc = resolve(consumer, 'node_modules/typescript/bin/tsc')
const check = (...args) => run(process.execPath, [tsc, '-p', 'tsconfig.json', ...args])
async function snapshot(directory) {
  const hash = createHash('sha256')
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name)
  )) {
    const path = resolve(directory, entry.name)
    hash.update(entry.name)
    hash.update(entry.isDirectory() ? await snapshot(path) : await readFile(path))
  }
  return hash.digest('hex')
}
const installed = resolve(consumer, 'node_modules/postgres-typed-sql')
const before = await snapshot(installed)
assert.throws(
  () => check(),
  (error) => error.stdout?.includes('TS18068')
)
check('--runExternalCode')
await writeFile(
  resolve(consumer, 'invalid.mts'),
  `import {findWidget} from './findWidget.typed.sql'
findWidget.query({code: 123, metrics: []})
findWidget.query({code: 'x'})
`
)
const config = JSON.parse(await readFile(resolve(consumer, 'tsconfig.json'), 'utf8'))
config.files.push('invalid.mts')
await writeFile(resolve(consumer, 'tsconfig.json'), JSON.stringify(config))
assert.throws(
  () => check('--runExternalCode'),
  (error) => error.stdout?.includes('error TS')
)
config.files.pop()
await writeFile(resolve(consumer, 'tsconfig.json'), JSON.stringify(config))
await rm(resolve(consumer, 'invalid.mts'))
await writeFile(
  resolve(consumer, 'helper-check.mts'),
  "import type {FindWidgetRow} from './findWidget.typed.sql'; export type Details = FindWidgetRow['detailsJson']"
)
config.files.push('helper-check.mts')
await writeFile(resolve(consumer, 'tsconfig.json'), JSON.stringify(config))
check('--runExternalCode')
const originalHelper = await readFile(resolve(consumer, 'config-helper.mjs'), 'utf8')
await writeFile(
  resolve(consumer, 'config-helper.mjs'),
  "export default {resultColumns:'preserve',structuredJsonFields:'camelCase'}"
)
assert.throws(
  () => check('--runExternalCode'),
  (error) => error.stdout?.includes('error TS')
)
await writeFile(resolve(consumer, 'config-helper.mjs'), originalHelper)
check('--runExternalCode')
check('--runExternalCode', '--noEmit', 'false', '--outDir', 'ts-output')
assert.ok(
  !(await readdir(resolve(consumer, 'ts-output'), { recursive: true })).some((path) => path.includes('.typed.sql'))
)
const originalSchema = await readFile(resolve(consumer, 'schema.sql'), 'utf8')
const refreshSchema = (primary) =>
  originalSchema + `\ncreate table refresh_widget (id integer ${primary ? 'primary key' : ''});`
await writeFile(resolve(consumer, 'schema.sql'), refreshSchema(true))
await writeFile(resolve(consumer, 'refresh.typed.sql'), 'select id as widget_id from refresh_widget where id = :id')
const refreshCaller = (many) => `import run, {type RefreshRow} from './refresh.typed.sql'
import type {NodePostgresTypedSqlClient} from 'postgres-typed-sql/adapters/node-postgres'
declare const client: NodePostgresTypedSqlClient
const value: ${many ? 'RefreshRow[]' : 'RefreshRow | null'} = await run(client, {id: 1})
void value
`
config.files.push('refresh.mts')
await writeFile(resolve(consumer, 'tsconfig.json'), JSON.stringify(config))
await writeFile(resolve(consumer, 'refresh.mts'), refreshCaller(false))
check('--runExternalCode')
await writeFile(resolve(consumer, 'schema.sql'), refreshSchema(false))
assert.throws(
  () => check('--runExternalCode'),
  (error) => error.stdout?.includes('error TS')
)
await writeFile(resolve(consumer, 'refresh.mts'), refreshCaller(true))
check('--runExternalCode')
await writeFile(resolve(consumer, 'schema.sql'), refreshSchema(true))
await writeFile(resolve(consumer, 'refresh.mts'), refreshCaller(false))
check('--runExternalCode')
config.files.pop()
await writeFile(resolve(consumer, 'tsconfig.json'), JSON.stringify(config))

const { build, context } = await import(resolve(consumer, 'node_modules/esbuild/lib/main.js'))
const { postgresTypedSql } = await import(resolve(installed, 'dist/esbuild.js'))
await build({
  absWorkingDir: consumer,
  entryPoints: ['execute.mts'],
  outfile: 'output/execute.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  plugins: [postgresTypedSql({ config: resolve(consumer, 'postgres-typed-sql.config.mjs') })],
})

await writeFile(resolve(consumer, 'refresh-build.mts'), "export {refresh} from './refresh.typed.sql'")
let onBuild
const observeBuild = {
  name: 'observe-test-build',
  setup(build) {
    build.onEnd((result) => {
      onBuild?.(result)
    })
  },
}
async function nextBuild(action) {
  let timer
  const completed = new Promise((accept, reject) => {
    timer = setTimeout(() => reject(new Error('Timed out waiting for watched build.')), 15000)
    onBuild = accept
  })
  try {
    await action()
    return await completed
  } finally {
    clearTimeout(timer)
    onBuild = undefined
  }
}
const buildContext = await context({
  absWorkingDir: consumer,
  entryPoints: ['refresh-build.mts'],
  outfile: 'output/refresh.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  plugins: [postgresTypedSql({ config: resolve(consumer, 'postgres-typed-sql.config.mjs') }), observeBuild],
  logLevel: 'silent',
})
try {
  for (const primary of [true, false, true]) {
    await writeFile(resolve(consumer, 'schema.sql'), refreshSchema(primary))
    await buildContext.rebuild()
    run(process.execPath, [
      '--input-type=module',
      '-e',
      `import assert from 'node:assert/strict'; import {refresh} from './output/refresh.mjs'; assert.equal(refresh.resultKind, '${primary ? 'optional' : 'many'}')`,
    ])
  }
  for (const camelCase of [false, true]) {
    await writeFile(
      resolve(consumer, 'config-helper.mjs'),
      camelCase ? originalHelper : "export default {resultColumns:'preserve',structuredJsonFields:'camelCase'}"
    )
    await buildContext.rebuild()
    run(process.execPath, [
      '--input-type=module',
      '-e',
      `import assert from 'node:assert/strict'; import {refresh} from './output/refresh.mjs'; assert.equal(refresh.columns[0].propertyName, '${camelCase ? 'widgetId' : 'widget_id'}')`,
    ])
  }
  assert.equal((await nextBuild(() => buildContext.watch())).errors.length, 0)
  assert.ok((await nextBuild(() => writeFile(resolve(consumer, 'refresh.typed.sql'), 'select from'))).errors.length > 0)
  assert.equal(
    (
      await nextBuild(() =>
        writeFile(resolve(consumer, 'refresh.typed.sql'), 'select id as widget_id from refresh_widget where id = :id')
      )
    ).errors.length,
    0
  )
  assert.equal(
    (await nextBuild(() => writeFile(resolve(consumer, 'schema.sql'), refreshSchema(false)))).errors.length,
    0
  )
  run(process.execPath, [
    '--input-type=module',
    '-e',
    "import assert from 'node:assert/strict'; import {refresh} from './output/refresh.mjs'; assert.equal(refresh.resultKind, 'many')",
  ])
  assert.equal(
    (
      await nextBuild(() =>
        writeFile(
          resolve(consumer, 'config-helper.mjs'),
          "export default {resultColumns:'preserve',structuredJsonFields:'camelCase'}"
        )
      )
    ).errors.length,
    0
  )
  run(process.execPath, [
    '--input-type=module',
    '-e',
    "import assert from 'node:assert/strict'; import {refresh} from './output/refresh.mjs'; assert.equal(refresh.columns[0].propertyName, 'widget_id')",
  ])
} finally {
  await buildContext.dispose()
}
await verifyMapperLanguageServer({
  root: resolve(consumer, 'lsp'),
  typescriptPackage: resolve(consumer, 'node_modules/typescript'),
})
await verifyMapperWatch({
  root: resolve(consumer, 'watch'),
  typescriptPackage: resolve(consumer, 'node_modules/typescript'),
})
await rm(resolve(consumer, 'watch'), { recursive: true, force: true })
await rm(resolve(consumer, 'lsp'), { recursive: true, force: true })
const output = await readFile(resolve(consumer, 'output/execute.mjs'), 'utf8')
assert.doesNotMatch(output, /createAnalysisDatabase|PGlite|schema\.sql|config-helper/u)
for (const file of await readdir(consumer)) {
  assert.ok(!file.endsWith('.typed-sql.ts') && file !== 'postgres-typed-sql.types.ts')
  if (
    file.endsWith('.sql') ||
    file.endsWith('.mts') ||
    file.endsWith('.config.mjs') ||
    file === 'config-helper.mjs' ||
    file === 'tsconfig.json'
  )
    await rm(resolve(consumer, file))
}
run(process.execPath, ['output/execute.mjs'])
assert.equal(await snapshot(installed), before)
process.stdout.write(
  'Packed direct imports verified with TypeScript 7.1.0-beta and esbuild 0.25.12. Permission, negative typing, callable runtime, no generation, runtime separation, and package immutability passed.\n'
)
