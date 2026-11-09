import naming from './helper.mjs'
export default {
  schema: 'schema.sql',
  naming,
  imports: { runtime: 'postgres-typed-sql/adapters/node-postgres', scalars: 'postgres-typed-sql/scalars' },
}
