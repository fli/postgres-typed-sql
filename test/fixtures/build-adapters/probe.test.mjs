import { expect, test } from 'vitest'
import probe from './query.typed.sql'
test('executes the SQL query', async () => {
  let captured
  const row = await probe(
    {
      query: async (q) => {
        captured = q
        return { rows: [[q.values[0]]], rowCount: 1 }
      },
    },
    { value: 'worked' }
  )
  expect(row).toEqual({ changed: 'worked' })
  expect(captured.values).toEqual(['worked'])
  expect(captured.text).toBe('select $1::text as changed')
})
