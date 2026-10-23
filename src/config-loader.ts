import { createHash } from 'node:crypto'
import type { MessagePort } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import type { LoadHook, ResolveHook, ResolveFnOutput } from 'node:module'

const inputs = new Map<string, string>()

export function initialize({ port }: { port: MessagePort }): void {
  port.on('message', () => port.postMessage([...inputs]))
  port.unref()
}

function recordHash(path: string, hash: string): void {
  const previous = inputs.get(path)
  if (previous && previous !== hash) throw new Error(`SQL configuration dependency changed while evaluating: ${path}`)
  inputs.set(path, hash)
}

export const resolve: ResolveHook = async (specifier, context, nextResolve) => {
  let candidatePath: string | undefined
  if (
    specifier.startsWith('./') ||
    specifier.startsWith('../') ||
    specifier.startsWith('/') ||
    specifier.startsWith('file:')
  ) {
    const candidate = new URL(specifier, context.parentURL)
    if (candidate.protocol === 'file:') {
      candidatePath = fileURLToPath(candidate)
    }
  }
  let result: ResolveFnOutput
  try {
    result = await nextResolve(specifier, context)
  } catch (error) {
    const missing = error && typeof error === 'object' && 'code' in error && error.code === 'ERR_MODULE_NOT_FOUND'
    if (candidatePath) {
      if (missing) recordHash(candidatePath, 'missing')
      else inputs.set(candidatePath, inputs.get(candidatePath) ?? '')
    }
    if (
      error &&
      typeof error === 'object' &&
      'url' in error &&
      typeof error.url === 'string' &&
      error.url.startsWith('file:')
    ) {
      const path = fileURLToPath(error.url)
      if (missing) recordHash(path, 'missing')
      else inputs.set(path, inputs.get(path) ?? '')
    }
    throw error
  }
  if (result.url.startsWith('file:')) {
    const path = fileURLToPath(result.url)
    inputs.set(path, inputs.get(path) ?? '')
  }
  return result
}

export const load: LoadHook = async (url, context, nextLoad) => {
  const result = await nextLoad(url, context)
  if (result.format === 'commonjs') throw new Error('SQL configuration dependencies must use ESM modules.')
  if (url.startsWith('file:') && result.source !== null && result.source !== undefined) {
    const source =
      typeof result.source === 'string'
        ? result.source
        : ArrayBuffer.isView(result.source)
          ? new Uint8Array(result.source.buffer, result.source.byteOffset, result.source.byteLength)
          : new Uint8Array(result.source)
    const path = fileURLToPath(url)
    const hash = createHash('sha256').update(source).digest('hex')
    recordHash(path, hash)
  }
  return result
}
