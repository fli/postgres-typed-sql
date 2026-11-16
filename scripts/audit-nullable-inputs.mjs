import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { log } from 'node:console'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL, URL } from 'node:url'

const [consumerDirectory, inventoryPath, outputPath, projectModule] = process.argv.slice(2)
if (!consumerDirectory || !inventoryPath || !outputPath) {
  throw new Error(
    'Usage: node scripts/audit-nullable-inputs.mjs <consumer-root> <inventory.json> <output.json> [project-module]'
  )
}
const { openQueryProject } = await import(projectModule ?? new URL('../dist/project.js', import.meta.url).href)
const inventory = JSON.parse(await readFile(resolve(inventoryPath), 'utf8'))
const consumer = resolve(consumerDirectory)
const configuration = (await import(pathToFileURL(join(consumer, 'packages/db/postgres-typed-sql.config.mjs')).href))
  .default
const root = await mkdtemp(join(tmpdir(), 'typed-sql-nullable-audit-'))
const results = []
try {
  await mkdir(join(root, 'queries'))
  await copyFile(join(consumer, 'packages/db/schema.sql'), join(root, 'schema.sql'))
  for (const [index, entry] of inventory.entries()) {
    await copyFile(join(consumer, entry.source), join(root, 'queries', `probe${index}.typed.sql`))
  }
  await writeFile(
    join(root, 'config.mjs'),
    `export default ${JSON.stringify({
      ...configuration,
      rootDir: root,
      schema: 'schema.sql',
      include: ['queries'],
      typesOutput: 'types.ts',
      jsonbFunctionContracts: [],
    })}`
  )
  const project = await openQueryProject(join(root, 'config.mjs'))
  try {
    for (const [index, entry] of inventory.entries()) {
      const source = await readFile(join(consumer, entry.source), 'utf8')
      for (const parameter of entry.rejected) {
        const declaration = `-- @bindNull ${parameter}`
        if (!source.includes(declaration)) throw new Error(`${entry.source}: missing ${declaration}`)
        const candidate = source.replace(declaration, `-- @nullable ${parameter}`)
        try {
          await project.compile(join(root, 'queries', `probe${index}.typed.sql`), candidate)
          results.push({ source: entry.source, parameter, admission: 'accepts' })
        } catch (error) {
          if (!error.message.includes(`@nullable ${parameter} cannot be satisfied`)) throw error
          results.push({
            source: entry.source,
            parameter,
            admission: error.message.includes('proves that one of its uses rejects NULL') ? 'rejects' : 'unknown',
            diagnostic: error.message,
          })
        }
      }
    }
  } finally {
    await project.close()
  }
  await mkdir(dirname(resolve(outputPath)), { recursive: true })
  await writeFile(resolve(outputPath), `${JSON.stringify(results, null, 2)}\n`)
  const counts = {}
  for (const entry of results) counts[entry.admission] = (counts[entry.admission] ?? 0) + 1
  log(
    JSON.stringify({
      declarations: results.length,
      counts,
    })
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
