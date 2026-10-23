#!/usr/bin/env node

import { dirname, isAbsolute, resolve } from 'node:path'
import { createHash } from 'node:crypto'

import { openQueryProject, QueryProjectError, type QueryProject } from './query-project.js'

interface ProjectGeneration {
  readonly controller: AbortController
  readonly project: Promise<QueryProject>
}

const projects = new Map<string, ProjectGeneration>()
const retiring = new Set<Promise<void>>()
let shutdownPromise: Promise<void> | undefined
let buffer = Buffer.alloc(0)

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object.')
  return value as Record<string, unknown>
}

function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected a string.')
  return value
}

async function dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
  if (shutdownPromise) throw new Error('SQL content mapper is shutting down.')
  if (method === 'initialize') return { positionEncoding: 'utf-16', diagnosticSource: 'postgres-typed-sql' }
  const handle = string(params.projectHandle)
  if (method === 'closeProject') {
    const previous = projects.get(handle)
    projects.delete(handle)
    await retireProject(previous)
    return null
  }
  if (method === 'openProject') {
    const previous = projects.get(handle)
    projects.delete(handle)
    const previousClosed = retireProject(previous)
    let configPath: string | undefined
    const controller = new AbortController()
    const generation = {
      controller,
      project: (async () => {
        await previousClosed
        const configFileName = string(params.configFileName)
        if (!isAbsolute(configFileName)) throw new Error('The content mapper requires an absolute tsconfig path.')
        const options = params.options === undefined ? {} : object(params.options)
        const config = options.config === undefined ? 'postgres-typed-sql.config.mjs' : string(options.config)
        configPath = resolve(dirname(configFileName), config)
        const configDependencies = options.configDependencies === undefined ? [] : options.configDependencies
        if (
          !Array.isArray(configDependencies) ||
          !configDependencies.every((path: unknown) => typeof path === 'string')
        )
          throw new Error('configDependencies must be an array of file paths.')
        return openQueryProject(configPath, { signal: controller.signal, configDependencies })
      })(),
    }
    projects.set(handle, generation)
    try {
      const project = await generation.project
      if (projects.get(handle) !== generation) {
        await project.close()
        throw new Error('Project configuration changed.')
      }
      return { configIdentity: project.configIdentity, watchedFiles: project.watchedFiles }
    } catch (error) {
      return {
        configIdentity: createHash('sha256').update(String(error)).digest('hex'),
        watchedFiles: error instanceof QueryProjectError ? error.watchedFiles : configPath ? [configPath] : [],
        optionDiagnostics: [
          { path: ['config'], code: 1, messageText: error instanceof Error ? error.message : String(error) },
        ],
      }
    }
  }
  if (method === 'transform') {
    try {
      const sourcePath = string(params.fileName)
      const content = string(params.content)
      const generation = projects.get(handle)
      if (!generation) throw new Error('SQL project configuration is unavailable.')
      const project = await generation.project
      const text = await project.compile(sourcePath, content)
      if (projects.get(handle) !== generation) throw new Error('SQL project configuration changed during analysis.')
      return { text, extension: '.mts' }
    } catch (error) {
      return {
        text: 'export {}',
        extension: '.mts',
        diagnostics: [
          { start: 0, length: 0, code: 1, messageText: error instanceof Error ? error.message : String(error) },
        ],
      }
    }
  }
  throw new Error(`Unsupported mapper method ${method}.`)
}

function respond(request: unknown): void {
  const envelope = object(request)
  const id = envelope.id
  if (typeof id !== 'number' && typeof id !== 'string' && id !== undefined) throw new Error('Invalid JSON-RPC id.')
  const method = string(envelope.method)
  const task = dispatch(method, object(envelope.params ?? {}))
  void task.then(
    (result) => {
      if (id !== undefined) write({ jsonrpc: '2.0', id, result })
    },
    (error: unknown) => {
      if (id !== undefined)
        write({
          jsonrpc: '2.0',
          id,
          error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
        })
    }
  )
}

function write(message: unknown): void {
  const body = JSON.stringify(message)
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
}

process.stdin.on('data', (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk])
  try {
    while (buffer.length > 0) {
      const end = buffer.indexOf('\r\n\r\n')
      if (end === -1) {
        if (buffer.length > 8192) throw new Error('Mapper header exceeds 8192 bytes.')
        return
      }
      if (end > 8192) throw new Error('Mapper header exceeds 8192 bytes.')
      const match = /(?:^|\r\n)Content-Length:\s*(\d+)(?:\r\n|$)/iu.exec(buffer.subarray(0, end).toString('ascii'))
      if (!match?.[1]) throw new Error('Missing Content-Length header.')
      const length = Number(match[1])
      if (!Number.isSafeInteger(length) || length > 64 * 1024 * 1024) throw new Error('Mapper message exceeds 64 MiB.')
      if (buffer.length < end + 4 + length) return
      const request: unknown = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString('utf8'))
      buffer = buffer.subarray(end + 4 + length)
      respond(request)
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.stdin.destroy()
    void closeAll().finally(() => {
      process.exitCode = 1
    })
  }
})

function retireProject(generation: ProjectGeneration | undefined): Promise<void> {
  if (!generation) return Promise.resolve()
  generation.controller.abort()
  const retirement = generation.project.then(
    (project) => project.close(),
    () => undefined
  )
  retiring.add(retirement)
  void retirement.finally(() => retiring.delete(retirement))
  return retirement
}

function closeAll(): Promise<void> {
  if (!shutdownPromise) {
    const previous = [...projects.values()]
    projects.clear()
    for (const generation of previous) void retireProject(generation)
    shutdownPromise = Promise.allSettled([...retiring]).then(() => undefined)
  }
  return shutdownPromise
}

function transportFailed(): void {
  process.stdin.destroy()
  void closeAll().finally(() => process.exit(1))
}

process.stdin.on('error', transportFailed)
process.stdout.on('error', transportFailed)
process.stderr.on('error', transportFailed)

process.stdin.on('end', () => {
  void closeAll()
})
process.on('SIGTERM', () => {
  void closeAll().finally(() => process.exit(0))
})
