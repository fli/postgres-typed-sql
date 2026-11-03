import { writeFile } from 'node:fs/promises'
import { setTimeout as wait } from 'node:timers/promises'
import assert from 'node:assert/strict'
async function until(check) {
  let last
  for (let i = 0; i < 50; i++) {
    await wait(300)
    try {
      const response = await fetch('http://localhost:3992/api/probe')
      last = { status: response.status, body: await response.text() }
      if (check(last)) return last
    } catch (error) {
      last = error
    }
  }
  throw new Error(`Timed out: ${JSON.stringify(last)}`)
}
await writeFile('helper.mjs', "export default {resultColumns:'preserve'}")
await writeFile('query.typed.sql', 'select :value::text as display_name')
await until(({ status, body }) => status === 200 && body.includes('"display_name":"worked"'))
await writeFile('helper.mjs', "export default {resultColumns:'camelCase'}")
await until(({ status, body }) => status === 200 && body.includes('displayName'))
await writeFile('query.typed.sql', 'select display_name from widget where id = :value')
let result = await until(
  ({ status, body }) => status === 200 && body.includes('from widget') && !body.includes('"row":[')
)
assert.equal(JSON.parse(result.body).row.displayName, 'worked')
await writeFile('schema.sql', 'create table widget (id text, display_name text);')
result = await until(({ status, body }) => status === 200 && body.includes('"row":['))
assert.equal(JSON.parse(result.body).row[0].displayName, 'worked')
await writeFile('query.typed.sql', 'select from')
await until(({ status }) => status === 500)
await writeFile('query.typed.sql', 'select :value::text as changed')
await until(({ status, body }) => status === 200 && body.includes('"changed":"worked"'))
console.log('Next dev SQL, helper, schema refresh and error recovery passed')
