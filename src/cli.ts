#!/usr/bin/env node

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

import type { PostgresTypedSqlConfig } from './config.js'
import { generateTypedSql } from './generator.js'

const usage = `Postgres Typed SQL

Usage:
  postgres-typed-sql generate [options]

Options:
  --config <file>       JavaScript configuration module
  --root <directory>    Project root
  --schema <file>       Schema SQL file; repeat for ordered files
  --include <directory> Directory to scan; repeat as needed
  --extension <name>    Supported PostgreSQL extension; repeat as needed
  --types-output <file> Generated catalog types path
  --help                Show this help
`

async function loadConfig(path: string): Promise<PostgresTypedSqlConfig> {
  const module = (await import(pathToFileURL(path).href)) as {
    readonly default?: unknown
  }
  if (!module.default || typeof module.default !== 'object') {
    throw new Error(`${path}: configuration module must default-export an object.`)
  }
  return module.default as PostgresTypedSqlConfig
}

function defaultConfigPath(root: string): string | undefined {
  for (const filename of ['postgres-typed-sql.config.mjs', 'postgres-typed-sql.config.js']) {
    const candidate = resolve(root, filename)
    if (existsSync(candidate)) {
      return candidate
    }
  }
  return undefined
}

async function main(): Promise<void> {
  const [command = 'generate', ...args] = process.argv.slice(2)
  if (command === '--help' || command === '-h') {
    process.stdout.write(usage)
    return
  }
  if (command !== 'generate') {
    throw new Error(`Unknown command ${JSON.stringify(command)}.\n\n${usage}`)
  }

  const parsed = parseArgs({
    args,
    allowPositionals: false,
    options: {
      config: { type: 'string' },
      extension: { multiple: true, type: 'string' },
      help: { short: 'h', type: 'boolean' },
      include: { multiple: true, type: 'string' },
      root: { type: 'string' },
      schema: { multiple: true, type: 'string' },
      'types-output': { type: 'string' },
    },
    strict: true,
  })

  if (parsed.values.help) {
    process.stdout.write(usage)
    return
  }

  const rootDir = resolve(parsed.values.root ?? process.cwd())
  const configPath = parsed.values.config ? resolve(rootDir, parsed.values.config) : defaultConfigPath(rootDir)
  const fileConfig = configPath ? await loadConfig(configPath) : undefined
  const schema = parsed.values.schema ?? fileConfig?.schema
  if (!schema) {
    throw new Error('No schema was provided. Pass --schema or create postgres-typed-sql.config.mjs.')
  }

  const result = await generateTypedSql({
    ...fileConfig,
    extensions: (parsed.values.extension as PostgresTypedSqlConfig['extensions'] | undefined) ?? fileConfig?.extensions,
    include: parsed.values.include ?? fileConfig?.include,
    rootDir,
    schema,
    typesOutput: parsed.values['types-output'] ?? fileConfig?.typesOutput,
  })

  const removed = result.removedFiles > 0 ? `; removed ${result.removedFiles} stale files` : ''
  process.stdout.write(`Generated ${result.statementCount} typed SQL statements${removed}.\n`)
}

main().catch((error: unknown) => {
  process.stderr.write(`Postgres Typed SQL failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
