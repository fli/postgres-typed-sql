import { postgresTypedSql } from 'postgres-typed-sql/vite'
export default { plugins: [postgresTypedSql({ config: './config.mjs' })], test: { include: ['probe.test.mjs'] } }
