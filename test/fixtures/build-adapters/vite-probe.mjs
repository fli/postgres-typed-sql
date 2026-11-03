import { createServer } from 'vite'
import { writeFile } from 'node:fs/promises'
import { setTimeout as wait } from 'node:timers/promises'
import assert from 'node:assert/strict'
const server = await createServer({
  configFile: 'vitest.config.mjs',
  server: { watch: { usePolling: true, interval: 100 } },
})
const call = async () => {
  const mod = await server.ssrLoadModule('/query.typed.sql')
  return mod.default({ query: async (q) => ({ rows: [[q.values[0]]], rowCount: 1 }) }, { value: 'worked' })
}
try {
  await server.listen()
  await writeFile('query.typed.sql', 'select :value::text as display_name')
  await wait(1000)
  assert.deepEqual(await call(), { displayName: 'worked' })
  await writeFile('helper.mjs', "export default {resultColumns:'preserve'}")
  await wait(1000)
  assert.deepEqual(await call(), { display_name: 'worked' })
  await writeFile('query.typed.sql', 'select from')
  await wait(1000)
  await assert.rejects(call())
  await writeFile('query.typed.sql', 'select :value::text as changed')
  await wait(1000)
  assert.deepEqual(await call(), { changed: 'worked' })
  console.log('Vite SSR refresh and error recovery passed')
} finally {
  await server.close()
}
