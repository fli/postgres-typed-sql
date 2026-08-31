import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  buildTypedSqlPostgresIrFromCompiledConfigs,
  type TypedSqlPostgresIrCompiledConfig,
} from '../src/analyzer-ir.js'
import { createAnalysisDatabase } from '../src/engine.js'

const schemaFile = resolve(import.meta.dirname, 'fixtures/schema.sql')
const config = (
  name: string,
  sql: string,
  parameterNames: readonly string[] = []
): TypedSqlPostgresIrCompiledConfig => ({
  name,
  parameterNames,
  sourceFile: `queries/${name}.typed.sql`,
  sql,
})

test('keeps JSON null values separate from missing SQL values through projection and COALESCE', async () => {
  const database = await createAnalysisDatabase({ schemaFiles: [schemaFile] })
  try {
    const sql = `select
      'null'::jsonb as json_null,
      null::jsonb as sql_null,
      jsonb_build_object('value', null::text) -> 'value' as embedded_null,
      jsonb_build_object('value', null::text) ->> 'value' as text_null,
      jsonb_build_object('value', 'present') -> 'absent' as absent,
      coalesce(jsonb_build_object('value', null::text) -> 'value', '"fallback"'::jsonb) as retained,
      coalesce(jsonb_build_object('value', null::text) ->> 'value', 'fallback') as replaced_text,
      coalesce(jsonb_build_object('value', 'present') -> 'absent', '"fallback"'::jsonb) as replaced_json,
      coalesce(null::jsonb, 'null'::jsonb, '{"unreachable":true}'::jsonb) as retained_literal`
    const result = await buildTypedSqlPostgresIrFromCompiledConfigs(database, [
      config('nulls', sql),
      config('nullableField', `select jsonb_build_object('value', $1::text) -> 'value' as payload`, ['value']),
      config(
        'nullableContainer',
        `select coalesce((select 'null'::jsonb where $1), '{"fallback":true}'::jsonb) as payload`,
        ['include']
      ),
    ])
    const columns = result.queries[0]?.resultColumns
    const column = (name: string) => columns?.find((candidate) => candidate.name === name)
    for (const name of ['json_null', 'embedded_null', 'retained', 'retained_literal']) {
      assert.equal(column(name)?.jsonShape?.kind, 'null', name)
      assert.equal(column(name)?.nullability.kind, 'nonNull', name)
    }
    for (const name of ['sql_null', 'absent']) {
      assert.equal(column(name)?.jsonShape?.kind, 'sqlNull', name)
      assert.equal(column(name)?.nullability.kind, 'nullable', name)
    }
    assert.equal(column('text_null')?.nullability.kind, 'nullable')
    assert.equal(column('replaced_json')?.jsonShape?.kind, 'jsonScalar')
    assert.deepEqual(column('replaced_text')?.checkConstraintType, { kind: 'literalUnion', labels: ['fallback'] })
    const nullableField = result.queries[1]?.resultColumns[0]?.jsonShape
    assert.equal(nullableField?.kind, 'union')
    if (nullableField?.kind === 'union')
      assert.deepEqual(
        nullableField.alternatives.map((value) => value.kind),
        ['scalar', 'null']
      )
    assert.equal(nullableField?.nullability.kind, 'nonNull')
    const nullableContainer = result.queries[2]?.resultColumns[0]?.jsonShape
    assert.equal(nullableContainer?.kind, 'union')
    if (nullableContainer?.kind === 'union')
      assert.deepEqual(
        nullableContainer.alternatives.map((value) => value.kind),
        ['null', 'object']
      )
    assert.equal(nullableContainer?.nullability.kind, 'nonNull')
    assert.deepEqual((await database.query(sql)).rows, [
      {
        json_null: null,
        sql_null: null,
        embedded_null: null,
        text_null: null,
        absent: null,
        retained: null,
        replaced_text: 'fallback',
        replaced_json: 'fallback',
        retained_literal: null,
      },
    ])
  } finally {
    await database.close()
  }
})

test('infers bounded JSON literals, constant paths, positions, and deletion with PostgreSQL semantics', async () => {
  const database = await createAnalysisDatabase({ schemaFiles: [schemaFile] })
  try {
    const sql = `select
      '{"state":"old","state":"ready","count":42,"flag":true,"items":[null,{"display_name":"Reader"}]}'::jsonb as literal,
      '{"state":"old","state":"ready"}'::json -> 'state' as duplicate,
      '{"items":[null,{"display_name":"Reader"}]}'::jsonb #> array['items','-1','display_name'] as path,
      '{"items":[null,{"display_name":"Reader"}]}'::jsonb #> '{items,-1,display_name}'::text[] as literal_path,
      '{"items":[null,{"display_name":"Reader"}]}'::json #>> array['items','-1','display_name'] as path_text,
      jsonb_build_array('first', 'second') -> -1 as last,
      jsonb_build_array('first', 'second') -> 9 as missing,
      jsonb_build_array(null::text) -> 0 as null_element,
      jsonb_build_array('first') -> '0' as object_key_on_array,
      '{"value":null}'::jsonb #>> array['value'] as null_text_path,
      '{"value":null}'::jsonb #> '{value,NULL}'::text[] as null_path_component,
      '{"state":"ready","secret":42}'::jsonb - 'secret' as deleted,
      '{"state":"ready","secret":42,"id":1}'::jsonb - array['secret','id'] as deleted_many,
      '{"state":"ready","secret":42,"id":1}'::jsonb - '{secret,id}'::text[] as deleted_literal,
      '["first","second"]'::jsonb - -1 as deleted_index,
      '["first"]'::jsonb #> array[E'\\u00a00'] as invalid_index,
      '["first"]'::jsonb #> array[E'0\\n'] as trailing_space,
      '42'::jsonb -> 0 as jsonb_scalar,
      '42'::json -> 0 as json_scalar,
      '42'::jsonb #> array['0'] as scalar_path,
      coalesce('null'::jsonb -> -1, '"fallback"'::jsonb) as scalar_null,
      'null'::jsonb #> array[]::text[] as empty_path`
    const result = await buildTypedSqlPostgresIrFromCompiledConfigs(database, [
      config('paths', sql),
      config(
        'unionPositions',
        `select (case when $1 then jsonb_build_array('first', 'second') else jsonb_build_array('third') end) -> 1 as payload`,
        ['condition']
      ),
      config(
        'emptyFallback',
        `select coalesce((select jsonb_build_array('first') where $1), '[]'::jsonb) -> 0 as payload`,
        ['condition']
      ),
      config('deepLiteral', `select '${'['.repeat(70)}0${']'.repeat(70)}'::jsonb as payload`),
      config('nonfiniteLiteral', `select '1e1000'::jsonb as payload`),
      config('opaqueArray', `select $1::jsonb -> 0 as payload`, ['payload']),
      config('dynamicPath', `select '{"value":1}'::jsonb #> $1::text[] as payload`, ['path']),
      config('multidimensionalPath', `select '{"a":{"b":{"c":{"d":1}}}}'::jsonb #> '{{a,b},{c,d}}'::text[] as payload`),
      config(
        'oversizedPath',
        `select '{}'::jsonb #> '{${Array.from({ length: 257 }, () => 'a').join(',')}}'::text[] as payload`
      ),
    ])
    const columns = result.queries[0]?.resultColumns
    const column = (name: string) => columns?.find((candidate) => candidate.name === name)
    assert.equal(column('literal')?.jsonShape?.kind, 'object')
    for (const name of ['duplicate', 'path', 'literal_path', 'jsonb_scalar']) {
      const shape = column(name)?.jsonShape
      assert.equal(shape?.kind, 'jsonScalar', name)
      assert.equal(
        shape?.kind === 'jsonScalar' ? shape.value : undefined,
        name === 'path' || name === 'literal_path' ? 'Reader' : name === 'jsonb_scalar' ? 42 : 'ready'
      )
    }
    assert.deepEqual(column('path_text')?.checkConstraintType, { kind: 'literalUnion', labels: ['Reader'] })
    assert.equal(column('last')?.jsonShape?.kind, 'stringLiteral')
    for (const name of [
      'missing',
      'object_key_on_array',
      'invalid_index',
      'trailing_space',
      'json_scalar',
      'scalar_path',
      'null_path_component',
    ]) {
      assert.equal(column(name)?.jsonShape?.kind, 'sqlNull', name)
      assert.equal(column(name)?.nullability.kind, 'nullable', name)
    }
    for (const name of ['null_element', 'empty_path', 'scalar_null'])
      assert.equal(column(name)?.jsonShape?.kind, 'null', name)
    for (const name of ['deleted', 'deleted_many', 'deleted_literal']) {
      const shape = column(name)?.jsonShape
      assert.equal(shape?.kind, 'object', name)
      if (shape?.kind === 'object')
        assert.deepEqual(
          shape.fields.map((field) => field.name),
          ['state']
        )
    }
    const deletedIndex = column('deleted_index')?.jsonShape
    assert.equal(deletedIndex?.kind, 'array')
    if (deletedIndex?.kind === 'array') assert.equal(deletedIndex.elements?.length, 1)
    for (const query of result.queries.slice(1, 3)) {
      const shape = query.resultColumns[0]?.jsonShape
      assert.equal(shape?.kind, 'stringLiteral', query.name)
      assert.equal(shape?.nullability.kind, 'nullable', query.name)
    }
    for (const query of result.queries.slice(3))
      assert.equal(query.resultColumns[0]?.jsonShape?.kind, 'opaque', query.name)
    assert.deepEqual((await database.query(sql)).rows, [
      {
        literal: { state: 'ready', count: 42, flag: true, items: [null, { display_name: 'Reader' }] },
        duplicate: 'ready',
        path: 'Reader',
        literal_path: 'Reader',
        path_text: 'Reader',
        last: 'second',
        missing: null,
        null_element: null,
        object_key_on_array: null,
        null_text_path: null,
        null_path_component: null,
        deleted: { state: 'ready' },
        deleted_many: { state: 'ready' },
        deleted_literal: { state: 'ready' },
        deleted_index: ['first'],
        invalid_index: null,
        trailing_space: null,
        empty_path: null,
        jsonb_scalar: 42,
        json_scalar: null,
        scalar_path: null,
        scalar_null: null,
      },
    ])
  } finally {
    await database.close()
  }
})

test('keeps user-defined path, index, and deletion operators opaque', async () => {
  const database = await createAnalysisDatabase({ schemaFiles: [schemaFile] })
  try {
    for (const statement of [
      `create function public.jsonb_array_element(jsonb, integer) returns jsonb
        language sql immutable as $$ select '{"shadow":"index"}'::jsonb $$`,
      `create function public.jsonb_extract_path(jsonb, text[]) returns jsonb
        language sql immutable as $$ select '{"shadow":"path"}'::jsonb $$`,
      `create function public.jsonb_delete(jsonb, text) returns jsonb
        language sql immutable as $$ select '{"shadow":"delete"}'::jsonb $$`,
      'create operator public.-> (leftarg=jsonb, rightarg=integer, function=public.jsonb_array_element)',
      'create operator public.#> (leftarg=jsonb, rightarg=text[], function=public.jsonb_extract_path)',
      'create operator public.- (leftarg=jsonb, rightarg=text, function=public.jsonb_delete)',
    ]) {
      await database.query(statement)
    }
    const sql = `select
      '[1]'::jsonb operator(public.->) 0 as indexed,
      '{"state":"ready"}'::jsonb operator(public.#>) array['state'] as path,
      '{"state":"ready"}'::jsonb operator(public.-) 'state' as deleted`
    const result = await buildTypedSqlPostgresIrFromCompiledConfigs(database, [config('shadowed', sql)])
    for (const column of result.queries[0]?.resultColumns ?? [])
      assert.equal(column.jsonShape?.kind, 'opaque', column.name ?? '')
    assert.deepEqual((await database.query(sql)).rows, [
      { indexed: { shadow: 'index' }, path: { shadow: 'path' }, deleted: { shadow: 'delete' } },
    ])
  } finally {
    await database.close()
  }
})
