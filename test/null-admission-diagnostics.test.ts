import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Client } from 'pg'

test(
  'range function joins execute with NULL on PostgreSQL',
  { skip: !process.env.POSTGRES_TYPED_SQL_TEST_URL },
  async () => {
    const schema = `range_function_${randomUUID().replaceAll('-', '')}`
    const client = new Client({ connectionString: process.env.POSTGRES_TYPED_SQL_TEST_URL })
    await client.connect()
    try {
      await client.query('begin')
      await client.query(`create schema ${schema};
      create table ${schema}.items(id integer primary key);
      insert into ${schema}.items values (1);
      create function ${schema}.resolve(text) returns setof ${schema}.items language sql as $$
        select * from ${schema}.items $$`)
      const sql = `select p.id from ${schema}.items p
      left join lateral ${schema}.resolve('constant') r on p.id = r.id where p.id = $1::integer`
      assert.equal((await client.query(sql, [null])).rowCount, 0)
      assert.equal((await client.query(sql, [1])).rowCount, 1)
    } finally {
      await client.query('rollback')
      await client.end()
    }
  }
)

test(
  'Boolean companions can bypass domain coercion on PostgreSQL',
  { skip: !process.env.POSTGRES_TYPED_SQL_TEST_URL },
  async () => {
    const schema = `boolean_domain_${randomUUID().replaceAll('-', '')}`
    const client = new Client({ connectionString: process.env.POSTGRES_TYPED_SQL_TEST_URL })
    await client.connect()
    try {
      await client.query('begin')
      await client.query(`create schema ${schema}; create domain ${schema}.required_text as text not null`)
      for (const [operator, flag] of [
        ['and', false],
        ['or', true],
      ] as const) {
        const result = await client.query(
          `select $1::boolean ${operator} ($2::text::${schema}.required_text = 'x') as result`,
          [flag, null]
        )
        assert.equal(result.rows[0].result, flag)
      }
    } finally {
      await client.query('rollback')
      await client.end()
    }
  }
)

test(
  'conditional query execution and domain projection on PostgreSQL',
  { skip: !process.env.POSTGRES_TYPED_SQL_TEST_URL },
  async () => {
    const client = new Client({ connectionString: process.env.POSTGRES_TYPED_SQL_TEST_URL })
    await client.connect()
    try {
      await client.query('begin')
      await client.query(
        'create temporary table certainty_sample(id integer); create domain pg_temp.certainty_text as text not null'
      )
      for (const inner of [
        'select count(*) over (rows $2::bigint preceding) from certainty_sample',
        'select count(*) from certainty_sample tablesample system ($2::real)',
      ]) {
        const sql = `select case when $1::boolean then (${inner}) else 1 end as result`
        assert.equal((await client.query(sql, [false, null])).rows[0].result, '1')
        await client.query('savepoint expected_error')
        await assert.rejects(client.query(sql, [true, null]), /cannot be null|must not be null/u)
        await client.query('rollback to savepoint expected_error')
      }
      assert.equal(
        (
          await client.query(
            'select 1 from certainty_sample e cross join certainty_sample tablesample system ($1::real)',
            [null]
          )
        ).rowCount,
        0
      )
      for (const sql of [
        'select count(*) over (rows $1::bigint preceding) from certainty_sample',
        'select count(*) from certainty_sample tablesample system ($1::real)',
      ]) {
        await client.query('savepoint expected_error')
        await assert.rejects(client.query(sql, [null]), /cannot be null|must not be null/u)
        await client.query('rollback to savepoint expected_error')
      }
      await client.query('insert into certainty_sample values (1)')
      assert.equal(
        (
          await client.query(
            'select case when $1::boolean then count(*) over (rows $2::bigint preceding) else 1 end as result from certainty_sample',
            [false, null]
          )
        ).rows[0].result,
        '1'
      )
      assert.equal(
        (
          await client.query(
            'select case when false then count(*) over (rows $1::bigint preceding) else 1 end as result from certainty_sample',
            [null]
          )
        ).rows[0].result,
        '1'
      )
      await client.query('delete from certainty_sample')
      for (const suffix of ['from certainty_sample', 'where false']) {
        assert.equal((await client.query(`select $1::text::pg_temp.certainty_text ${suffix}`, [null])).rowCount, 0)
      }
      assert.equal(
        (await client.query('select 1 from (values ($1::text::pg_temp.certainty_text)) x(v)', [null])).rowCount,
        1
      )
      assert.equal(
        (await client.query('select count($1::text::pg_temp.certainty_text) as count from certainty_sample', [null]))
          .rows[0].count,
        '0'
      )
      await client.query('savepoint expected_error')
      await assert.rejects(client.query('select $1::text::pg_temp.certainty_text', [null]), /does not allow null/u)
      await client.query('rollback to savepoint expected_error')
    } finally {
      await client.query('rollback')
      await client.end()
    }
  }
)

test(
  'before-row trigger writes and eager coercion on PostgreSQL',
  { skip: !process.env.POSTGRES_TYPED_SQL_TEST_URL },
  async () => {
    const schema = `write_identity_${randomUUID().replaceAll('-', '')}`
    const client = new Client({ connectionString: process.env.POSTGRES_TYPED_SQL_TEST_URL })
    await client.connect()
    try {
      await client.query('begin')
      await client.query(`create schema ${schema};
        create domain ${schema}.required_text as text not null;
        create table ${schema}.rewrite(value text not null);
        create table ${schema}.skip(value text not null);
        create table ${schema}.plain(value text not null);
        create table ${schema}.after_row(value text not null);
        create table ${schema}.checked(value text check (value is not null));
        create function ${schema}.rewrite_null() returns trigger language plpgsql as $$
          begin new.value := 'fixed'; return new; end $$;
        create function ${schema}.skip_row() returns trigger language plpgsql as $$
          begin return null; end $$;
        create function ${schema}.identity() returns trigger language plpgsql as $$
          begin return new; end $$;
        create trigger rewrite_null before insert on ${schema}.rewrite for each row execute function ${schema}.rewrite_null();
        create trigger skip_row before insert on ${schema}.skip for each row execute function ${schema}.skip_row();
        create trigger after_row after insert on ${schema}.after_row for each row execute function ${schema}.identity();`)
      assert.equal(
        (await client.query(`insert into ${schema}.rewrite values ($1::text) returning value`, [null])).rows[0].value,
        'fixed'
      )
      assert.equal(
        (await client.query(`insert into ${schema}.skip values ($1::text) returning value`, [null])).rowCount,
        0
      )
      for (const sql of [
        `insert into ${schema}.plain values ($1::text)`,
        `insert into ${schema}.after_row values ($1::text)`,
        `insert into ${schema}.checked values ($1::text)`,
        `insert into ${schema}.rewrite values ($1::text::${schema}.required_text)`,
      ]) {
        await client.query('savepoint expected_error')
        await assert.rejects(client.query(sql, [null]), /null value|check constraint/u)
        await client.query('rollback to savepoint expected_error')
      }
    } finally {
      await client.query('rollback')
      await client.end()
    }
  }
)

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
    create function ${schema}.resolve(text) returns setof ${schema}.items language sql as $$
      select * from ${schema}.items $$;
    create table ${schema}.modules(mode text not null, override text,
      constraint module_override_check check (mode <> 'custom' or override is not null));
    create table ${schema}.triggered(value text);
    create table ${schema}.before_rewrite(value text not null);
    create table ${schema}.before_skip(value text not null);
    create table ${schema}.after_trigger(value text not null);
    create table ${schema}.plain_required(value text not null);
    create table ${schema}.domain_target(value ${schema}.required_text);
    create table ${schema}.checked(value text check (value is not null));
    create function ${schema}.rewrite_null() returns trigger language plpgsql as $$
      begin new.value := 'fixed'; return new; end $$;
    create function ${schema}.skip_row() returns trigger language plpgsql as $$
      begin return null; end $$;
    create trigger rewrite_null before insert on ${schema}.before_rewrite
      for each row execute function ${schema}.rewrite_null();
    create trigger skip_row before insert on ${schema}.before_skip
      for each row execute function ${schema}.skip_row();
    create trigger rewrite_domain before insert on ${schema}.domain_target
      for each row execute function ${schema}.rewrite_null();
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
    create trigger after_row after insert on ${schema}.after_trigger
      for each row execute function ${schema}.trigger_fn();
    create trigger update_other before update of other on ${schema}.updates
      for each row execute function ${schema}.trigger_fn();`
  )
  await writeFile(join(root, 'config.mjs'), "export default {schema: './schema.sql'}")
  const project = await openQueryProject(join(root, 'config.mjs'))
  t.after(() => project.close())
  const sourcePath = join(root, 'probe.typed.sql')

  await t.test('query execution governs rejection evidence', async () => {
    for (const sql of [
      `select case when :flag::boolean then (select count(*) over (rows :value::bigint preceding) from ${schema}.items) else 1 end`,
      `select case when :flag::boolean then (select count(*) from ${schema}.items tablesample system (:value::real)) else 1 end`,
      `select :value::text::${schema}.required_text from ${schema}.items`,
      `select :value::text::${schema}.required_text where false`,
      `select count(:value::text::${schema}.required_text) from ${schema}.items`,
      `select 1 from (values (:value::text::${schema}.required_text)) x(v)`,
      `select count(*) over (rows :value::bigint preceding) from ${schema}.items limit 0`,
      `select 1 window unused as (rows :value::bigint preceding)`,
      `select case when :flag::boolean then count(*) over (rows :value::bigint preceding) else 1 end from ${schema}.items`,
      `select case when false then count(*) over (rows :value::bigint preceding) else 1 end from ${schema}.items`,
      `select 1 from ${schema}.items e cross join ${schema}.items tablesample system (:value::real)`,
      `select count(*) from ${schema}.items tablesample system (:value::real) where false`,
    ]) {
      const analysis = await project.analyze(sourcePath, `-- @bindNull value\n${sql}`)
      const parameter = analysis.parameters.find((item) => item.name === 'value')
      assert.equal(parameter?.nullAdmission, 'unknown', sql)
      await assert.rejects(
        project.compile(sourcePath, `-- @nullable value\n${sql}`),
        /@nullable value cannot be satisfied/u
      )
      assert.ok(
        parameter.nullAdmissionReasons.some(
          (reason) =>
            reason.code === (sql.includes('required_text') ? 'domain_unresolved' : 'conditional_required_nonnull')
        )
      )
    }
    for (const sql of [
      `select :value::text::${schema}.required_text`,
      `select count(*) over (rows :value::bigint preceding) from ${schema}.items`,
      `select count(*) from ${schema}.items tablesample system (:value::real)`,
    ]) {
      const analysis = await project.analyze(sourcePath, `-- @bindNull value\n${sql}`)
      assert.equal(analysis.parameters.find((item) => item.name === 'value')?.nullAdmission, 'rejects', sql)
    }
  })

  await t.test('range function outputs depend on their inputs', async () => {
    for (const input of ["'constant'", ':other::text']) {
      const sql = `select p.id from ${schema}.items p
        left join lateral ${schema}.resolve(${input}) r on p.id = r.id
        where p.id = :value::integer`
      await project.compile(sourcePath, `-- @nullable value\n${sql}`)
    }
    const dependent = `select p.id from ${schema}.items p
      left join lateral ${schema}.resolve(:value::text) r on p.id = r.id`
    const rowsFrom = `select p.id from ${schema}.items p
      left join lateral rows from (${schema}.resolve('constant'), ${schema}.resolve(:value::text))
        r(first_id, first_value, first_required, second_id, second_value, second_required)
      on p.id = r.first_id`
    const upstream = `with input as (select :value::text value)
      select p.id from ${schema}.items p cross join input
      left join lateral ${schema}.resolve(input.value) r on p.id = r.id`
    for (const sql of [dependent, rowsFrom, upstream]) {
      const analysis = await project.analyze(sourcePath, `-- @bindNull value\n${sql}`)
      const parameter = analysis.parameters.find((item) => item.name === 'value')
      assert.equal(parameter?.nullAdmission, 'unknown')
      assert.ok(parameter.nullAdmissionReasons.some((reason) => reason.message.includes('int4eq')))
      await assert.rejects(project.compile(sourcePath, `-- @nullable value\n${sql}`), /could not prove/u)
    }
    for (const sql of [
      `select jsonb_build_object('id', q.id) from (select id from ${schema}.items where id = :value::integer limit 1) q`,
      `with q as (select id from ${schema}.items where id = :value::integer limit 1) select jsonb_build_object('id', q.id) from q`,
      `select jsonb_build_object('id', (select id from ${schema}.items where id = :value::integer limit 1))`,
    ]) {
      const analysis = await project.analyze(sourcePath, `-- @bindNull value\n${sql}`)
      assert.equal(analysis.parameters.find((item) => item.name === 'value')?.nullAdmission, 'unknown')
    }
  })

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

  await t.test('conditional domain coercions report uncertainty', async () => {
    for (const expression of [
      `case when :flag::boolean then :value::text::${schema}.required_text else 'ok'::${schema}.required_text end`,
      `case when :flag::boolean then 'ok'::${schema}.required_text else :value::text::${schema}.required_text end`,
      `case :flag::boolean when true then :value::text::${schema}.required_text else 'ok'::${schema}.required_text end`,
      `case :flag::boolean when true then 'ok'::${schema}.required_text else :value::text::${schema}.required_text end`,
      `case when :flag::boolean then case when :other::boolean then :value::text::${schema}.required_text else 'ok'::${schema}.required_text end else 'ok'::${schema}.required_text end`,
    ]) {
      for (const sql of [`select ${expression}`, `insert into ${schema}.items(id, value) values (1, ${expression})`]) {
        const analysis = await project.analyze(sourcePath, `-- @bindNull value\n${sql}`)
        const parameter = analysis.parameters.find((item) => item.name === 'value')
        assert.equal(parameter?.nullAdmission, 'unknown')
        assert.ok(
          parameter.nullAdmissionReasons.some(
            (reason) =>
              reason.code === 'domain_unresolved' &&
              reason.message.includes(`${schema}.required_text`) &&
              reason.message.includes('CASE condition')
          )
        )
        await assert.rejects(
          project.compile(sourcePath, `-- @nullable value\n${sql}`),
          /could not prove that every use accepts NULL/u
        )
      }
    }
    const conditionUse = await project.analyze(
      sourcePath,
      `-- @bindNull value\nselect case when :value::text::${schema}.required_text is null then 1 else 2 end`
    )
    assert.equal(conditionUse.parameters.find((item) => item.name === 'value')?.nullAdmission, 'rejects')
    const subjectUse = await project.analyze(
      sourcePath,
      `-- @bindNull value\nselect case :value::text::${schema}.required_text when 'x' then 1 else 2 end`
    )
    assert.equal(subjectUse.parameters.find((item) => item.name === 'value')?.nullAdmission, 'rejects')
    for (const [condition, outcome] of [
      ['true', 'rejects'],
      ['false', 'unknown'],
      ['null::boolean', 'unknown'],
    ] as const) {
      const sql = `select case when ${condition} then :value::text::${schema}.required_text else 'ok'::${schema}.required_text end`
      const analysis = await project.analyze(sourcePath, `-- @bindNull value\n${sql}`)
      assert.equal(analysis.parameters.find((item) => item.name === 'value')?.nullAdmission, outcome)
    }
  })

  await t.test('conditional expression reachability does not claim a proven domain rejection', async () => {
    const domain = `${schema}.required_text`
    const cases = [
      [
        `case when :value::text is distinct from :flag::text then 'ok'::${domain} else :value::text::${domain} end`,
        'CASE condition',
      ],
      [
        `case when :value::text is distinct from :flag::text then 'ok'::${domain} when true then :value::text::${domain} end`,
        'CASE condition',
      ],
      [
        `case when :flag::boolean then (select :value::text::${domain}) else 'ok'::${domain} end`,
        'enclosing query execution',
      ],
      [
        `case when :flag::boolean then 'ok'::${domain} else (select :value::text::${domain}) end`,
        'enclosing query execution',
      ],
      [`case when false then (select :value::text::${domain}) else 'ok'::${domain} end`, 'enclosing query execution'],
      [
        `case when :flag::boolean then (with x as (select :value::text::${domain} v) select v from x) else 'ok'::${domain} end`,
        'enclosing query execution',
      ],
      [`coalesce(:flag::text, :value::text::${domain})`, 'COALESCE'],
    ] as const
    for (const [expression, reasonText] of cases) {
      const sql = `select ${expression}`
      const analysis = await project.analyze(sourcePath, `-- @bindNull value\n${sql}`)
      const parameter = analysis.parameters.find((item) => item.name === 'value')
      assert.equal(parameter?.nullAdmission, 'unknown', expression)
      assert.ok(
        parameter.nullAdmissionReasons.some(
          (reason) =>
            reason.code === 'domain_unresolved' &&
            reason.message.includes(domain) &&
            reason.message.includes(reasonText)
        ),
        expression
      )
      await assert.rejects(
        project.compile(sourcePath, `-- @nullable value\n${sql}`),
        /could not prove that every use accepts NULL/u
      )
    }
    for (const expression of [
      `coalesce(:value::text::${domain}, :flag::text)`,
      `coalesce(null::text, :value::text::${domain})`,
      `case when false then 'ok'::${domain} else :value::text::${domain} end`,
      `case when :flag::boolean then (select :value::text::${domain}) else 'ok'::${domain} end, :value::text::${domain}`,
    ]) {
      const analysis = await project.analyze(sourcePath, `-- @bindNull value\nselect ${expression}`)
      assert.equal(analysis.parameters.find((item) => item.name === 'value')?.nullAdmission, 'rejects', expression)
    }
  })

  await t.test('boolean operands preserve conditional domain reachability', async () => {
    const domain = `${schema}.required_text`
    const cast = `(:value::text::${domain} = 'x')`
    for (const operator of ['and', 'or']) {
      for (const expression of [`:flag::boolean ${operator} ${cast}`, `${cast} ${operator} :flag::boolean`]) {
        const sql = `select ${expression}`
        const analysis = await project.analyze(sourcePath, `-- @bindNull value\n${sql}`)
        const parameter = analysis.parameters.find((item) => item.name === 'value')
        assert.equal(parameter?.nullAdmission, 'unknown', expression)
        assert.ok(
          parameter.nullAdmissionReasons.some(
            (reason) => reason.code === 'domain_unresolved' && reason.message.includes(domain)
          ),
          expression
        )
        await assert.rejects(
          project.compile(sourcePath, `-- @nullable value\n${sql}`),
          /could not prove that every use accepts NULL/u
        )
      }
    }
    for (const expression of [
      cast,
      `not ${cast}`,
      `true and ${cast}`,
      `${cast} and true`,
      `false or ${cast}`,
      `${cast} or false`,
    ]) {
      const analysis = await project.analyze(sourcePath, `-- @bindNull value\nselect ${expression}`)
      assert.equal(analysis.parameters.find((item) => item.name === 'value')?.nullAdmission, 'rejects', expression)
    }
  })

  await t.test('write constraints respect before-row trigger identity', async () => {
    for (const [table, trigger] of [
      ['before_rewrite', 'rewrite_null'],
      ['before_skip', 'skip_row'],
    ] as const) {
      const sql = `insert into ${schema}.${table}(value) values (:value::text) returning value`
      const parameter = (await project.analyze(sourcePath, `-- @bindNull value\n${sql}`)).parameters[0]
      assert.equal(parameter?.nullAdmission, 'unknown', table)
      assert.ok(
        parameter.nullAdmissionReasons.some(
          (reason) => reason.code === 'opaque_trigger' && reason.message.includes(trigger)
        )
      )
      assert.ok(!parameter.nullAdmissionReasons.some((reason) => reason.code === 'target_not_null'))
      await assert.rejects(
        project.compile(sourcePath, `-- @nullable value\n${sql}`),
        /@nullable value cannot be satisfied/u
      )
    }
    for (const table of ['plain_required', 'after_trigger', 'checked']) {
      const sql = `insert into ${schema}.${table}(value) values (:value::text)`
      const parameter = (await project.analyze(sourcePath, `-- @bindNull value\n${sql}`)).parameters[0]
      assert.equal(parameter?.nullAdmission, 'rejects', table)
    }
    const sql = `insert into ${schema}.before_rewrite(value) values (:value::text::${schema}.required_text)`
    const parameter = (await project.analyze(sourcePath, `-- @bindNull value\n${sql}`)).parameters[0]
    assert.equal(parameter?.nullAdmission, 'rejects')
    assert.ok(
      parameter.nullAdmissionReasons.some(
        (reason) => reason.code === 'domain_not_null' && reason.message.includes(`${schema}.required_text`)
      )
    )
    const targetSql = `insert into ${schema}.domain_target(value) values (:value::text)`
    const target = (await project.analyze(sourcePath, `-- @bindNull value\n${targetSql}`)).parameters[0]
    assert.equal(target?.nullAdmission, 'rejects')
    assert.ok(
      target.nullAdmissionReasons.some(
        (reason) => reason.code === 'domain_not_null' && reason.message.includes(`${schema}.required_text`)
      )
    )
  })

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
