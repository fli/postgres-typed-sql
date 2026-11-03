import { createRequire } from 'node:module'
import { resolve } from 'node:path'
const require = createRequire(import.meta.url)
const loader = require.resolve('postgres-typed-sql/turbopack-loader')
const options = { config: resolve('config.mjs') }
export default {
  webpack(config) {
    config.module.rules.push({ test: /\.typed\.sql$/, use: [{ loader, options }] })
    return config
  },
  turbopack: {
    root: process.env.TEST_TURBOPACK_ROOT ?? process.cwd(),
    rules: {
      '*.typed.sql': {
        loaders: [
          {
            loader,
            options,
          },
        ],
        as: '*.js',
      },
    },
  },
}
