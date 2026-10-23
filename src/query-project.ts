import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fork, type ChildProcess } from 'node:child_process'
import { dirname, resolve } from 'node:path'

export class QueryProjectError extends Error {
  readonly watchedFiles: string[]
  constructor(message: string, watchedFiles: string[]) {
    super(message)
    this.watchedFiles = watchedFiles
  }
}

export interface QueryProjectOptions {
  readonly config: string
  /** Extra configuration input files, relative to the SQL configuration module's directory. */
  readonly configDependencies?: readonly string[]
}

export interface QueryProject {
  readonly configIdentity: string
  readonly watchedFiles: string[]
  compile(sourcePath: string, content: string): Promise<string>
  close(): Promise<void>
}

export async function openQueryProject(
  configPath: string,
  options: Pick<QueryProjectOptions, 'configDependencies'> & { readonly signal?: AbortSignal } = {}
): Promise<QueryProject> {
  const { signal } = options
  const config = resolve(configPath)
  const dependencies = (options.configDependencies ?? []).map((path) => resolve(dirname(config), path))
  const knownInputs = [config, ...dependencies]
  if (signal?.aborted) throw new QueryProjectError('SQL analysis project opening was canceled.', knownInputs)
  const child = fork(new URL('./query-worker.js', import.meta.url), [config, JSON.stringify(dependencies)], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    execArgv: [],
  })
  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-8192)
  })
  const pending = new Map<number, { resolve(value: string): void; reject(error: Error): void }>()
  let nextId = 0
  let closed = false
  let ready = false
  let closePromise: Promise<void> | undefined
  let openingFailure: Error | undefined
  let cleanupStartup: (() => void) | undefined
  const result = new Promise<QueryProject>((accept, reject) => {
    const fail = (error: Error): void => {
      reject(error)
      for (const request of pending.values()) request.reject(error)
      pending.clear()
    }
    const stopStartup = (error: Error): void => {
      if (ready || closed) return
      openingFailure = error
      closePromise ??= closeWorker(child, () => {
        closed = true
      })
    }
    const cancel = () => stopStartup(new Error('SQL analysis project opening was canceled.'))
    const timeout = setTimeout(
      () => stopStartup(new Error('SQL analysis project opening timed out after 30 seconds.')),
      30000
    )
    signal?.addEventListener('abort', cancel, { once: true })
    cleanupStartup = () => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', cancel)
    }
    child.on('error', fail)
    child.on('exit', (code) => {
      closed = true
      fail(openingFailure ?? new Error(`SQL analysis worker exited (${code}). ${stderr}`))
    })
    child.on('message', (message: unknown) => {
      if (closed) return
      if (!message || typeof message !== 'object') return fail(new Error('Invalid SQL worker response.'))
      if ('id' in message && typeof message.id === 'number') {
        const request = pending.get(message.id)
        if (!request) return
        pending.delete(message.id)
        if ('text' in message && typeof message.text === 'string') request.resolve(message.text)
        else
          request.reject(
            new Error(
              'error' in message && typeof message.error === 'string' ? message.error : 'Invalid SQL worker result.'
            )
          )
      } else if (
        'configIdentity' in message &&
        typeof message.configIdentity === 'string' &&
        'watchedFiles' in message &&
        Array.isArray(message.watchedFiles) &&
        message.watchedFiles.every((path: unknown) => typeof path === 'string')
      ) {
        const inputs = parseInputs('inputs' in message ? message.inputs : undefined)
        if (!inputs) return fail(new Error('Invalid SQL worker inputs.'))
        const verify = async (): Promise<void> => {
          for (const [path, hash] of inputs) {
            let current: string
            try {
              current = createHash('sha256')
                .update(await readFile(path))
                .digest('hex')
            } catch (error) {
              if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error
              current = 'missing'
            }
            if (current !== hash) throw new Error(`SQL configuration input changed. Refresh the project: ${path}`)
          }
        }
        ready = true
        accept({
          configIdentity: message.configIdentity,
          watchedFiles: message.watchedFiles,
          async compile(sourcePath, content) {
            if (closed) return Promise.reject(new Error('SQL analysis project is closed.'))
            await verify()
            if (closed) throw new Error('SQL analysis project is closed.')
            const id = nextId++
            const text = await new Promise<string>((resolve, reject) => {
              pending.set(id, { resolve, reject })
              child.send({ id, sourcePath, content }, (error) => {
                if (error) {
                  pending.delete(id)
                  reject(error)
                }
              })
            })
            await verify()
            if (closed) throw new Error('SQL analysis project is closed.')
            return text
          },
          close() {
            closePromise ??= closeWorker(child, () => {
              closed = true
              fail(new Error('SQL analysis project is closed.'))
            })
            return closePromise
          },
        })
      } else if ('error' in message && typeof message.error === 'string') {
        const paths =
          'watchedFiles' in message && Array.isArray(message.watchedFiles)
            ? message.watchedFiles.filter((path: unknown): path is string => typeof path === 'string')
            : []
        fail(new QueryProjectError(message.error, paths))
      }
    })
  })
  try {
    return await result
  } catch (error) {
    await (closePromise ??= closeWorker(child, () => {
      closed = true
    }))
    throw new QueryProjectError(error instanceof Error ? error.message : String(error), [
      ...new Set([...knownInputs, ...(error instanceof QueryProjectError ? error.watchedFiles : [])]),
    ])
  } finally {
    cleanupStartup?.()
  }
}

function closeWorker(child: ChildProcess, markClosed: () => void): Promise<void> {
  markClosed()
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((accept) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
    child.once('exit', () => {
      clearTimeout(timer)
      accept()
    })
    if (child.connected) child.disconnect()
    else child.kill()
  })
}

function parseInputs(value: unknown): [string, string][] | undefined {
  if (!Array.isArray(value)) return undefined
  const result: [string, string][] = []
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || typeof entry[1] !== 'string')
      return undefined
    result.push([entry[0], entry[1]])
  }
  return result
}
