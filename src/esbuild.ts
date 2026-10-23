import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { Plugin } from 'esbuild'

import { openQueryProject, QueryProjectError, type QueryProject, type QueryProjectOptions } from './query-project.js'

export function postgresTypedSql(options: QueryProjectOptions): Plugin {
  const configPath = resolve(options.config)
  return {
    name: 'postgres-typed-sql',
    setup(build) {
      let project: QueryProject | undefined
      let initializationError: unknown
      let startup: AbortController | undefined
      build.onStart(async () => {
        startup?.abort()
        await project?.close()
        project = undefined
        initializationError = undefined
        startup = new AbortController()
        try {
          project = await openQueryProject(configPath, {
            signal: startup.signal,
            configDependencies: options.configDependencies,
          })
        } catch (error) {
          initializationError = error
        }
      })
      build.onLoad({ filter: /\.typed\.sql$/, namespace: 'file' }, async (args) => {
        const current = project
        if (!current)
          return {
            errors: [
              {
                text:
                  initializationError instanceof Error
                    ? initializationError.message
                    : 'SQL build project is unavailable.',
              },
            ],
            watchFiles: [
              args.path,
              configPath,
              ...(initializationError instanceof QueryProjectError ? initializationError.watchedFiles : []),
            ],
          }
        const watchFiles = [args.path, ...current.watchedFiles]
        try {
          return {
            contents: await current.compile(args.path, await readFile(args.path, 'utf8')),
            loader: 'ts',
            resolveDir: dirname(args.path),
            watchFiles,
          }
        } catch (error) {
          return { errors: [{ text: error instanceof Error ? error.message : String(error) }], watchFiles }
        }
      })
      build.onDispose(() => {
        startup?.abort()
        void project?.close()
      })
    },
  }
}
