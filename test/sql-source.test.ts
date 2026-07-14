import assert from 'node:assert/strict'
import test from 'node:test'

import { compileNamedParameters, parseTypedSqlSource } from '../src/sql-source.js'

test('parses directives only from the leading comment header', () => {
  const parsed = parseTypedSqlSource(
    [
      '-- ordinary header comment\r\n',
      '-- @name findAccount\r\n',
      '-- @access read\r\n',
      '-- @param created_at timestamp with time zone?\r\n',
      '-- @column display_name character varying(100)\r\n',
      '\r\n',
      'select :created_at as display_name\r\n',
      '-- @todo this is SQL body text\r\n',
    ].join(''),
    'queries/find-account.typed.sql'
  )

  assert.deepEqual(parsed.directives, [
    { body: 'findAccount', kind: 'name', line: 2 },
    { body: 'read', kind: 'access', line: 3 },
    { body: 'created_at timestamp with time zone?', kind: 'param', line: 4 },
    { body: 'display_name character varying(100)', kind: 'column', line: 5 },
  ])
  assert.equal(
    parsed.sql,
    '-- ordinary header comment\r\n\r\nselect :created_at as display_name\r\n-- @todo this is SQL body text'
  )
})

test('reports malformed directives in the header but leaves body comments untouched', () => {
  assert.throws(
    () => parseTypedSqlSource('-- @\nselect 1\n', 'queries/malformed.typed.sql'),
    /queries\/malformed\.typed\.sql:1: malformed typed SQL directive/u
  )

  assert.deepEqual(parseTypedSqlSource('select 1\n-- @\n', 'queries/body.typed.sql'), {
    directives: [],
    sql: 'select 1\n-- @',
  })
})

test('compiles named parameters only in PostgreSQL code contexts', () => {
  const cases: readonly {
    readonly input: string
    readonly output: string
    readonly parameterNames: readonly string[]
  }[] = [
    { input: "select ':ignored', :real", output: "select ':ignored', $1", parameterNames: ['real'] },
    { input: "select 'it''s :ignored', :real", output: "select 'it''s :ignored', $1", parameterNames: ['real'] },
    { input: "select E'\\'s :ignored', :real", output: "select E'\\'s :ignored', $1", parameterNames: ['real'] },
    { input: "select e'\\'s :ignored', :real", output: "select e'\\'s :ignored', $1", parameterNames: ['real'] },
    { input: 'select ":ignored", :real', output: 'select ":ignored", $1', parameterNames: ['real'] },
    {
      input: 'select U&\':ignored\', U&":also_ignored", :real',
      output: 'select U&\':ignored\', U&":also_ignored", $1',
      parameterNames: ['real'],
    },
    {
      input: 'select "quoted"" :ignored", :real',
      output: 'select "quoted"" :ignored", $1',
      parameterNames: ['real'],
    },
    {
      input: 'select $$:ignored$$, $body$:also_ignored$body$, :real',
      output: 'select $$:ignored$$, $body$:also_ignored$body$, $1',
      parameterNames: ['real'],
    },
    {
      input: 'select 1$$:ignored$$, 2$body$:also_ignored$body$, :real',
      output: 'select 1$$:ignored$$, 2$body$:also_ignored$body$, $1',
      parameterNames: ['real'],
    },
    {
      input: 'select identifier1$body$:visible$body$',
      output: 'select identifier1$body$$1$body$',
      parameterNames: ['visible'],
    },
    {
      input: 'select 1 -- :ignored\r\n, :real',
      output: 'select 1 -- :ignored\r\n, $1',
      parameterNames: ['real'],
    },
    {
      input: 'select /* outer :ignored /* inner :also_ignored */ done */ :real',
      output: 'select /* outer :ignored /* inner :also_ignored */ done */ $1',
      parameterNames: ['real'],
    },
    {
      input: 'select :real::text, 1::integer, value := 1',
      output: 'select $1::text, 1::integer, value := 1',
      parameterNames: ['real'],
    },
    {
      input: 'select :real, :real, :second',
      output: 'select $1, $1, $2',
      parameterNames: ['real', 'second'],
    },
  ]

  for (const { input, output, parameterNames } of cases) {
    assert.deepEqual(compileNamedParameters(input), {
      parameterNames,
      sql: output,
    })
  }
})

test('does not scan placeholders inside unterminated protected regions', () => {
  assert.deepEqual(compileNamedParameters("select 'unterminated :ignored"), {
    parameterNames: [],
    sql: "select 'unterminated :ignored",
  })
  assert.deepEqual(compileNamedParameters('select /* unterminated :ignored'), {
    parameterNames: [],
    sql: 'select /* unterminated :ignored',
  })
  assert.deepEqual(compileNamedParameters('select $tag$unterminated :ignored'), {
    parameterNames: [],
    sql: 'select $tag$unterminated :ignored',
  })
})

test('rejects positional parameters in code without mistaking protected text or identifiers for them', () => {
  assert.throws(
    () => compileNamedParameters('select $12, :named', 'queries/mixed.typed.sql'),
    /queries\/mixed\.typed\.sql: positional parameter \$12 is not supported; use a named parameter/u
  )
  assert.deepEqual(compileNamedParameters("select '$1', $$ $2 $$, identifier$3, :named"), {
    parameterNames: ['named'],
    sql: "select '$1', $$ $2 $$, identifier$3, $1",
  })
})
