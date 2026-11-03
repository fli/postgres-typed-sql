/** @typedef {import('./query-project.js').QueryProjectOptions} QueryProjectOptions */
/** @typedef {import('./build-project.js').SqlBuildProject} SqlBuildProject */
/**
 * @typedef {{resourcePath: string, getOptions(): QueryProjectOptions,
 *   addDependency(file: string): void,
 *   async(): (error: Error | null, code?: string) => void}} LoaderContext
 */

/** @type {Map<string, {project: Promise<SqlBuildProject>, users: number, timer?: NodeJS.Timeout}>} */
const projects = new Map()

/** @param {LoaderContext} context @param {string} source */
async function transform(context, source) {
  const options = context.getOptions()
  const key = JSON.stringify(options)
  let entry = projects.get(key)
  if (!entry) {
    entry = {
      project: import('./build-project.js').then(({ SqlBuildProject }) => new SqlBuildProject(options)),
      users: 0,
    }
    projects.set(key, entry)
  }
  clearTimeout(entry.timer)
  entry.users++
  try {
    const project = await entry.project
    try {
      const code = await project.compile(context.resourcePath, source)
      const { transform } = await import('esbuild')
      return (await transform(code, { loader: 'ts', format: 'esm', sourcefile: context.resourcePath })).code
    } finally {
      for (const file of project.watchedFiles) context.addDependency(file)
    }
  } finally {
    if (--entry.users === 0) {
      const idle = entry
      // Loaders have no disposal hook; evict idle workers so the host can exit.
      idle.timer = setTimeout(() => {
        if (projects.get(key) === idle) projects.delete(key)
        void idle.project.then(
          (project) => project.close(),
          () => undefined
        )
      }, 1000)
    }
  }
}

/** @this {LoaderContext} @param {string} source */
module.exports = function postgresTypedSqlLoader(source) {
  const done = this.async()
  void transform(this, source).then(
    (code) => done(null, code),
    (error) => done(error)
  )
}
