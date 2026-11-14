import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { register } from 'node:module'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { MessageChannel, type MessagePort } from 'node:worker_threads'

import { resolveConfig, type PostgresTypedSqlConfig } from './config.js'
import { trackConfigImports } from './config-loader-sync.js'
import { createAnalysisDatabase, type AnalysisDatabase } from './engine.js'
import { analyzeTypedSqlSource, findTypedSqlFiles } from './generator.js'
import { buildCatalogTypes } from './catalog-generator.js'
import { enableAnalysisCatalogReuse } from './analyzer-ir.js'
import { projectAnalysisVersion } from './project-facts.js'

const watched = new Set<string>()
let dependencyPort: MessagePort | undefined
let syncHooks: ReturnType<typeof trackConfigImports>
let database: AnalysisDatabase | undefined
let queue = Promise.resolve()

process.on('disconnect', () => {
  const timer = setTimeout(() => process.exit(1), 5000)
  void queue.finally(async () => {
    try {
      await database?.close()
    } finally {
      clearTimeout(timer)
      process.exit(0)
    }
  })
})
if (!process.connected) process.exit(0)

async function dependencySnapshot(): Promise<[string, string][]> {
  if (syncHooks) return syncHooks.snapshot()
  const port = dependencyPort
  if (!port) return []
  return new Promise((accept) => {
    port.once('message', accept)
    port.postMessage('snapshot')
  })
}

async function engineInputFiles(directory: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await engineInputFiles(path)))
    else if (entry.isFile()) files.push(path)
    else throw new Error(`Analysis engine input must be a regular file: ${path}`)
  }
  return files.toSorted()
}

async function main(): Promise<void> {
  const configPath = process.argv[2]
  if (!configPath) throw new Error('A configuration path is required.')
  watched.add(configPath)
  const declared: unknown = JSON.parse(process.argv[3] ?? '[]')
  if (!Array.isArray(declared) || !declared.every((path: unknown) => typeof path === 'string'))
    throw new Error('Invalid configuration dependency paths.')
  const declaredPaths: string[] = declared
  for (const path of declaredPaths) watched.add(path)
  const declaredInputs: [string, string][] = await Promise.all(
    declaredPaths.map(async (path) => [
      path,
      createHash('sha256')
        .update(await readFile(path))
        .digest('hex'),
    ])
  )
  syncHooks = trackConfigImports()
  if (!syncHooks) {
    const { port1, port2 } = new MessageChannel()
    dependencyPort = port1
    register(new URL('./config-loader.js', import.meta.url), {
      parentURL: import.meta.url,
      data: { port: port2 },
      transferList: [port2],
    })
  }
  const module: { default?: PostgresTypedSqlConfig } = await import(pathToFileURL(configPath).href)
  if (!module.default || typeof module.default !== 'object')
    throw new Error('Configuration must default-export an object.')
  const config = resolveConfig({
    ...module.default,
    rootDir: resolve(dirname(configPath), module.default.rootDir ?? '.'),
  })
  const dependencies = await dependencySnapshot()
  syncHooks?.seal()
  for (const [path] of dependencies) watched.add(path)
  for (const path of config.schemaFiles) watched.add(path)
  const schemas = await Promise.all(
    config.schemaFiles.map(async (path) => [path, await readFile(path, 'utf8')] as const)
  )
  const schemaContents = new Map(schemas)
  const toolDirectory = fileURLToPath(new URL('./', import.meta.url))
  const inputs: [string, string][] = [...declaredInputs]
  for (const [path, hash] of dependencies) {
    if (hash) {
      inputs.push([path, hash])
      continue
    }
    const toolRelativePath = relative(toolDirectory, path)
    if (!isAbsolute(toolRelativePath) && toolRelativePath !== '..' && !toolRelativePath.startsWith(`..${sep}`)) continue
    throw new Error(`SQL configuration source was not observed. Restart without preloading this module: ${path}`)
  }
  for (const [path, content] of schemas) inputs.push([path, createHash('sha256').update(content).digest('hex')])
  inputs.sort(([left], [right]) => left.localeCompare(right))
  const enginePaths = await engineInputFiles(fileURLToPath(new URL('./vendor/', import.meta.url)))
  for (const path of enginePaths) {
    inputs.push([
      path,
      createHash('sha256')
        .update(await readFile(path))
        .digest('hex'),
    ])
  }
  const producer = await readFile(new URL('../package.json', import.meta.url), 'utf8')
  const packageInfo: { version: string } = JSON.parse(producer)
  const hash = createHash('sha256').update(JSON.stringify({ config, inputs, producer }))
  const watchedFiles = [...watched].sort()
  dependencyPort?.close()
  dependencyPort = undefined
  process.on(
    'message',
    (message: {
      id: number
      operation: 'compile' | 'analyze' | 'project' | 'inventory' | 'catalog'
      sourcePath: string
      content: string
    }) => {
      queue = queue.then(async () => {
        try {
          syncHooks?.assertNoLateImports()
          if (!syncHooks && message.operation !== 'compile')
            throw new Error('Project analysis requires Node.js 22.15 or newer to track configuration imports safely.')
          const inventory = async () => (await findTypedSqlFiles(config, ['.typed.sql'])).toSorted()
          let result: unknown
          if (message.operation === 'inventory') {
            result = await inventory()
          } else {
            if (!database) {
              database = await createAnalysisDatabase({
                extensions: config.extensions,
                schemaFiles: config.schemaFiles,
                readSchemaFile: async (path) => {
                  const content = schemaContents.get(path)
                  if (content === undefined) throw new Error(`Missing schema snapshot ${path}.`)
                  return content
                },
              })
              if (config.assumeStableAnalysisCatalog) enableAnalysisCatalogReuse(database)
            }
            if (message.operation === 'catalog') {
              result = await buildCatalogTypes(database, config)
            } else if (message.operation === 'project') {
              const paths = await inventory()
              const statements = []
              for (const sourcePath of paths) {
                const content = await readFile(sourcePath, 'utf8')
                statements.push(await analyzeTypedSqlSource({ sourcePath, content, database, config }))
              }
              if (JSON.stringify(paths) !== JSON.stringify(await inventory()))
                throw new Error('SQL inventory changed during analysis.')
              for (const statement of statements) {
                const content = await readFile(statement.source)
                if (createHash('sha256').update(content).digest('hex') !== statement.sourceSha256)
                  throw new Error(`SQL input changed during analysis: ${statement.source}`)
              }
              result = {
                version: projectAnalysisVersion,
                producer: { name: 'postgres-typed-sql', version: packageInfo.version },
                postgresVersionNum: database.postgresVersionNum,
                rootDir: config.rootDir,
                include: config.include,
                extensions: config.extensions,
                statements,
              }
            } else {
              result = await analyzeTypedSqlSource({ ...message, database, config })
            }
          }
          syncHooks?.assertNoLateImports()
          process.send?.({
            id: message.id,
            result: message.operation === 'compile' ? (result as { moduleText: string }).moduleText : result,
          })
        } catch (error) {
          try {
            await database?.close()
          } finally {
            database = undefined
          }
          process.send?.({ id: message.id, error: error instanceof Error ? error.message : String(error) })
        }
      })
    }
  )
  process.send?.({
    configIdentity: hash.digest('hex'),
    watchedFiles,
    rootDir: config.rootDir,
    include: config.include,
    inputs,
    schemaFiles: config.schemaFiles,
    enginePaths,
  })
}

main().catch(async (error: unknown) => {
  for (const [path] of await dependencySnapshot()) watched.add(path)
  dependencyPort?.close()
  process.send?.({ error: error instanceof Error ? error.message : String(error), watchedFiles: [...watched] })
  process.exitCode = 1
  process.disconnect?.()
})
