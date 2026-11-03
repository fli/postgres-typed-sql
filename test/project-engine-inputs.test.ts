import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
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
      `export default {schema:'schema.sql',include:['.'],extensions:['citext'],codecProfile:'node-postgres',imports:{runtime:'postgres-typed-sql/runtime',scalars:'postgres-typed-sql/scalars'}}`
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
