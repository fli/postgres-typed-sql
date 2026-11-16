import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

test('NULL admission explains the actual blockers through the public project API', async (t) => {
  const { openQueryProject }: typeof import('../src/query-project.js') = await import(
    new URL('../../dist/project.js', import.meta.url).href
  )
  const root = await mkdtemp(join(tmpdir(), 'typed-sql-diagnostics-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const schema = `diagnostics_${randomUUID().replaceAll('-', '')}`
  await writeFile(
    join(root, 'schema.sql'),
    `create schema ${schema};
    create domain ${schema}.required_text as text not null;
    create table ${schema}.items(id integer primary key, value text, required text not null);
    create table ${schema}.modules(mode text not null, override text,
      constraint module_override_check check (mode <> 'custom' or override is not null));
    create table ${schema}.triggered(value text);
    create table ${schema}.updates(value text, other text);
    create table ${schema}.parents(a int, b int, primary key(a,b));
    create table ${schema}.children(a int, b int, constraint full_key foreign key(a,b)
      references ${schema}.parents(a,b) match full);
    create table ${schema}."Quoted Table"("Quoted Column" text not null);
    create function ${schema}.unsafe(value text) returns text language plpgsql as $$
      begin if value is null then raise exception 'null argument'; end if; return value; end $$;
    create function ${schema}.trigger_fn() returns trigger language plpgsql as $$
      begin return new; end $$;
    create constraint trigger value_trigger after insert on ${schema}.triggered
      deferrable initially deferred for each row execute function ${schema}.trigger_fn();
    create trigger update_other before update of other on ${schema}.updates
      for each row execute function ${schema}.trigger_fn();`
  )
  await writeFile(join(root, 'config.mjs'), "export default {schema: './schema.sql'}")
  const project = await openQueryProject(join(root, 'config.mjs'))
  t.after(() => project.close())
  const sourcePath = join(root, 'probe.typed.sql')

  const cases = [
    {
      name: 'opaque overloaded callable',
      sql: `with input as (select :value::text value) select ${schema}.unsafe(value) from input`,
      outcome: 'unknown',
      code: 'opaque_callable',
      identity: [/unsafe/u, /text/u],
    },
    {
      name: 'deferred row trigger',
      sql: `insert into ${schema}.triggered(value) values (:value::text)`,
      outcome: 'unknown',
      code: 'opaque_trigger',
      identity: [/value_trigger/u, /trigger_fn/u, /after/iu, /insert/iu],
    },
    {
      name: 'direct required destination',
      sql: `insert into ${schema}.items(id, required) values (1, :value::text)`,
      outcome: 'rejects',
      code: 'target_not_null',
      identity: [/items/u, /required/u],
    },
    {
      name: 'conditional required destination through a CTE',
      sql: `with input as (select :value::text value, :provided::boolean provided)
        update ${schema}.items set required = case when input.provided then input.value else items.required end
        from input where items.id = 1`,
      outcome: 'unknown',
      code: 'conditional_required_nonnull',
      identity: [/items/u, /required/u],
    },
    {
      name: 'companion-dependent CHECK',
      sql: `insert into ${schema}.modules(mode, override) values (:mode::text, :value::text)`,
      outcome: 'unknown',
      code: 'check_unresolved',
      identity: [/module_override_check/u],
    },
    {
      name: 'NOT NULL domain',
      sql: `select :value::${schema}.required_text`,
      outcome: 'rejects',
      code: 'domain_not_null',
      identity: [/required_text/u],
    },
    {
      name: 'rejection dominates an opaque use',
      sql: `insert into ${schema}.items(id, value, required)
        values (1, ${schema}.unsafe(:value::text), :value::text)`,
      outcome: 'rejects',
      code: 'target_not_null',
      identity: [/items/u, /required/u],
    },
  ] as const

  await t.test('UPDATE OF trigger applies only to listed columns', async () => {
    const unrelated = await project.analyze(
      sourcePath,
      `-- @bindNull value\nupdate ${schema}.updates set value = :value::text`
    )
    assert.equal(unrelated.parameters[0]?.nullAdmission, 'accepts')
    const applicable = await project.analyze(
      sourcePath,
      `-- @bindNull value\nupdate ${schema}.updates set other = :value::text`
    )
    const parameter = applicable.parameters[0]
    assert.equal(parameter?.nullAdmission, 'unknown')
    assert.ok(
      parameter.nullAdmissionReasons.some(
        (reason) =>
          reason.code === 'opaque_trigger' &&
          reason.message.includes('update_other') &&
          reason.message.includes(`${schema}.trigger_fn`)
      )
    )
  })

  await t.test('destination identity includes its schema and quoted names', async () => {
    const analysis = await project.analyze(
      sourcePath,
      `-- @bindNull value\ninsert into ${schema}."Quoted Table"("Quoted Column") values (:value::text)`
    )
    const reason = analysis.parameters[0]?.nullAdmissionReasons.find((item) => item.code === 'target_not_null')
    assert.ok(reason)
    assert.ok(reason.message.includes(`${schema}."Quoted Table"."Quoted Column"`))
  })

  await t.test('intermediate domain and MATCH FULL report their actual blockers', async () => {
    for (const sql of [
      `insert into ${schema}.items(id, value) values (1, :value::text::${schema}.required_text)`,
      `with x as (select :value::text::${schema}.required_text value)
       insert into ${schema}.items(id, value) select 1, value from x`,
    ]) {
      const analysis = await project.analyze(sourcePath, `-- @bindNull value\n${sql}`)
      const parameter = analysis.parameters.find((item) => item.name === 'value')
      assert.equal(parameter?.nullAdmission, 'rejects')
      assert.ok(
        parameter.nullAdmissionReasons.some(
          (reason) => reason.code === 'domain_not_null' && reason.message.includes(`${schema}.required_text`)
        )
      )
    }
    const analysis = await project.analyze(
      sourcePath,
      `-- @bindNull value\ninsert into ${schema}.children(a,b) values (:value::int, 1)`
    )
    const reason = analysis.parameters[0]?.nullAdmissionReasons.find((item) => item.code === 'required_nonnull')
    assert.ok(reason?.message.includes('full_key'))
  })

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const analysis = await project.analyze(sourcePath, `-- @bindNull value\n${fixture.sql}`)
      const parameter = analysis.parameters.find((candidate) => candidate.name === 'value')
      assert.ok(parameter)
      assert.equal(parameter.nullAdmission, fixture.outcome)
      const reasonKeys = parameter.nullAdmissionReasons.map((reason) =>
        JSON.stringify([reason.code, reason.message, reason.compiledByteOffset])
      )
      assert.equal(new Set(reasonKeys).size, reasonKeys.length)
      if (fixture.name === 'rejection dominates an opaque use') {
        assert.ok(parameter.nullAdmissionReasons.some((reason) => reason.code === 'opaque_callable'))
      }
      const reason = parameter.nullAdmissionReasons.find((candidate) => candidate.code === fixture.code)
      assert.ok(reason, `missing ${fixture.code}`)
      for (const pattern of fixture.identity) assert.match(reason.message, pattern)
      if (reason.compiledByteOffset !== undefined) {
        assert.ok(Number.isInteger(reason.compiledByteOffset) && reason.compiledByteOffset >= 0)
      }
      const generated = await project.compile(sourcePath, `-- @bindNull value\n${fixture.sql}`)
      assert.match(generated, /readonly value: string \| null/u)
      await assert.rejects(project.compile(sourcePath, `-- @nullable value\n${fixture.sql}`), (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.ok(error.message.includes('probe.typed.sql:1'))
        assert.match(error.message, /@nullable value cannot be satisfied/u)
        for (const pattern of fixture.identity) assert.match(error.message, pattern)
        if (/offset/iu.test(error.message)) assert.match(error.message, /compiled.*(?:byte|offset)/iu)
        return true
      })
    })
  }
})
