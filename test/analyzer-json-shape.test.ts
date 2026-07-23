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
