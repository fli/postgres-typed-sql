import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { watch } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

function mapper() {
  const process = spawn(globalThis.process.execPath, [new URL('../src/content-mapper.js', import.meta.url).pathname], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const exited = new Promise<void>((resolve) => process.once('exit', () => resolve()))
  let buffer = Buffer.alloc(0)
  let nextId = 0
  const pending = new Map<number, (value: unknown) => void>()
  process.stdout.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    while (true) {
      const end = buffer.indexOf('\r\n\r\n')
      if (end < 0) return
      const match = /Content-Length: (\d+)/iu.exec(buffer.subarray(0, end).toString())
      assert.ok(match?.[1])
      const size = Number(match[1])
      if (buffer.length < end + 4 + size) return
      const response = JSON.parse(buffer.subarray(end + 4, end + 4 + size).toString()) as {
        id: number
        result: unknown
        error?: unknown
      }
      buffer = buffer.subarray(end + 4 + size)
      assert.equal(response.error, undefined)
      pending.get(response.id)?.(response.result)
      pending.delete(response.id)
    }
  })
  return {
    process,
    exited,
    request(method: string, params: unknown) {
      const id = nextId++
      const body = JSON.stringify({ jsonrpc: '2.0', id, method, params })
      const result = new Promise<unknown>((resolve) => pending.set(id, resolve))
      const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`
      process.stdin.write(header.slice(0, 7))
      process.stdin.write(header.slice(7) + body)
      return result
    },
    async close() {
      process.stdin.end()
      await exited
    },
  }
}

function result(value: unknown): { text: string; diagnostics?: unknown[] } {
  assert.ok(value && typeof value === 'object' && 'text' in value && typeof value.text === 'string')
  return value as { text: string; diagnostics?: unknown[] }
}

test(
  'real framed mapper uses unsaved buffers, reports recoverable diagnostics, refreshes schema, and closes projects',
  { timeout: 120000 },
  async () => {
    const client = mapper()
    const root = await mkdtemp(join(tmpdir(), 'typed-sql-mapper-'))
    const fileName = join(root, 'find.typed.sql')
    const schema = join(root, 'schema.sql')
    const config = join(root, 'postgres-typed-sql.config.mjs')
    const projectHandle = 'test-project'
    try {
      assert.deepEqual(await client.request('initialize', { positionEncodings: ['utf-16'] }), {
        positionEncoding: 'utf-16',
        diagnosticSource: 'postgres-typed-sql',
      })
      await writeFile(schema, 'create table widget (id integer primary key);')
      await writeFile(
        config,
        "export default {schema: ['schema.sql'], codecProfile: 'node-postgres', imports: {runtime:'postgres-typed-sql/adapters/node-postgres', scalars:'postgres-typed-sql/scalars'}}"
      )
      await writeFile(fileName, 'invalid saved text')
      const open = () =>
        client.request('openProject', {
          configFileName: join(root, 'tsconfig.json'),
          projectHandle,
          options: { config: './postgres-typed-sql.config.mjs' },
          compilerOptions: {},
        })
      await rm(schema)
      const failed = await open()
      assert.ok(failed && typeof failed === 'object' && 'configIdentity' in failed && failed.configIdentity)
      assert.ok('watchedFiles' in failed && Array.isArray(failed.watchedFiles) && failed.watchedFiles.includes(schema))
      const missing = result(
        await client.request('transform', { projectHandle, fileName, content: 'select id from widget' })
      )
      assert.ok(missing.diagnostics)
      assert.match(JSON.stringify(missing.diagnostics), /schema\.sql/u)
      await writeFile(schema, 'create table widget (id integer primary key);')
      const first = await open()
      const before = await readdir(root)
      const content = 'select id from widget where id = :id /* 雪 */'
      const transform = (content: string) => client.request('transform', { projectHandle, fileName, content })
      assert.match(result(await transform(content)).text, /resultKind: 'optional'/u)
      for (let index = 0; index < 7; index++)
        assert.equal(result(await transform('select from')).diagnostics?.length, 1)
      assert.equal(result(await transform(content)).diagnostics, undefined)
      assert.equal(await readFile(fileName, 'utf8'), 'invalid saved text')
      assert.deepEqual(await readdir(root), before)
      await writeFile(schema, 'create table widget (id integer);')
      const second = await open()
      assert.notDeepEqual(first, second)
      assert.match(result(await transform(content)).text, /resultKind: 'many'/u)
      const obsolete = transform(content)
      await client.request('closeProject', { projectHandle })
      assert.equal(result(await obsolete).diagnostics?.length, 1)
      assert.equal(result(await transform(content)).diagnostics?.length, 1)
    } finally {
      await client.close()
      await rm(root, { recursive: true, force: true })
    }
  }
)

for (const action of ['EOF then signal', 'close then signal', 'two signals', 'broken output'] as const) {
  test(`mapper waits for retiring workers during ${action}`, { timeout: 20000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'typed-sql-shutdown-'))
    const watcher = watch(root)
    const marker = (name: string) =>
      new Promise<void>((accept) =>
        watcher.on('change', (_event, file) => {
          if (file === name) accept()
        })
      )
    const started = marker('started')
    const retiring = marker('retiring')
    const config = join(root, 'config.mjs')
    await writeFile(
      config,
      `import {writeFile,rename} from 'node:fs/promises';
process.removeAllListeners('disconnect'); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);
process.on('disconnect',()=>void writeFile(new URL('./retiring',import.meta.url),'yes'));
await writeFile(new URL('./pid.tmp',import.meta.url),String(process.pid));
await rename(new URL('./pid.tmp',import.meta.url),new URL('./started',import.meta.url));
await new Promise(()=>{}); export default {}`
    )
    const client = mapper()
    let pid: number | undefined
    try {
      await client.request('initialize', {})
      void client.request('openProject', {
        projectHandle: 'pending',
        configFileName: join(root, 'tsconfig.json'),
        options: { config },
      })
      await started
      pid = Number(await readFile(join(root, 'started'), 'utf8'))
      assert.ok(Number.isSafeInteger(pid) && pid > 0)
      if (action === 'EOF then signal') client.process.stdin.end()
      else if (action === 'close then signal') void client.request('closeProject', { projectHandle: 'pending' })
      else if (action === 'two signals') client.process.kill('SIGTERM')
      else {
        client.process.stdout.destroy()
        void client.request('initialize', {})
      }
      await retiring
      if (action !== 'broken output') client.process.kill('SIGTERM')
      await client.exited
      const workerPid = pid
      assert.throws(() => process.kill(workerPid, 0), /ESRCH/u)
    } finally {
      client.process.kill('SIGKILL')
      if (pid) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch (error) {
          assert.ok(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH')
        }
      }
      watcher.close()
      await rm(root, { recursive: true, force: true })
    }
  })
}
