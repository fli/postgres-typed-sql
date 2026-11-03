import probe from '../../../query.typed.sql'
export async function GET() {
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
  return Response.json({ row, query: captured })
}
