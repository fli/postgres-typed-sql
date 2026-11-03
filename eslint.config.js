import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['artifacts/**', 'dist/**', 'dist-test/**', 'node_modules/**', 'source/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.cjs'],
    languageOptions: { globals: { module: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly' } },
  },
  {
    files: ['test/fixtures/build-adapters/**/*.{js,mjs}'],
    languageOptions: { globals: { console: 'readonly', fetch: 'readonly', Response: 'readonly' } },
  },
  {
    languageOptions: {
      globals: {
        process: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
    },
  }
)
