import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

const execFileAsync = promisify(execFile)

test('project snapshots include extension archives and engine JavaScript', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'typed-sql-engine-inputs-')))
  const tool = join(root, 'tool')
  await mkdir(tool)
  try {
    await cp(new URL('../src/', import.meta.url), join(tool, 'dist'), { recursive: true })
    await cp(new URL('../package.json', import.meta.url), join(tool, 'package.json'))
    await writeFile(join(root, 'schema.sql'), 'create table widget (name citext);')
    await writeFile(join(root, 'query.typed.sql'), 'select name from widget')
    await writeFile(
      join(root, 'config.mjs'),
      `export default {schema:'schema.sql',include:['.'],extensions:['citext'],imports:{runtime:'postgres-typed-sql/runtime',scalars:'postgres-typed-sql/scalars'}}`
    )
    const script = `
      import assert from 'node:assert/strict';
      import {appendFile, readFile, writeFile} from 'node:fs/promises';
      import {pathToFileURL} from 'node:url';
      const {openQueryProject} = await import(pathToFileURL(process.argv[1] + '/tool/dist/query-project.js').href);
      const project = await openQueryProject(process.argv[1] + '/config.mjs');
      try {
        const snapshot = await project.analyzeProject();
        const archive = snapshot.inputs.find(input => input.role === 'engine' && input.path.endsWith('/citext.tar.gz'));
        assert(archive, 'enabled extension archive is a verified engine input');
        assert(snapshot.inputs.some(input => input.role === 'engine' && input.path.endsWith('/pglite/index.js')));
        assert(snapshot.inputs.some(input => input.role === 'engine' && input.path.endsWith('/pglite/pglite.data')));
        await project.verify(snapshot);
        const original = await readFile(archive.path);
        await appendFile(archive.path, 'changed');
        await assert.rejects(project.verify(snapshot), /input changed/);
        await writeFile(archive.path, original);
        await project.verify(snapshot);
      } finally {await project.close();}
    `
    const result = await execFileAsync(process.execPath, ['--input-type=module', '--eval', script, root])
    assert.equal(result.stderr, '')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('overlapping requests share only scans that have not started', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'typed-sql-scan-batch-')))
  const tool = join(root, 'tool')
  await mkdir(tool)
  try {
    await cp(new URL('../src/', import.meta.url), join(tool, 'dist'), { recursive: true })
    await cp(new URL('../package.json', import.meta.url), join(tool, 'package.json'))
    const modulePath = join(tool, 'dist/query-project.js')
    const source = await readFile(modulePath, 'utf8')
    const instrumented = source.replace("from 'node:fs/promises'", "from './read-file-hook.js'")
    assert.notEqual(instrumented, source)
    await writeFile(modulePath, instrumented)
    await writeFile(
      join(tool, 'dist/read-file-hook.js'),
      `import {readFile as realReadFile} from 'node:fs/promises';
      export const state = {target: '', count: 0};
      export let enteredResolve, releaseResolve;
      export const entered = new Promise(resolve => { enteredResolve = resolve });
      export const release = new Promise(resolve => { releaseResolve = resolve });
      export async function readFile(path) {
        const count = path === state.target ? ++state.count : 0;
        const content = await realReadFile(path);
        if (count === 1) {
          enteredResolve();
          await release;
        }
        return content;
      }`
    )
    await writeFile(join(root, 'schema.sql'), 'create table widget (id integer);')
    await writeFile(
      join(root, 'config.mjs'),
      `import {appendFileSync} from 'node:fs';
      process.on('message', message => appendFileSync(new URL('./requests', import.meta.url), message.operation + '\\n'));
      export default {schema:'schema.sql',include:['.']}`
    )
    const script = `
      import assert from 'node:assert/strict';
      import {readFile, writeFile} from 'node:fs/promises';
      import {setImmediate} from 'node:timers/promises';
      import {pathToFileURL} from 'node:url';
      const base = process.argv[1];
      const {openQueryProject} = await import(pathToFileURL(base + '/tool/dist/query-project.js'));
      const hook = await import(pathToFileURL(base + '/tool/dist/read-file-hook.js'));
      const config = base + '/config.mjs';
      const original = await readFile(config, 'utf8');
      const project = await openQueryProject(config);
      try {
        hook.state.target = config;
        const first = project.sources();
        const second = project.sources();
        const firstResults = Promise.allSettled([first, second]);
        await hook.entered;
        await setImmediate();
        assert.equal(hook.state.count, 1);
        const late = project.sources();
        const lateResult = assert.rejects(late, /input changed/);
        await setImmediate();
        await writeFile(config, original + '\\n');
        hook.releaseResolve();
        await lateResult;
        for (const result of await firstResults) {
          assert.equal(result.status, 'rejected');
          assert.match(result.reason.message, /input changed/);
        }
        assert.equal(await readFile(base + '/requests', 'utf8'), 'inventory\\ninventory\\n');
        await writeFile(config, original);
        await project.sources();
      } finally {
        hook.releaseResolve();
        await project.close();
      }
    `
    const result = await execFileAsync(process.execPath, ['--input-type=module', '--eval', script, root], {
      timeout: 30000,
    })
    assert.equal(result.stderr, '')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
