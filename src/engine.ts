import { readFile } from 'node:fs/promises'

import { PGlite } from './vendor/pglite/index.js'
import { btree_gin } from './vendor/pglite/contrib/btree_gin.js'
import { btree_gist } from './vendor/pglite/contrib/btree_gist.js'
import { pg_trgm } from './vendor/pglite/contrib/pg_trgm.js'
import { pgcrypto } from './vendor/pglite/contrib/pgcrypto.js'
import { uuid_ossp } from './vendor/pglite/contrib/uuid_ossp.js'

import { bindTypedSqlPostgresAnalyzer } from './analyzer-ir.js'
import type { PostgresQueryable } from './database.js'

export const postgresVersion = '18.3' as const

export const supportedExtensions = ['btree_gin', 'btree_gist', 'pg_trgm', 'pgcrypto', 'plpgsql', 'uuid-ossp'] as const

export type SupportedExtension = (typeof supportedExtensions)[number]

export interface CreateAnalysisDatabaseOptions {
  readonly extensions?: readonly SupportedExtension[]
  readonly schemaFiles: readonly string[]
}

export interface AnalysisDatabase extends PostgresQueryable {
  close(): Promise<void>
}

const analyzerExtension = {
  name: 'postgres_typed_sql_analyzer',
  async setup(_pg: unknown, emscriptenOpts: unknown) {
    return {
      emscriptenOpts,
      bundlePath: new URL('./vendor/postgres_typed_sql_analyzer.tar.gz', import.meta.url),
    }
  },
}

const extensionRegistry = {
  analyzer: analyzerExtension,
  btree_gin,
  btree_gist,
  pg_trgm,
  pgcrypto,
  uuid_ossp,
}

function executableSchema(contents: string, path: string): string {
  const unsupportedMetaCommands: string[] = []
  const lines = contents.split(/\r?\n/u).filter((line) => {
    if (/^\\(?:un)?restrict(?:\s|$)/u.test(line)) {
      return false
    }
    if (/^\\/u.test(line)) {
      unsupportedMetaCommands.push(line)
    }
    return true
  })

  if (unsupportedMetaCommands.length > 0) {
    throw new Error(
      `${path}: schema contains unsupported psql command ${JSON.stringify(unsupportedMetaCommands[0])}. ` +
        'Provide plain PostgreSQL SQL, not a psql script.'
    )
  }

  return lines.join('\n')
}

function quotedIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

export async function createAnalysisDatabase(options: CreateAnalysisDatabaseOptions): Promise<AnalysisDatabase> {
  if (options.schemaFiles.length === 0) {
    throw new Error('At least one schema file is required.')
  }

  const pg = new PGlite({ extensions: extensionRegistry })
  try {
    await pg.waitReady

    for (const extension of options.extensions ?? []) {
      if (!supportedExtensions.includes(extension)) {
        throw new Error(`Unsupported PostgreSQL extension: ${extension}`)
      }
      if (extension !== 'plpgsql') {
        await pg.exec(`create extension if not exists ${quotedIdentifier(extension)}`)
      }
    }

    for (const schemaFile of options.schemaFiles) {
      const contents = await readFile(schemaFile, 'utf8')
      await pg.exec(executableSchema(contents, schemaFile))
      await pg.exec('reset all')
    }

    const versionResult = await pg.query<{ server_version_num: number }>(
      "select current_setting('server_version_num')::integer as server_version_num"
    )
    const serverVersion = Number(versionResult.rows[0]?.server_version_num)
    if (serverVersion !== 180003) {
      throw new Error(`Expected embedded PostgreSQL 18.3 (180003), received ${serverVersion}.`)
    }

    await bindTypedSqlPostgresAnalyzer(pg)
    return {
      close: () => pg.close(),
      query: (text, params) => pg.query(text, params),
    }
  } catch (error) {
    await pg.close()
    throw error
  }
}
