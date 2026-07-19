import { cp, mkdir, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const projectRoot = resolve(import.meta.dirname, '..')
const sourceRoot = resolve(process.env.PGLITE_SOURCE_DIR ?? resolve(projectRoot, 'source/pglite'))
const pgliteDist = resolve(sourceRoot, 'packages/pglite/dist')
const analyzerArchive = resolve(sourceRoot, 'postgres-pglite/dist/extensions/other/postgres_typed_sql_analyzer.tar.gz')
const vendorRoot = resolve(projectRoot, 'dist/vendor')

execFileSync('sh', [resolve(projectRoot, 'scripts/prepare-engine.sh'), '--verify-built'], {
  cwd: projectRoot,
  env: process.env,
  stdio: 'inherit',
})

await rm(vendorRoot, { force: true, recursive: true })
await mkdir(resolve(vendorRoot, 'licenses'), { recursive: true })
await cp(pgliteDist, resolve(vendorRoot, 'pglite'), { recursive: true })
await cp(analyzerArchive, resolve(vendorRoot, 'postgres_typed_sql_analyzer.tar.gz'))
await cp(resolve(sourceRoot, 'LICENSE'), resolve(vendorRoot, 'licenses/PGLITE-LICENSE'))
await cp(resolve(sourceRoot, 'postgres-pglite/COPYRIGHT'), resolve(vendorRoot, 'licenses/POSTGRESQL-COPYRIGHT'))
