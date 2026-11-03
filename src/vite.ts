import { transform } from 'esbuild'
import { SqlBuildProject } from './build-project.js'
import type { QueryProjectOptions } from './query-project.js'

interface HotUpdate<Module> {
  readonly file: string
  readonly server: {
    readonly moduleGraph: {
      getModuleById(id: string): Module | undefined
      invalidateModule(module: Module): void
    }
  }
}

export function postgresTypedSql(options: QueryProjectOptions) {
  let project = new SqlBuildProject(options)
  const modules = new Set<string>()
  return {
    name: 'postgres-typed-sql',
    enforce: 'pre' as const,
    async buildStart() {
      await project.close()
      project = new SqlBuildProject(options)
    },
    async transform(this: { addWatchFile(file: string): void }, source: string, id: string) {
      if (!id.endsWith('.typed.sql')) return undefined
      modules.add(id)
      try {
        const code = await project.compile(id, source)
        return await transform(code, { loader: 'ts', format: 'esm', sourcefile: id, sourcemap: 'external' })
      } finally {
        for (const file of project.watchedFiles) this.addWatchFile(file)
      }
    },
    async handleHotUpdate<Module>(context: HotUpdate<Module>) {
      if (!project.watchedFiles.includes(context.file)) return undefined
      await project.invalidate()
      const affected = [...modules].flatMap((id) => {
        const module = context.server.moduleGraph.getModuleById(id)
        if (!module) return []
        context.server.moduleGraph.invalidateModule(module)
        return [module]
      })
      return affected
    },
    async closeBundle() {
      await project.close()
    },
  }
}
