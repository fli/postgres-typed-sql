import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  buildTypedSqlPostgresIrFromCompiledConfigs,
  type TypedSqlPostgresIr,
  type TypedSqlPostgresIrCompiledConfig,
} from '../src/analyzer-ir.js'
import { createAnalysisDatabase } from '../src/engine.js'

const schemaFile = resolve(import.meta.dirname, 'fixtures/schema.sql')

function config(name: string, sql: string, parameterNames: readonly string[] = []): TypedSqlPostgresIrCompiledConfig {
  return {
    name,
    parameterNames,
    sourceFile: `queries/${name}.typed.sql`,
    sql,
  }
}

test('infers build-object shapes only from proven complete argument lists', async () => {
  const database = await createAnalysisDatabase({ schemaFiles: [schemaFile] })
  try {
    await database.query(`
      create table public.json_variadic_inputs (
        nullable_entries text[],
        required_entries text[] not null
      )
    `)
    await database.query(`
      insert into public.json_variadic_inputs(nullable_entries, required_entries)
      values (null, array['answer', '42'])
    `)
    const result = await buildTypedSqlPostgresIrFromCompiledConfigs(database, [
      config('literalVariadicJson', "select json_build_object(variadic array['answer', '42']) as payload"),
      config('dynamicVariadicJson', 'select jsonb_build_object(variadic $1::text[]) as payload', ['entries']),
      config('nullVariadicJson', 'select jsonb_build_object(variadic null::text[]) as payload'),
      config(
        'nullableVarVariadicJson',
        'select jsonb_build_object(variadic nullable_entries) as payload from public.json_variadic_inputs'
      ),
      config(
        'requiredVarVariadicJson',
        'select jsonb_build_object(variadic required_entries) as payload from public.json_variadic_inputs'
      ),
      config('flatNullableJson', "select jsonb_build_object('answer', null::text) as payload"),
      config('dynamicFieldJson', "select jsonb_build_object('answer', $1::text) as payload", ['answer']),
      config('oddBuildObject', "select jsonb_build_object('unpaired') as payload"),
    ])
    const query = (name: string): TypedSqlPostgresIr => {
      const resolved = result.queries.find((candidate) => candidate.name === name)
      assert.ok(resolved, `expected ${name}`)
      return resolved
    }

    const literalShape = query('literalVariadicJson').resultColumns[0]?.jsonShape
    assert.equal(query('literalVariadicJson').resultColumns[0]?.nullability.kind, 'nonNull')
    assert.equal(literalShape?.kind, 'object')
    if (literalShape?.kind === 'object') {
      assert.equal(literalShape.nullability.kind, 'nonNull')
      assert.equal(literalShape.fields.length, 1)
      assert.equal(literalShape.fields[0]?.name, 'answer')
      assert.equal(literalShape.fields[0]?.shape.kind, 'stringLiteral')
      if (literalShape.fields[0]?.shape.kind === 'stringLiteral') {
        assert.equal(literalShape.fields[0].shape.value, '42')
      }
    }
    const dynamicColumn = query('dynamicVariadicJson').resultColumns[0]
    assert.equal(dynamicColumn?.nullability.kind, 'unknown')
    assert.equal(dynamicColumn?.jsonShape?.kind, 'opaque')
    assert.equal(dynamicColumn?.jsonShape?.nullability.kind, 'unknown')
    assert.equal(query('nullVariadicJson').resultColumns[0]?.nullability.kind, 'nullable')
    assert.equal(query('nullVariadicJson').resultColumns[0]?.jsonShape?.nullability.kind, 'nullable')
    assert.equal(query('nullableVarVariadicJson').resultColumns[0]?.nullability.kind, 'nullable')
    assert.equal(query('nullableVarVariadicJson').resultColumns[0]?.jsonShape?.nullability.kind, 'nullable')
    assert.equal(query('requiredVarVariadicJson').resultColumns[0]?.nullability.kind, 'nonNull')
    assert.equal(query('requiredVarVariadicJson').resultColumns[0]?.jsonShape?.nullability.kind, 'nonNull')
    assert.equal(query('flatNullableJson').resultColumns[0]?.nullability.kind, 'nonNull')
    assert.equal(query('flatNullableJson').resultColumns[0]?.jsonShape?.nullability.kind, 'nonNull')
    const dynamicFieldShape = query('dynamicFieldJson').resultColumns[0]?.jsonShape
    assert.equal(dynamicFieldShape?.kind, 'object')
    if (dynamicFieldShape?.kind === 'object') {
      assert.deepEqual(dynamicFieldShape.fields[0]?.shape.nullability, {
        kind: 'unknown',
        reason: 'parameter',
      })
    }
    assert.equal(query('oddBuildObject').resultColumns[0]?.jsonShape?.kind, 'opaque')
    assert.deepEqual(
      (await database.query("select json_build_object(variadic array['answer', '42']) as payload")).rows,
      [{ payload: { answer: '42' } }]
    )
    assert.deepEqual((await database.query('select jsonb_build_object(variadic null::text[]) as payload')).rows, [
      { payload: null },
    ])
    assert.deepEqual(
      (
        await database.query(
          'select jsonb_build_object(variadic nullable_entries) as payload from public.json_variadic_inputs'
        )
      ).rows,
      [{ payload: null }]
    )
    assert.deepEqual((await database.query("select jsonb_build_object('answer', null::text) as payload")).rows, [
      { payload: { answer: null } },
    ])
  } finally {
    await database.close()
  }
})

test('infers JSON build-array containers, elements, and variadic nullability without crossing opaque boundaries', async () => {
  const database = await createAnalysisDatabase({ schemaFiles: [schemaFile] })
  try {
    await database.query(`
      create table public.json_array_inputs (
        nullable_entries text[],
        required_entries text[] not null,
        existing_payload jsonb
      )
    `)
    await database.query(`
      create function public.json_build_array(value text)
      returns json
      language sql
      immutable
      as $$ select pg_catalog.json_build_object('shadow', value) $$
    `)
    const result = await buildTypedSqlPostgresIrFromCompiledConfigs(database, [
      config(
        'jsonArrayObject',
        "select pg_catalog.json_build_array(pg_catalog.json_build_object('id', 1, 'state', 'ready')) as payload"
      ),
      config(
        'jsonbArrayObject',
        "select pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id', 1, 'state', 'ready')) as payload"
      ),
      config('emptyJsonArray', 'select jsonb_build_array() as payload'),
      config('nullableJsonArrayElement', 'select jsonb_build_array(null::text) as payload'),
      config(
        'heterogeneousJsonArray',
        `select jsonb_build_array(
          jsonb_build_object('state', 'ready'),
          jsonb_build_object('state', 'missing', 'detail', null::text)
        ) as payload`
      ),
      config(
        'nestedJsonArray',
        "select jsonb_build_object('items', jsonb_build_array(jsonb_build_object('id', 1))) as payload"
      ),
      config('ordinarySqlArrayElement', 'select jsonb_build_array(null::text[]) as payload'),
      config('literalVariadicArray', "select jsonb_build_array(variadic array['a', 'b']) as payload"),
      config('literalEmptyVariadicArray', 'select jsonb_build_array(variadic array[]::text[]) as payload'),
      config('dynamicVariadicArray', 'select jsonb_build_array(variadic $1::text[]) as payload', ['entries']),
      config('nullVariadicArray', 'select jsonb_build_array(variadic null::text[]) as payload'),
      config(
        'nullableColumnVariadicArray',
        'select jsonb_build_array(variadic nullable_entries) as payload from public.json_array_inputs'
      ),
      config(
        'requiredColumnVariadicArray',
        'select jsonb_build_array(variadic required_entries) as payload from public.json_array_inputs'
      ),
      config(
        'selectedJsonElement',
        'select jsonb_build_array(existing_payload) as payload from public.json_array_inputs'
      ),
      config('dynamicObjectKeyElement', 'select jsonb_build_array(jsonb_build_object($1::text, 42)) as payload', [
        'key',
      ]),
      config('shadowedBuildArray', "select public.json_build_array('value') as payload"),
    ])
    const column = (name: string) => {
      const query = result.queries.find((candidate) => candidate.name === name)
      assert.ok(query, `expected ${name}`)
      const resolved = query.resultColumns[0]
      assert.ok(resolved, `expected ${name} result column`)
      return resolved
    }

    for (const name of ['jsonArrayObject', 'jsonbArrayObject']) {
      const resolved = column(name)
      assert.equal(resolved.nullability.kind, 'nonNull')
      assert.equal(resolved.jsonShape?.kind, 'array')
      if (resolved.jsonShape?.kind === 'array') {
        assert.equal(resolved.jsonShape.nullability.kind, 'nonNull')
        assert.equal(resolved.jsonShape.element.kind, 'object')
        if (resolved.jsonShape.element.kind === 'object') {
          assert.deepEqual(
            resolved.jsonShape.element.fields.map((field) => field.name),
            ['id', 'state']
          )
        }
      }
    }

    const empty = column('emptyJsonArray').jsonShape
    assert.equal(empty?.kind, 'array')
    if (empty?.kind === 'array') {
      assert.equal(empty.nullability.kind, 'nonNull')
      assert.equal(empty.element.kind, 'opaque')
      assert.equal(empty.element.nullability.kind, 'nonNull')
    }

    const nullableElement = column('nullableJsonArrayElement').jsonShape
    assert.equal(nullableElement?.kind, 'array')
    if (nullableElement?.kind === 'array') {
      assert.equal(nullableElement.nullability.kind, 'nonNull')
      assert.equal(nullableElement.element.nullability.kind, 'nullable')
    }

    const heterogeneous = column('heterogeneousJsonArray').jsonShape
    assert.equal(heterogeneous?.kind, 'array')
    if (heterogeneous?.kind === 'array') {
      assert.equal(heterogeneous.element.kind, 'union')
      assert.equal(heterogeneous.element.nullability.kind, 'nonNull')
      if (heterogeneous.element.kind === 'union') {
        assert.equal(heterogeneous.element.alternatives.length, 2)
        assert.ok(heterogeneous.element.alternatives.every((alternative) => alternative.kind === 'object'))
      }
    }

    const nested = column('nestedJsonArray').jsonShape
    assert.equal(nested?.kind, 'object')
    if (nested?.kind === 'object') {
      const items = nested.fields.find((field) => field.name === 'items')?.shape
      assert.equal(items?.kind, 'array')
      assert.equal(items?.kind === 'array' ? items.element.kind : null, 'object')
    }

    const ordinarySqlArray = column('ordinarySqlArrayElement').jsonShape
    assert.equal(ordinarySqlArray?.kind, 'array')
    if (ordinarySqlArray?.kind === 'array') {
      assert.equal(ordinarySqlArray.nullability.kind, 'nonNull')
      assert.equal(ordinarySqlArray.element.kind, 'scalar')
      assert.equal(ordinarySqlArray.element.nullability.kind, 'nullable')
    }

    const literalVariadic = column('literalVariadicArray').jsonShape
    assert.equal(literalVariadic?.kind, 'array')
    if (literalVariadic?.kind === 'array') {
      assert.equal(literalVariadic.nullability.kind, 'nonNull')
      assert.equal(literalVariadic.element.kind, 'union')
    }

    const literalEmptyVariadic = column('literalEmptyVariadicArray').jsonShape
    assert.equal(literalEmptyVariadic?.kind, 'array')
    if (literalEmptyVariadic?.kind === 'array') {
      assert.equal(literalEmptyVariadic.nullability.kind, 'nonNull')
      assert.equal(literalEmptyVariadic.element.kind, 'opaque')
      assert.equal(literalEmptyVariadic.element.nullability.kind, 'nonNull')
    }

    const dynamicVariadic = column('dynamicVariadicArray').jsonShape
    assert.equal(dynamicVariadic?.kind, 'array')
    if (dynamicVariadic?.kind === 'array') {
      assert.equal(dynamicVariadic.nullability.kind, 'unknown')
      assert.equal(dynamicVariadic.element.kind, 'opaque')
      assert.equal(dynamicVariadic.element.nullability.kind, 'unknown')
    }

    const nullVariadic = column('nullVariadicArray').jsonShape
    assert.equal(nullVariadic?.kind, 'array')
    assert.equal(nullVariadic?.nullability.kind, 'nullable')
    assert.equal(column('nullableColumnVariadicArray').jsonShape?.nullability.kind, 'nullable')
    assert.equal(column('requiredColumnVariadicArray').jsonShape?.nullability.kind, 'nonNull')

    const selectedJson = column('selectedJsonElement').jsonShape
    assert.equal(selectedJson?.kind, 'array')
    assert.equal(selectedJson?.kind === 'array' ? selectedJson.element.kind : null, 'opaque')

    const dynamicObjectKey = column('dynamicObjectKeyElement').jsonShape
    assert.equal(dynamicObjectKey?.kind, 'array')
    if (dynamicObjectKey?.kind === 'array') {
      assert.equal(dynamicObjectKey.nullability.kind, 'nonNull')
      assert.equal(dynamicObjectKey.element.kind, 'opaque')
    }

    assert.equal(column('shadowedBuildArray').jsonShape?.kind, 'opaque')

    assert.deepEqual((await database.query('select json_build_array(null::text[]) as payload')).rows, [
      { payload: [null] },
    ])
    assert.deepEqual((await database.query('select json_build_array(variadic null::text[]) as payload')).rows, [
      { payload: null },
    ])
  } finally {
    await database.close()
  }
})

test('infers CASE JSON unions with scoped branch facts and exact string constants', async () => {
  const database = await createAnalysisDatabase({ schemaFiles: [schemaFile] })
  try {
    await database.query(`
      create table public.playback_values (
        publication_public_id text,
        manifest_object_key text
      )
    `)
    await database.query('create table public.outer_scope_values (value text)')
    await database.query('create table public.inner_scope_values (value text)')
    const result = await buildTypedSqlPostgresIrFromCompiledConfigs(database, [
      config(
        'playbackCase',
        `select case
          when playback.publication_public_id is not null
           and playback.manifest_object_key is not null
          then jsonb_build_object(
            'state', 'playable',
            'publicationPublicId', playback.publication_public_id,
            'manifestType', 'hls',
            'manifestObjectKey', playback.manifest_object_key
          )
          else jsonb_build_object('state', 'unavailable')
        end as playback
        from (values (1)) seed(value)
        left join lateral (
          select publication_public_id, manifest_object_key
          from public.playback_values
          limit 1
        ) playback on true`
      ),
      config(
        'wholeRowBranchFact',
        `select case
          when playback is not null
          then jsonb_build_object('row', playback)
          else jsonb_build_object('row', null::text)
        end as payload
        from (values (1)) seed(value)
        left join lateral (
          select publication_public_id, manifest_object_key
          from public.playback_values
          limit 1
        ) playback on true`
      ),
      config(
        'scopedBranchFact',
        `select case
          when outer_value.value is not null then (
            select jsonb_build_object(
              'outer', outer_value.value,
              'inner', inner_value.value
            )
            from public.inner_scope_values inner_value
            limit 1
          )
          else jsonb_build_object('outer', null::text, 'inner', null::text)
        end as payload
        from public.outer_scope_values outer_value`
      ),
      config(
        'nullOnlyCaseArm',
        `select jsonb_build_object(
          'state', case when true then 'playable' else null::text end
        ) as payload`
      ),
      config(
        'fieldOrderEquivalentCase',
        `select case when true
          then jsonb_build_object('a', 'left', 'b', 'right')
          else jsonb_build_object('b', 'right', 'a', 'left')
        end as payload`
      ),
      config('nonStringConstants', "select jsonb_build_object('one', 1, 'flag', true) as payload"),
      config(
        'ioCastCase',
        `select (case when true
          then '{"a":1}'
          else '{"b":2}'
        end)::jsonb as payload`
      ),
      config(
        'nullableRowToJson',
        'select row_to_json(source_row, null::boolean) as payload from (values (1)) source_row(value)'
      ),
      config(
        'requiredRowToJson',
        'select row_to_json(source_row, false) as payload from (values (1)) source_row(value)'
      ),
      config('nullableToJson', 'select to_json(value) as payload from public.outer_scope_values'),
    ])
    const shape = (name: string) => result.queries.find((query) => query.name === name)?.resultColumns[0]?.jsonShape

    const playback = shape('playbackCase')
    assert.equal(playback?.kind, 'union')
    assert.equal(playback?.nullability.kind, 'nonNull')
    assert.equal(
      result.queries.find((query) => query.name === 'playbackCase')?.resultColumns[0]?.nullability.kind,
      'nonNull'
    )
    if (playback?.kind === 'union') {
      assert.equal(playback.alternatives.length, 2)
      const [playable, unavailable] = playback.alternatives
      assert.equal(playable?.kind, 'object')
      assert.equal(unavailable?.kind, 'object')
      if (playable?.kind === 'object' && unavailable?.kind === 'object') {
        const playableFields = new Map(playable.fields.map((field) => [field.name, field.shape]))
        const state = playableFields.get('state')
        const manifestType = playableFields.get('manifestType')
        assert.equal(state?.kind, 'stringLiteral')
        assert.equal(state?.nullability.kind, 'nonNull')
        assert.equal(state?.kind === 'stringLiteral' ? state.value : null, 'playable')
        assert.equal(manifestType?.kind, 'stringLiteral')
        assert.equal(manifestType?.nullability.kind, 'nonNull')
        assert.equal(manifestType?.kind === 'stringLiteral' ? manifestType.value : null, 'hls')
        assert.equal(playableFields.get('publicationPublicId')?.nullability.kind, 'nonNull')
        assert.equal(playableFields.get('manifestObjectKey')?.nullability.kind, 'nonNull')
        const unavailableState = unavailable.fields[0]?.shape
        assert.equal(unavailableState?.kind, 'stringLiteral')
        assert.equal(unavailableState?.nullability.kind, 'nonNull')
        assert.equal(unavailableState?.kind === 'stringLiteral' ? unavailableState.value : null, 'unavailable')
      }
    }

    const wholeRow = shape('wholeRowBranchFact')
    assert.equal(wholeRow?.kind, 'union')
    if (wholeRow?.kind === 'union') {
      const presentRow = wholeRow.alternatives[0]
      assert.equal(presentRow?.kind, 'object')
      if (presentRow?.kind === 'object') {
        const nestedRow = presentRow.fields[0]?.shape
        assert.equal(nestedRow?.kind, 'object')
        assert.equal(nestedRow?.nullability.kind, 'nonNull')
      }
    }

    const scoped = shape('scopedBranchFact')
    assert.equal(scoped?.kind, 'union')
    if (scoped?.kind === 'union') {
      const refined = scoped.alternatives[0]
      assert.equal(refined?.kind, 'object')
      if (refined?.kind === 'object') {
        const fields = new Map(refined.fields.map((field) => [field.name, field.shape]))
        assert.equal(fields.get('outer')?.nullability.kind, 'nonNull')
        assert.equal(fields.get('inner')?.nullability.kind, 'nullable')
      }
    }

    const nullArm = shape('nullOnlyCaseArm')
    assert.equal(nullArm?.kind, 'object')
    if (nullArm?.kind === 'object') {
      const state = nullArm.fields[0]?.shape
      assert.equal(state?.kind, 'stringLiteral')
      assert.equal(state?.nullability.kind, 'nullable')
      assert.equal(state?.kind === 'stringLiteral' ? state.value : null, 'playable')
    }

    const reordered = shape('fieldOrderEquivalentCase')
    assert.equal(reordered?.kind, 'object')
    if (reordered?.kind === 'object') {
      assert.deepEqual(
        reordered.fields.map((field) => field.name),
        ['a', 'b']
      )
    }

    const nonStringConstants = shape('nonStringConstants')
    assert.equal(nonStringConstants?.kind, 'object')
    if (nonStringConstants?.kind === 'object') {
      for (const field of nonStringConstants.fields) {
        assert.equal(field.shape.kind, 'scalar')
      }
    }

    const ioCast = shape('ioCastCase')
    assert.equal(ioCast?.kind, 'opaque')
    assert.equal(ioCast?.nullability.kind, 'nonNull')

    const nullableRow = shape('nullableRowToJson')
    assert.equal(nullableRow?.kind, 'object')
    assert.equal(nullableRow?.nullability.kind, 'nullable')
    assert.equal(
      result.queries.find((query) => query.name === 'nullableRowToJson')?.resultColumns[0]?.nullability.kind,
      'nullable'
    )

    const requiredRow = shape('requiredRowToJson')
    assert.equal(requiredRow?.kind, 'object')
    assert.equal(requiredRow?.nullability.kind, 'nonNull')
    assert.equal(
      result.queries.find((query) => query.name === 'requiredRowToJson')?.resultColumns[0]?.nullability.kind,
      'nonNull'
    )

    const nullableToJson = shape('nullableToJson')
    assert.equal(nullableToJson?.kind, 'opaque')
    assert.equal(nullableToJson?.nullability.kind, 'nullable')

    for (const query of result.queries) {
      for (const column of query.resultColumns) {
        if (column.jsonShape) {
          assert.equal(
            column.nullability.kind,
            column.jsonShape.nullability.kind,
            `${query.name}.${column.name} nullability`
          )
        }
      }
    }

    assert.deepEqual(
      (
        await database.query(`select (case when true
          then '{"a":1}'
          else '{"b":2}'
        end)::jsonb as payload`)
      ).rows,
      [{ payload: { a: 1 } }]
    )
    assert.deepEqual(
      (
        await database.query(
          'select row_to_json(source_row, null::boolean) as payload from (values (1)) source_row(value)'
        )
      ).rows,
      [{ payload: null }]
    )
  } finally {
    await database.close()
  }
})
