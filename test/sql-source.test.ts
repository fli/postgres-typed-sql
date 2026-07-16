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
      input: 'select payload -> :json_key, payload #>> :json_path, :fallback',
      output: 'select payload -> $1, payload #>> $2, $3',
      parameterNames: ['json_key', 'json_path', 'fallback'],
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

test('preserves PostgreSQL array slice delimiters in expression subscripts', () => {
  const cases: readonly string[] = [
    'select values[1:upper_bound] from bounds',
    'select values[1:array_length(values, 1)] from bounds',
    'select values[:upper_bound] from bounds',
    'select values[lower_bound:] from bounds',
    'select values[:] from bounds',
    'select values[1:first_upper][2:second_upper] from bounds',
    'select values[indexes[1:nested_upper]:outer_upper] from bounds',
    'select schema_name.array_column[1:upper_bound] from bounds',
  ]

  for (const sql of cases) {
    assert.deepEqual(compileNamedParameters(sql), {
      parameterNames: [],
      sql,
    })
  }
})

test('compiles named parameters in ARRAY constructors and unambiguous subscript bounds', () => {
  assert.deepEqual(
    compileNamedParameters(
      `select
        ARRAY[:constructor_value],
        ARRAY /* constructor comment */ [:commented_constructor_value],
        values[(:index)],
        values[(:lower):(:upper)],
        values[1 : :explicit_upper],
        values[1::integer + (:offset)],
        nested[ARRAY[:nested_constructor_value][(:nested_index)]]`
    ),
    {
      parameterNames: [
        'constructor_value',
        'commented_constructor_value',
        'index',
        'lower',
        'upper',
        'explicit_upper',
        'offset',
        'nested_constructor_value',
        'nested_index',
      ],
      sql: `select
        ARRAY[$1],
        ARRAY /* constructor comment */ [$2],
        values[($3)],
        values[($4):($5)],
        values[1 : $6],
        values[1::integer + ($7)],
        nested[ARRAY[$8][($9)]]`,
    }
  )
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
