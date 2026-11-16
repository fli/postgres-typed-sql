import { log } from 'node:console'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL, URL } from 'node:url'
import ts from 'typescript'

const [consumerArg, baselineArg, outputArg, moduleArg, snapshotArg, ...extra] = process.argv.slice(2)
if (!consumerArg || !baselineArg || !outputArg || extra.length) {
  throw new Error(
    'Usage: node scripts/audit-null-admission.mjs <consumer-root> <baseline.json> <output.json> [project-module] [snapshot-root]'
  )
}
const consumer = resolve(consumerArg)
const baselinePath = resolve(baselineArg)
const sourceRoot = snapshotArg ? resolve(snapshotArg) : consumer
const moduleUrl = moduleArg
  ? moduleArg.startsWith('file:')
    ? moduleArg
    : pathToFileURL(resolve(moduleArg)).href
  : new URL('../dist/project.js', import.meta.url).href
const { openQueryProject } = await import(moduleUrl)
const baselineText = await readFile(baselinePath, 'utf8')
const baseline = JSON.parse(baselineText)
if (!Array.isArray(baseline)) throw new Error('Baseline must be an array')
const hash = (text) => createHash('sha256').update(text).digest('hex')
const executable = (text) =>
  ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, removeComments: true },
  }).outputText
const groups = new Map()
for (const entry of baseline) {
  if (
    typeof entry.file !== 'string' ||
    isAbsolute(entry.file) ||
    entry.file.split('/').includes('..') ||
    typeof entry.parameter !== 'string' ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(entry.parameter) ||
    typeof entry.accepted !== 'boolean' ||
    !(typeof entry.diagnostic === 'string' || entry.diagnostic === null)
  ) {
    throw new Error(`Invalid baseline entry: ${JSON.stringify(entry)}`)
  }
  if (!groups.has(entry.file)) groups.set(entry.file, [])
  groups.get(entry.file).push(entry)
}
const config = join(consumer, 'packages/db/postgres-typed-sql.config.mjs')
const project = await openQueryProject(config)
let inputs
const results = []
try {
  inputs = await Promise.all(project.watchedFiles.map(async (path) => ({ path, sha256: hash(await readFile(path)) })))
  for (const [file, entries] of groups) {
    const source = await readFile(join(sourceRoot, file), 'utf8')
    const sourcePath = join(consumer, file)
    const original = await project.compile(sourcePath, source)
    const originalHash = hash(executable(original))
    const analysis = typeof project.analyze === 'function' ? await project.analyze(sourcePath, source) : null
    for (const entry of entries) {
      const escaped = entry.parameter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const declaration = new RegExp(`(^[\\t ]*--[\\t ]*)@bindNull([\\t ]+${escaped})(?=[\\t ]*(?:\\r?$))`, 'gm')
      const matches = [...source.matchAll(declaration)]
      if (matches.length !== 1)
        throw new Error(`${file}: expected one @bindNull ${entry.parameter}, found ${matches.length}`)
      const candidate = source.replace(declaration, '$1@nullable$2')
      let current
      try {
        const compiled = await project.compile(sourcePath, candidate)
        const executableSha256 = hash(executable(compiled))
        current = {
          accepted: true,
          diagnostic: null,
          executableSha256,
          executableMatchesOriginal: executableSha256 === originalHash,
        }
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes(`@nullable ${entry.parameter} cannot be satisfied`))
          throw error
        current = {
          accepted: false,
          diagnostic: error.message,
          executableSha256: null,
          executableMatchesOriginal: null,
        }
      }
      results.push({
        file,
        parameter: entry.parameter,
        sourceSha256: hash(source),
        candidateSha256: hash(candidate),
        baseline: { accepted: entry.accepted, diagnostic: entry.diagnostic },
        original: {
          admission: 'caller',
          executableSha256: originalHash,
          parameterAnalysis: analysis?.parameters?.find((parameter) => parameter.name === entry.parameter) ?? null,
        },
        current,
        gained: !entry.accepted && current.accepted,
      })
    }
  }
} finally {
  await project.close()
}
const output = { baselineSha256: hash(baselineText), configIdentity: project.configIdentity, inputs, results }
await writeFile(resolve(outputArg), `${JSON.stringify(output, null, 2)}\n`)
log(
  JSON.stringify({
    declarations: results.length,
    accepted: results.filter((r) => r.current.accepted).length,
    gained: results.filter((r) => r.gained).length,
    executableMismatches: results.filter((r) => r.current.executableMatchesOriginal === false).length,
  })
)

if (results.some((result) => result.current.executableMatchesOriginal === false)) {
  throw new Error('Executable output changed for an accepted substitution; see inventory.')
}
