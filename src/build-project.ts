import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { openQueryProject, QueryProjectError, type QueryProject, type QueryProjectOptions } from './query-project.js'

async function fingerprint(files: readonly string[]): Promise<string> {
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(file).update('\0')
    try {
      hash.update('present\0').update(await readFile(file))
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error
      hash.update('missing')
    }
    hash.update('\0')
  }
  return hash.digest('hex')
}

export class SqlBuildProject {
  readonly #options: QueryProjectOptions
  #active: { project: QueryProject; fingerprint: string } | undefined
  #queue: Promise<void> = Promise.resolve()
  #watchedFiles: readonly string[]
  #closed = false

  constructor(options: QueryProjectOptions) {
    const config = resolve(options.config)
    this.#options = { ...options, config }
    this.#watchedFiles = [config, ...(options.configDependencies ?? []).map((file) => resolve(dirname(config), file))]
  }

  get watchedFiles(): readonly string[] {
    return this.#watchedFiles
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation)
    this.#queue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  async #discard(): Promise<void> {
    const active = this.#active
    this.#active = undefined
    await active?.project.close()
  }

  async compile(sourcePath: string, content: string): Promise<string> {
    return this.#enqueue(async () => {
      if (this.#closed) throw new Error('SQL build project is closed.')
      try {
        if (this.#active && this.#active.fingerprint !== (await fingerprint(this.#active.project.watchedFiles)))
          await this.#discard()
        if (!this.#active) {
          const project = await openQueryProject(this.#options.config, this.#options)
          this.#watchedFiles = project.watchedFiles
          try {
            this.#active = { project, fingerprint: await fingerprint(project.watchedFiles) }
          } catch (error) {
            await project.close()
            throw error
          }
        }
        return await this.#active.project.compile(sourcePath, content)
      } catch (error) {
        if (error instanceof QueryProjectError) this.#watchedFiles = error.watchedFiles
        await this.#discard()
        throw error
      }
    })
  }

  invalidate(): Promise<void> {
    return this.#enqueue(() => this.#discard())
  }

  close(): Promise<void> {
    this.#closed = true
    return this.invalidate()
  }
}
