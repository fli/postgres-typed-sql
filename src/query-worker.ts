import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { register } from 'node:module'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { MessageChannel, type MessagePort } from 'node:worker_threads'

import { resolveConfig, type PostgresTypedSqlConfig } from './config.js'
import { createAnalysisDatabase, type AnalysisDatabase } from './engine.js'
import { compileTypedSqlSource } from './generator.js'

const watched = new Set<string>()
let dependencyPort: MessagePort | undefined
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
  const port = dependencyPort
  if (!port) return []
  return new Promise((accept) => {
    port.once('message', accept)
    port.postMessage('snapshot')
  })
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
  const { port1, port2 } = new MessageChannel()
  dependencyPort = port1
  register(new URL('./config-loader.js', import.meta.url), {
    parentURL: import.meta.url,
    data: { port: port2 },
    transferList: [port2],
  })
  const module: { default?: PostgresTypedSqlConfig } = await import(pathToFileURL(configPath).href)
  if (!module.default || typeof module.default !== 'object')
    throw new Error('Configuration must default-export an object.')
  const config = resolveConfig({
    ...module.default,
    rootDir: resolve(dirname(configPath), module.default.rootDir ?? '.'),
  })
  const dependencies = await dependencySnapshot()
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
  const producer = await readFile(new URL('../package.json', import.meta.url), 'utf8')
  const hash = createHash('sha256').update(JSON.stringify({ config, inputs, producer }))
  const watchedFiles = [...watched].sort()
  dependencyPort.close()
  dependencyPort = undefined
  process.on('message', (message: { id: number; sourcePath: string; content: string }) => {
    queue = queue.then(async () => {
      try {
        database ??= await createAnalysisDatabase({
          extensions: config.extensions,
          schemaFiles: config.schemaFiles,
          readSchemaFile: async (path) => {
            const content = schemaContents.get(path)
            if (content === undefined) throw new Error(`Missing schema snapshot ${path}.`)
            return content
          },
        })
        const text = await compileTypedSqlSource({ ...message, database, config })
        process.send?.({ id: message.id, text })
      } catch (error) {
        try {
          await database?.close()
        } finally {
          database = undefined
        }
        process.send?.({ id: message.id, error: error instanceof Error ? error.message : String(error) })
      }
    })
  })
  process.send?.({ configIdentity: hash.digest('hex'), watchedFiles, inputs })
}

main().catch(async (error: unknown) => {
  for (const [path] of await dependencySnapshot()) watched.add(path)
  dependencyPort?.close()
  process.send?.({ error: error instanceof Error ? error.message : String(error), watchedFiles: [...watched] })
  process.exitCode = 1
  process.disconnect?.()
})
