import { createHash } from 'node:crypto'
import * as nodeModule from 'node:module'
import { fileURLToPath } from 'node:url'

export function trackConfigImports():
  | {
      snapshot(): [string, string][]
      seal(): void
      assertNoLateImports(): void
    }
  | undefined {
  if (typeof nodeModule.registerHooks !== 'function') return undefined
  const inputs = new Map<string, string>()
  const modules = new Set<string>()
  let sealed = false
  let violation: string | undefined
  const record = (path: string, hash: string): void => {
    const previous = inputs.get(path)
    if (previous && previous !== hash) throw new Error(`SQL configuration dependency changed while evaluating: ${path}`)
    inputs.set(path, hash)
  }
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (sealed && context.parentURL && modules.has(context.parentURL)) {
        violation ??= `SQL configuration attempted a late import: ${specifier}`
        throw new Error(violation)
      }
      let candidatePath: string | undefined
      if (
        specifier.startsWith('./') ||
        specifier.startsWith('../') ||
        specifier.startsWith('/') ||
        specifier.startsWith('file:')
      ) {
        const candidate = new URL(specifier, context.parentURL)
        if (candidate.protocol === 'file:') candidatePath = fileURLToPath(candidate)
      }
      try {
        const result = nextResolve(specifier, context)
        if (result.url.startsWith('file:')) {
          modules.add(result.url)
          const path = fileURLToPath(result.url)
          inputs.set(path, inputs.get(path) ?? '')
        }
        return result
      } catch (error) {
        const missing = error && typeof error === 'object' && 'code' in error && error.code === 'ERR_MODULE_NOT_FOUND'
        if (candidatePath) {
          if (missing) record(candidatePath, 'missing')
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
          if (missing) record(path, 'missing')
          else inputs.set(path, inputs.get(path) ?? '')
        }
        throw error
      }
    },
    load(url, context, nextLoad) {
      const result = nextLoad(url, context)
      if (result.format === 'commonjs') throw new Error('SQL configuration dependencies must use ESM modules.')
      if (url.startsWith('file:') && result.source !== null && result.source !== undefined) {
        const source =
          typeof result.source === 'string'
            ? result.source
            : ArrayBuffer.isView(result.source)
              ? new Uint8Array(result.source.buffer, result.source.byteOffset, result.source.byteLength)
              : new Uint8Array(result.source)
        record(fileURLToPath(url), createHash('sha256').update(source).digest('hex'))
      }
      return result
    },
  })
  return {
    snapshot: () => [...inputs],
    seal: () => {
      sealed = true
    },
    assertNoLateImports: () => {
      if (violation) throw new Error(violation)
    },
  }
}
