import { Buffer } from 'node:buffer'
import { setTimeout, clearTimeout } from 'node:timers'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export async function verifyMapperLanguageServer({ root, typescriptPackage }) {
  await mkdir(root, { recursive: true })
  const getExePath = (await import(pathToFileURL(resolve(typescriptPackage, 'lib/getExePath.js')).href)).default
  const uri = (file) => pathToFileURL(resolve(root, file)).href
  const sql = 'select id from widget where id = :id'
  const caller = `import run from './find.typed.sql'
import type {NodePostgresTypedSqlClient} from 'postgres-typed-sql/adapters/node-postgres'
declare const client: NodePostgresTypedSqlClient
const value = await run(client, {id:1})
void value
`
  await writeFile(resolve(root, 'schema.sql'), 'create table widget (id integer primary key)')
  await writeFile(
    resolve(root, 'postgres-typed-sql.config.mjs'),
    "export default {schema:'schema.sql',codecProfile:'node-postgres',imports:{runtime:'postgres-typed-sql/adapters/node-postgres',scalars:'postgres-typed-sql/scalars'}}"
  )
  await writeFile(
    resolve(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, module: 'nodenext', target: 'es2023', types: [] },
      files: ['caller.mts'],
      contentMappers: [{ package: 'postgres-typed-sql', extensions: ['.typed.sql'] }],
    })
  )
  await writeFile(resolve(root, 'find.typed.sql'), sql)
  await writeFile(resolve(root, 'caller.mts'), caller)
  const child = spawn(getExePath(), ['--lsp', '--stdio'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] })
  let buffer = Buffer.alloc(0)
  let nextId = 0
  let stderr = ''
  const pending = new Map()
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
  })
  const send = (message) => {
    const body = JSON.stringify(message)
    child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
  }
  const request = (method, params) =>
    new Promise((accept, reject) => {
      const id = nextId++
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`Language server timed out for ${method}. ${stderr}`))
      }, 90000)
      pending.set(id, { accept, reject, timer })
      send({ jsonrpc: '2.0', id, method, params })
    })
  const notify = (method, params) => send({ jsonrpc: '2.0', method, params })
  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    while (true) {
      const end = buffer.indexOf('\r\n\r\n')
      if (end < 0) return
      const match = /Content-Length: (\d+)/iu.exec(buffer.subarray(0, end).toString())
      assert.ok(match?.[1])
      const size = Number(match[1])
      if (buffer.length < end + 4 + size) return
      const message = JSON.parse(buffer.subarray(end + 4, end + 4 + size).toString())
      buffer = buffer.subarray(end + 4 + size)
      if (message.method && message.id !== undefined) {
        send({ jsonrpc: '2.0', id: message.id, result: message.method === 'workspace/configuration' ? [] : null })
      } else if (message.id !== undefined) {
        const response = pending.get(message.id)
        if (!response) continue
        clearTimeout(response.timer)
        pending.delete(message.id)
        if (message.error) response.reject(new Error(JSON.stringify(message.error)))
        else response.accept(message.result)
      }
    }
  })
  const exited = new Promise((accept) => child.once('exit', accept))
  try {
    const initialized = await request('initialize', {
      processId: process.pid,
      rootUri: pathToFileURL(root).href,
      capabilities: { textDocument: { diagnostic: { dynamicRegistration: true } }, workspace: { configuration: true } },
      initializationOptions: { runExternalCode: true, disablePushDiagnostics: true },
    })
    assert.equal(initialized.serverInfo.version, '7.1.0-beta')
    notify('initialized', {})
    notify('textDocument/didOpen', {
      textDocument: { uri: uri('find.typed.sql'), languageId: 'sql', version: 1, text: sql },
    })
    notify('textDocument/didOpen', {
      textDocument: { uri: uri('caller.mts'), languageId: 'typescript', version: 1, text: caller },
    })
    const diagnostics = async () =>
      (await request('textDocument/diagnostic', { textDocument: { uri: uri('caller.mts') } })).items.filter(
        (item) => item.severity === 1
      )
    assert.deepEqual(await diagnostics(), [])
    notify('textDocument/didChange', {
      textDocument: { uri: uri('find.typed.sql'), version: 2 },
      contentChanges: [{ text: 'select id from widget where id = :other' }],
    })
    const changed = await diagnostics()
    assert.ok(changed.some((item) => item.code === 2353 && item.message.includes("'id'")))
    notify('textDocument/didChange', {
      textDocument: { uri: uri('find.typed.sql'), version: 3 },
      contentChanges: [{ text: sql }],
    })
    assert.deepEqual(await diagnostics(), [])
    assert.equal(await readFile(resolve(root, 'find.typed.sql'), 'utf8'), sql)
    await request('shutdown')
    notify('exit')
  } finally {
    child.stdin.end()
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
    try {
      await exited
    } finally {
      clearTimeout(timer)
    }
    for (const response of pending.values()) clearTimeout(response.timer)
  }
}

export async function verifyMapperWatch({ root, typescriptPackage }) {
  const settings = resolve(root, 'settings')
  await mkdir(settings, { recursive: true })
  const schema = (primary) => `create table widget (id integer ${primary ? 'primary key' : ''}, display_name text);`
  const naming = (camel) => `export default {resultColumns: '${camel ? 'camelCase' : 'preserve'}'}`
  const manifest = (target) =>
    JSON.stringify({ type: 'module', imports: target ? { '#naming': `./${target}.mjs` } : {} })
  const manifestPath = resolve(settings, 'package.json')
  const external = resolve(settings, 'node_modules', 'config-helper')
  await mkdir(resolve(external, 'dist'), { recursive: true })
  const externalManifest = resolve(external, 'package.json')
  await writeFile(externalManifest, JSON.stringify({ type: 'module', exports: { './other': './dist/camel.mjs' } }))
  await writeFile(resolve(external, 'dist', 'package.json'), JSON.stringify({ type: 'module' }))
  await writeFile(resolve(external, 'dist', 'camel.mjs'), naming(true))
  await writeFile(resolve(external, 'dist', 'preserve.mjs'), naming(false))
  await writeFile(manifestPath, manifest())
  await writeFile(resolve(settings, 'camel.mjs'), naming(true))
  await writeFile(resolve(settings, 'preserve.mjs'), naming(false))
  await writeFile(
    resolve(settings, 'config.mjs'),
    "import naming from '#naming'; export default {rootDir:'..',schema:'schema.sql',codecProfile:'node-postgres',naming,imports:{runtime:'postgres-typed-sql/adapters/node-postgres',scalars:'postgres-typed-sql/scalars'}}"
  )
  await writeFile(resolve(root, 'schema.sql'), schema(true))
  await writeFile(resolve(root, 'find.typed.sql'), 'select id, display_name from widget where id = :id')
  await writeFile(
    resolve(root, 'caller.mts'),
    `import run, {type FindRow} from './find.typed.sql'
import type {NodePostgresTypedSqlClient} from 'postgres-typed-sql/adapters/node-postgres'
declare const client: NodePostgresTypedSqlClient
const result: FindRow | null = await run(client, {id:1})
if (result) void result.displayName
`
  )
  await writeFile(
    resolve(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, module: 'nodenext', target: 'es2023', types: [] },
      files: ['caller.mts'],
      contentMappers: [
        {
          package: 'postgres-typed-sql',
          extensions: ['.typed.sql'],
          options: {
            config: './settings/config.mjs',
            configDependencies: ['package.json', 'node_modules/config-helper/package.json'],
          },
        },
      ],
    })
  )
  const getExePath = (await import(pathToFileURL(resolve(typescriptPackage, 'lib/getExePath.js')).href)).default
  const child = spawn(
    getExePath(),
    ['--watch', '--preserveWatchOutput', '--runExternalCode', '--pretty', 'false', '-p', 'tsconfig.json'],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  let output = ''
  let stderr = ''
  let inspect
  child.stdout.on('data', (chunk) => {
    output += chunk.toString()
    inspect?.()
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
  })
  const exited = new Promise((accept) => child.once('exit', accept))
  async function buildAfter(action, valid, expectedText) {
    const start = output.length
    let timer
    const completed = new Promise((accept, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Timed out waiting for compiler watch. ${output.slice(start)} ${stderr}`)),
        90000
      )
      inspect = () => {
        const text = output.slice(start)
        const matches = [...text.matchAll(/Found (\d+) errors?\. Watching for file changes\./gu)]
        const last = matches.at(-1)
        if (last && (Number(last[1]) === 0) === valid && (!expectedText || text.includes(expectedText))) accept(text)
      }
    })
    try {
      await action()
      inspect()
      return await completed
    } finally {
      clearTimeout(timer)
      inspect = undefined
    }
  }
  try {
    await buildAfter(async () => {}, false, '#naming')
    await buildAfter(() => writeFile(manifestPath, manifest('missing')), false, 'missing.mjs')
    await buildAfter(() => writeFile(resolve(settings, 'missing.mjs'), naming(true)), true)
    await buildAfter(() => writeFile(manifestPath, manifest('camel')), true)
    await buildAfter(() => writeFile(resolve(root, 'schema.sql'), schema(false)), false, 'FindRow[]')
    await buildAfter(() => writeFile(resolve(root, 'schema.sql'), schema(true)), true)
    await buildAfter(() => writeFile(resolve(settings, 'camel.mjs'), naming(false)), false, 'displayName')
    await buildAfter(() => writeFile(resolve(settings, 'camel.mjs'), naming(true)), true)
    await buildAfter(() => writeFile(manifestPath, manifest('preserve')), false, 'displayName')
    await buildAfter(() => writeFile(manifestPath, manifest('camel')), true)
    await buildAfter(
      () => writeFile(manifestPath, JSON.stringify({ type: 'module', imports: { '#naming': 'config-helper' } })),
      false,
      'exports'
    )
    await buildAfter(
      () => writeFile(externalManifest, JSON.stringify({ type: 'module', exports: './dist/camel.mjs' })),
      true
    )
    await buildAfter(
      () => writeFile(externalManifest, JSON.stringify({ type: 'module', exports: './dist/preserve.mjs' })),
      false,
      'displayName'
    )
    await buildAfter(
      () => writeFile(externalManifest, JSON.stringify({ type: 'module', exports: './dist/camel.mjs' })),
      true
    )
  } finally {
    child.kill()
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
    try {
      await exited
    } finally {
      clearTimeout(timer)
    }
  }
}
