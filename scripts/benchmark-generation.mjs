import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { log } from 'node:console'
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { cpus, loadavg } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

const [sourceArg, baselineArg, candidateArg, workArg, pairsArg = '5'] = process.argv.slice(2)
assert.ok(
  sourceArg && baselineArg && candidateArg && workArg,
  'Usage: node scripts/benchmark-generation.mjs SOURCE_CHECKOUT BASELINE_PACKAGE CANDIDATE_PACKAGE WORK_DIRECTORY [PAIRS]'
)
const source = await realpath(sourceArg)
const baseline = await realpath(baselineArg)
const candidate = await realpath(candidateArg)
const work = resolve(workArg)
const pairs = Number(pairsArg)
assert.ok(Number.isSafeInteger(pairs) && pairs >= 1)
assert.ok(work !== source && !source.startsWith(`${work}/`))
const fixture = join(work, 'fixture')
const configurationFiles = [
  'packages/db/postgres-typed-sql.config.mjs',
  'packages/db/package.json',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'packages/db/scripts/generate-typed-sql.mjs',
]
const ignored = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  'out',
  'reports',
  'test-results',
  'playwright-report',
])
async function files(root) {
  const found = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || ignored.has(entry.name)) continue
    const path = join(root, entry.name)
    if (entry.isDirectory()) found.push(...(await files(path)))
    else if (entry.isFile()) found.push(path)
  }
  return found.sort()
}
const sqlFiles = (await Promise.all(['apps', 'packages'].map((path) => files(join(source, path)))))
  .flat()
  .filter((path) => path.endsWith('.typed.sql'))
  .map((path) => relative(source, path))
  .sort()
assert.ok(sqlFiles.length > 1000, `Expected large consumer corpus, got ${sqlFiles.length}`)
const inputFiles = [...configurationFiles, 'packages/db/schema.sql', ...sqlFiles]
await mkdir(work, { recursive: true })
await rm(fixture, { recursive: true, force: true })
const inputHashes = []
for (const path of inputFiles) {
  const destination = join(fixture, path)
  await mkdir(dirname(destination), { recursive: true })
  const bytes = await readFile(join(source, path))
  await writeFile(destination, bytes)
  inputHashes.push([path, createHash('sha256').update(bytes).digest('hex')])
}
await mkdir(join(fixture, 'node_modules'), { recursive: true })
async function buildDigest(producer) {
  const entries = []
  for (const path of await files(join(producer, 'dist'))) {
    entries.push([
      relative(producer, path),
      createHash('sha256')
        .update(await readFile(path))
        .digest('hex'),
    ])
  }
  entries.push([
    'package.json',
    createHash('sha256')
      .update(await readFile(join(producer, 'package.json')))
      .digest('hex'),
  ])
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex')
}
const metadata = {
  node: process.version,
  cpus: cpus().length,
  source,
  baseline,
  candidate,
  baselineBuild: await buildDigest(baseline),
  candidateBuild: await buildDigest(candidate),
  fixture,
  pairs,
  statements: sqlFiles.length,
  inputHashes,
  loadStart: loadavg(),
  results: [],
}
await writeFile(join(work, 'inputs.json'), JSON.stringify(metadata, null, 2))
let expected
for (let pair = 0; pair < pairs; pair += 1) {
  const sides = [
    ['baseline', baseline],
    ['candidate', candidate],
  ]
  if (pair % 2 === 1) sides.reverse()
  for (const [side, producer] of sides) {
    const link = join(fixture, 'node_modules/postgres-typed-sql')
    await rm(link, { force: true })
    await symlink(producer, link, 'dir')
    for (const path of await files(fixture)) {
      if (
        path.endsWith('.typed-sql.ts') ||
        path.endsWith('.typed.sql.ts') ||
        path === join(fixture, 'packages/db/src/generated/catalog-types.ts') ||
        path === join(fixture, 'packages/db/generated-statement-facts.json')
      )
        await rm(path)
    }
    const start = performance.now()
    const wrapperArgs = [join(fixture, configurationFiles.at(-1)), '--root', fixture]
    const child = spawnSync(
      process.platform === 'darwin' ? '/usr/bin/time' : process.execPath,
      process.platform === 'darwin' ? ['-l', process.execPath, ...wrapperArgs] : wrapperArgs,
      {
        cwd: fixture,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        timeout: 600_000,
      }
    )
    const wallMs = performance.now() - start
    const runLabel = `${side}-${pair + 1}`
    await writeFile(join(work, `${runLabel}.stdout`), child.stdout ?? '')
    await writeFile(join(work, `${runLabel}.stderr`), child.stderr ?? '')
    const result = {
      side,
      pair: pair + 1,
      wallMs,
      exitCode: child.status,
      signal: child.signal,
      error: child.error?.message,
      load: loadavg(),
    }
    if (process.platform === 'darwin') {
      const cpu = child.stderr?.match(/([\d.]+) real\s+([\d.]+) user\s+([\d.]+) sys/u)
      const memory = child.stderr?.match(/(\d+)\s+maximum resident set size/u)
      assert.ok(cpu && memory, 'Missing process resource measurements')
      result.userCpuMs = Number(cpu[2]) * 1000
      result.systemCpuMs = Number(cpu[3]) * 1000
      result.maxRssBytes = Number(memory[1])
    }
    metadata.results.push(result)
    await writeFile(join(work, 'results.json'), JSON.stringify(metadata, null, 2))
    assert.equal(child.status, 0, `${runLabel}: ${child.stderr}`)
    assert.match(
      child.stdout,
      new RegExp(`Generated ${sqlFiles.length} typed SQL statements and public analysis v2\\.`)
    )
    const manifestBytes = await readFile(join(fixture, 'packages/db/generated-statement-facts.json'))
    const manifest = JSON.parse(manifestBytes)
    assert.equal(manifest.analysis.statements.length, sqlFiles.length)
    assert.equal(manifest.analysis.inputs.filter((input) => input.role === 'sql').length, sqlFiles.length)
    const outputHashes = []
    for (const path of [
      ...manifest.analysis.statements.map((statement) => statement.module),
      join(fixture, 'packages/db/src/generated/catalog-types.ts'),
    ].sort()) {
      const bytes = await readFile(path)
      outputHashes.push([relative(fixture, path), createHash('sha256').update(bytes).digest('hex')])
    }
    result.outputDigest = createHash('sha256').update(JSON.stringify(outputHashes)).digest('hex')
    result.manifestDigest = createHash('sha256').update(manifestBytes).digest('hex')
    result.outputs = outputHashes.length
    if (!expected) {
      expected = { outputHashes, manifest }
      await writeFile(join(work, 'reference-output-hashes.json'), JSON.stringify(outputHashes, null, 2))
      await cp(join(fixture, 'packages/db/generated-statement-facts.json'), join(work, 'reference-manifest.json'))
    } else {
      assert.deepEqual(manifest, expected.manifest, `${runLabel}: full public analysis/provenance differs`)
      assert.deepEqual(outputHashes, expected.outputHashes, `${runLabel}: generated bytes differ`)
    }
    for (const [path, hash] of inputHashes) {
      assert.equal(
        createHash('sha256')
          .update(await readFile(join(fixture, path)))
          .digest('hex'),
        hash,
        `${runLabel}: input changed: ${path}`
      )
    }
    result.verified = true
    await writeFile(join(work, 'results.json'), JSON.stringify(metadata, null, 2))
    log(JSON.stringify(result))
  }
}
const median = (values) => {
  const sorted = values.toSorted((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
assert.equal(await buildDigest(baseline), metadata.baselineBuild, 'Baseline build changed during measurement')
assert.equal(await buildDigest(candidate), metadata.candidateBuild, 'Candidate build changed during measurement')
const summary = Object.fromEntries(
  ['baseline', 'candidate'].map((side) => {
    const runs = metadata.results.filter((result) => result.side === side)
    const times = runs.map((run) => run.wallMs)
    return [
      side,
      {
        runs: runs.length,
        errors: runs.filter((run) => run.exitCode !== 0 || !run.verified).length,
        medianMs: median(times),
        minMs: Math.min(...times),
        maxMs: Math.max(...times),
      },
    ]
  })
)
summary.reductionPercent = 100 * (1 - summary.candidate.medianMs / summary.baseline.medianMs)
await writeFile(join(work, 'summary.json'), JSON.stringify(summary, null, 2))
log(JSON.stringify(summary, null, 2))
