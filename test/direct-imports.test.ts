import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { watch } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { openQueryProject, QueryProjectError } from '../src/query-project.js'
import { generateTypedSql } from '../src/generator.js'

const imports = { runtime: 'postgres-typed-sql/adapters/node-postgres', scalars: 'postgres-typed-sql/scalars' }

async function fixture(schema = 'create table widget (id integer primary key, display_name text);') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'typed-sql-direct-')))
  await writeFile(join(root, 'schema.sql'), schema)
  await writeFile(join(root, 'helper.mjs'), "export default {resultColumns: 'camelCase'}")
  const config = join(root, 'postgres-typed-sql.config.mjs')
  await writeFile(
    config,
    `import naming from './helper.mjs'\nexport default {schema: ['schema.sql'], codecProfile: 'node-postgres', imports: ${JSON.stringify(imports)}, naming}`
  )
  return { root, config, sourcePath: join(root, 'findWidget.typed.sql') }
}

test('direct compilation consumes supplied text, preserves legacy modules, and writes no outputs', async () => {
  const { root, config, sourcePath } = await fixture()
  const sql = 'select id, display_name from widget where id = :id'
  await writeFile(sourcePath, 'invalid saved query')
  const before = await readdir(root)
  const project = await openQueryProject(config)
  try {
    const text = await project.compile(sourcePath, sql)
    assert.match(text, /resultKind: 'optional'/u)
    assert.match(text, /readonly displayName: string \| null/u)
    assert.deepEqual(await readdir(root), before)
    assert.equal(await readFile(sourcePath, 'utf8'), 'invalid saved query')
    await writeFile(sourcePath, sql)
    await generateTypedSql({
      schema: ['schema.sql'],
      codecProfile: 'node-postgres',
      imports,
      rootDir: root,
      naming: { resultColumns: 'camelCase' },
    })
    assert.equal(text, await readFile(join(root, 'findWidget.typed-sql.ts'), 'utf8'))
    assert.match(await project.compile(sourcePath, 'select 1 as value'), /resultKind: 'one'/u)
  } finally {
    await project.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('projects reload imported helpers and schema constraints and reject obsolete work', async () => {
  const { root, config, sourcePath } = await fixture()
  const sql = 'select id, display_name from widget where id = :id'
  const first = await openQueryProject(config)
  try {
    assert.ok(first.watchedFiles.includes(join(root, 'helper.mjs')))
    assert.match(await first.compile(sourcePath, sql), /resultKind: 'optional'/u)
    await writeFile(join(root, 'schema.sql'), 'create table widget (id integer, display_name text);')
    await assert.rejects(first.compile(sourcePath, sql), /input changed/u)
    await writeFile(join(root, 'helper.mjs'), "export default {resultColumns: 'preserve'}")
    const second = await openQueryProject(config)
    try {
      assert.notEqual(second.configIdentity, first.configIdentity)
      const result = await second.compile(sourcePath, sql)
      assert.match(result, /resultKind: 'many'/u)
      assert.match(result, /readonly display_name: string \| null/u)
      await writeFile(join(root, 'schema.sql'), 'create table widget (id integer primary key, display_name text);')
      const third = await openQueryProject(config)
      try {
        assert.match(await third.compile(sourcePath, sql), /resultKind: 'optional'/u)
      } finally {
        await third.close()
      }
    } finally {
      await second.close()
    }
  } finally {
    await first.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('separate native processes isolate schemas, recover from repeated SQL errors, and close queued work', async () => {
  const left = await fixture('create table widget (id integer primary key);')
  const right = await fixture('create table widget (id text);')
  const [a, b] = await Promise.all([openQueryProject(left.config), openQueryProject(right.config)])
  try {
    const sql = 'select id from widget where id = :id'
    const [one, many] = await Promise.all([a.compile(left.sourcePath, sql), b.compile(right.sourcePath, sql)])
    assert.match(one, /resultKind: 'optional'/u)
    assert.match(one, /readonly id: number/u)
    assert.match(many, /resultKind: 'many'/u)
    assert.match(many, /readonly id: string/u)
    for (let index = 0; index < 7; index++) await assert.rejects(a.compile(left.sourcePath, 'select from'))
    assert.match(await a.compile(left.sourcePath, sql), /resultKind: 'optional'/u)
    const pending = a.compile(left.sourcePath, sql)
    const rejection = assert.rejects(pending, /closed/u)
    await a.close()
    await rejection
    await assert.rejects(a.compile(left.sourcePath, sql), /closed/u)
  } finally {
    await Promise.all([a.close(), b.close()])
    await Promise.all([
      rm(left.root, { recursive: true, force: true }),
      rm(right.root, { recursive: true, force: true }),
    ])
  }
})

test('a repeated cached helper import cannot relabel evaluated configuration with newer bytes', async () => {
  const { root, config, sourcePath } = await fixture()
  await writeFile(
    config,
    `import naming from './helper.mjs'
import {writeFile} from 'node:fs/promises'
await writeFile(new URL('./helper.mjs', import.meta.url), "export default {resultColumns: 'preserve'}")
await import('./helper.mjs')
export default {schema: ['schema.sql'], codecProfile: 'node-postgres', naming, imports: ${JSON.stringify(imports)}}`
  )
  const project = await openQueryProject(config)
  try {
    await assert.rejects(project.compile(sourcePath, 'select display_name from widget'), /input changed/u)
  } finally {
    await project.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('package export changes invalidate configuration and unchanged revisions have stable identities', async () => {
  const { root, config, sourcePath } = await fixture()
  const helper = join(root, 'node_modules', 'config-helper')
  await mkdir(helper, { recursive: true })
  const manifest = join(helper, 'package.json')
  await writeFile(manifest, JSON.stringify({ type: 'module', exports: './camel.mjs' }))
  await writeFile(join(helper, 'camel.mjs'), "export default {resultColumns: 'camelCase'}")
  await writeFile(join(helper, 'preserve.mjs'), "export default {resultColumns: 'preserve'}")
  await writeFile(
    config,
    `import naming from 'config-helper'; export default {schema: 'schema.sql', codecProfile: 'node-postgres', naming, imports: ${JSON.stringify(imports)}}`
  )
  const first = await openQueryProject(config, { configDependencies: [manifest] })
  try {
    const unchanged = await openQueryProject(config, { configDependencies: [manifest] })
    try {
      assert.equal(unchanged.configIdentity, first.configIdentity)
    } finally {
      await unchanged.close()
    }
    assert.ok(first.watchedFiles.includes(manifest))
    await writeFile(manifest, JSON.stringify({ type: 'module', exports: './preserve.mjs' }))
    await assert.rejects(first.compile(sourcePath, 'select display_name from widget'), /input changed/u)
    const next = await openQueryProject(config, { configDependencies: [manifest] })
    try {
      assert.notEqual(next.configIdentity, first.configIdentity)
      assert.match(await next.compile(sourcePath, 'select display_name from widget'), /readonly display_name: string/u)
    } finally {
      await next.close()
    }
  } finally {
    await first.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('disconnecting during configuration evaluation retires the startup worker', { timeout: 15000 }, async () => {
  const { root, config } = await fixture()
  await writeFile(
    config,
    "import {writeFile} from 'node:fs/promises'; await writeFile(new URL('./started', import.meta.url), 'started'); await new Promise(() => {}); export default {}"
  )
  const watcher = watch(root)
  const started = new Promise<void>((accept) =>
    watcher.on('change', (_event, filename) => {
      if (filename === 'started') accept()
    })
  )
  const worker = fork(new URL('../src/query-worker.js', import.meta.url), [config], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    execArgv: [],
  })
  const exited = once(worker, 'exit')
  try {
    await started
    worker.disconnect()
    const [code] = await exited
    assert.equal(code, 0)
  } finally {
    watcher.close()
    worker.kill('SIGKILL')
    await rm(root, { recursive: true, force: true })
  }
})

test('different module URLs cannot retain two source revisions under one dependency identity', async () => {
  const { root, config } = await fixture()
  await writeFile(
    config,
    `import naming from './helper.mjs'
import {writeFile} from 'node:fs/promises'
await writeFile(new URL('./helper.mjs', import.meta.url), "export default {resultColumns: 'preserve'}")
await import('./helper.mjs?fresh')
export default {schema: 'schema.sql', codecProfile: 'node-postgres', naming, imports: ${JSON.stringify(imports)}}`
  )
  try {
    await assert.rejects(openQueryProject(config), /dependency changed while evaluating/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('fresh projects preserve custom codec closures and include helper source in identity', async () => {
  const { root, config, sourcePath } = await fixture()
  const helper = join(root, 'helper.mjs')
  const profile = (type: string) =>
    `const type = '${type}'; export default {extends:'node-postgres',name:'custom',resultType(){return {type,ambientBindings:[],scalarImports:[]}}}`
  await writeFile(helper, profile('number'))
  await writeFile(
    config,
    `import codecProfile from './helper.mjs'; export default {schema:'schema.sql',codecProfile,imports:${JSON.stringify(imports)}}`
  )
  const first = await openQueryProject(config)
  try {
    assert.match(await first.compile(sourcePath, 'select id from widget'), /readonly id: number/u)
    await writeFile(helper, profile('string'))
    await assert.rejects(first.compile(sourcePath, 'select id from widget'), /input changed/u)
    const next = await openQueryProject(config)
    try {
      assert.notEqual(next.configIdentity, first.configIdentity)
      assert.match(await next.compile(sourcePath, 'select id from widget'), /readonly id: string/u)
    } finally {
      await next.close()
    }
  } finally {
    await first.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('canceling startup terminates an uncooperative configuration worker', { timeout: 15000 }, async () => {
  const { root, config } = await fixture()
  await writeFile(
    config,
    "import {writeFile,rename} from 'node:fs/promises'; process.removeAllListeners('disconnect'); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000); await writeFile(new URL('./pid.tmp',import.meta.url),String(process.pid)); await rename(new URL('./pid.tmp',import.meta.url),new URL('./started',import.meta.url)); await new Promise(()=>{}); export default {}"
  )
  const watcher = watch(root)
  const started = new Promise<void>((accept) =>
    watcher.on('change', (_event, filename) => {
      if (filename === 'started') accept()
    })
  )
  const controller = new AbortController()
  const dependency = join(root, 'settings.json')
  await writeFile(dependency, '{}')
  const opening = openQueryProject(config, { signal: controller.signal, configDependencies: [dependency] })
  const canceled = assert.rejects(opening, (error) => {
    assert.ok(error instanceof QueryProjectError)
    assert.match(error.message, /opening was canceled/u)
    assert.ok(error.watchedFiles.includes(dependency))
    return true
  })
  try {
    await started
    const pid = Number(await readFile(join(root, 'started'), 'utf8'))
    assert.ok(Number.isSafeInteger(pid) && pid > 0)
    controller.abort()
    await canceled
    assert.throws(() => process.kill(pid, 0), /ESRCH/u)
  } finally {
    controller.abort()
    watcher.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('package aliases include root export manifests below nested package scopes', async () => {
  const { root, config, sourcePath } = await fixture()
  const helper = join(root, 'node_modules', 'config-helper')
  await mkdir(join(helper, 'lib'), { recursive: true })
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ type: 'module', imports: { '#naming': 'config-helper' } })
  )
  const manifest = join(helper, 'package.json')
  await writeFile(manifest, JSON.stringify({ type: 'module', exports: './lib/camel.mjs' }))
  await writeFile(join(helper, 'lib', 'package.json'), JSON.stringify({ type: 'module' }))
  await writeFile(join(helper, 'lib', 'camel.mjs'), "export default {resultColumns:'camelCase'}")
  await writeFile(join(helper, 'lib', 'preserve.mjs'), "export default {resultColumns:'preserve'}")
  await writeFile(
    config,
    `import naming from '#naming'; export default {schema:'schema.sql',codecProfile:'node-postgres',naming,imports:${JSON.stringify(imports)}}`
  )
  const first = await openQueryProject(config, { configDependencies: [join(root, 'package.json'), manifest] })
  try {
    assert.ok(first.watchedFiles.includes(manifest))
    await writeFile(manifest, JSON.stringify({ type: 'module', exports: './lib/preserve.mjs' }))
    await assert.rejects(first.compile(sourcePath, 'select display_name from widget'), /input changed/u)
    const next = await openQueryProject(config, { configDependencies: [join(root, 'package.json'), manifest] })
    try {
      assert.match(await next.compile(sourcePath, 'select display_name from widget'), /readonly display_name: string/u)
    } finally {
      await next.close()
    }
  } finally {
    await first.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('declared package metadata remains watched when Node returns no resolved module URL', async () => {
  const { root, config, sourcePath } = await fixture()
  const helper = join(root, 'node_modules', 'config-helper')
  await mkdir(helper, { recursive: true })
  const scope = join(root, 'package.json')
  await writeFile(scope, JSON.stringify({ type: 'module', imports: { '#naming': 'config-helper' } }))
  const manifest = join(helper, 'package.json')
  await writeFile(manifest, JSON.stringify({ type: 'module', exports: { './other': './helper.mjs' } }))
  await writeFile(join(helper, 'helper.mjs'), "export default {resultColumns:'preserve'}")
  await writeFile(
    config,
    `import naming from '#naming'; export default {schema:'schema.sql',codecProfile:'node-postgres',naming,imports:${JSON.stringify(imports)}}`
  )
  const options = { configDependencies: [scope, manifest] }
  try {
    await assert.rejects(
      openQueryProject(config, options),
      (error) => error instanceof QueryProjectError && error.watchedFiles.includes(manifest)
    )
    await writeFile(manifest, JSON.stringify({ type: 'module', exports: './helper.mjs' }))
    const project = await openQueryProject(config, options)
    try {
      assert.match(
        await project.compile(sourcePath, 'select display_name from widget'),
        /readonly display_name: string/u
      )
    } finally {
      await project.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('handled missing ESM helpers remain valid configuration inputs and refresh when created', async () => {
  const { root, config, sourcePath } = await fixture()
  const helper = join(root, 'optional.mjs')
  await writeFile(
    config,
    `let naming = {resultColumns:'camelCase'};
try { naming = (await import('./optional.mjs')).default }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error }
export default {schema:'schema.sql',codecProfile:'node-postgres',naming,imports:${JSON.stringify(imports)}}`
  )
  const first = await openQueryProject(config)
  try {
    assert.ok(first.watchedFiles.includes(helper))
    assert.match(await first.compile(sourcePath, 'select display_name from widget'), /readonly displayName: string/u)
    await writeFile(helper, "export default {resultColumns:'preserve'}")
    await assert.rejects(first.compile(sourcePath, 'select display_name from widget'), /input changed/u)
    const next = await openQueryProject(config)
    try {
      assert.notEqual(next.configIdentity, first.configIdentity)
      assert.match(await next.compile(sourcePath, 'select display_name from widget'), /readonly display_name: string/u)
    } finally {
      await next.close()
    }
  } finally {
    await first.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('unexpected startup exits retain declared configuration watches', async () => {
  const { root, config } = await fixture()
  const dependency = join(root, 'settings.json')
  await writeFile(dependency, '{}')
  await writeFile(config, 'process.exit(3); export default {}')
  try {
    await assert.rejects(openQueryProject(config, { configDependencies: [dependency] }), (error) => {
      assert.ok(error instanceof QueryProjectError)
      assert.match(error.message, /worker exited/u)
      assert.ok(error.watchedFiles.includes(dependency))
      return true
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
