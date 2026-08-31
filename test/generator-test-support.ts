import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PostgresTypedSqlConfig } from '../src/config.js'
import { generateTypedSql as generateTypedSqlBase } from '../src/generator.js'

const fixtureRoot = new URL('./fixtures/', import.meta.url)
const testImports = {
  runtime: 'postgres-typed-sql/runtime',
  scalars: 'postgres-typed-sql/scalars',
} as const

export function generateTypedSql(
  config: Omit<PostgresTypedSqlConfig, 'imports'> & { imports?: PostgresTypedSqlConfig['imports'] }
) {
  return generateTypedSqlBase({ ...config, imports: config.imports ?? testImports })
}

type FixtureOptions = Omit<Partial<PostgresTypedSqlConfig>, 'rootDir'>

export function generateFixture(rootDir: string, options: FixtureOptions = {}) {
  return generateTypedSql({
    codecProfile: 'node-postgres',
    include: ['queries'],
    rootDir,
    schema: 'schema.sql',
    ...options,
  })
}

export async function renderQuery(schema: string, sql: string, options: FixtureOptions = {}): Promise<string> {
  const root = await createMinimalFixture(schema, sql)
  await generateFixture(root, options)
  return readFile(join(root, 'queries/query.typed-sql.ts'), 'utf8')
}

export async function copyFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'postgres-typed-sql-'))
  await cp(fixtureRoot, root, { recursive: true })
  return root
}

export async function createMinimalFixture(schema: string, sql: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'postgres-typed-sql-minimal-'))
  await mkdir(join(root, 'queries'))
  await writeFile(join(root, 'schema.sql'), schema)
  await writeFile(join(root, 'queries/query.typed.sql'), sql)
  return root
}
