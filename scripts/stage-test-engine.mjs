import { cp, mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

const projectRoot = resolve(import.meta.dirname, '..')
const target = resolve(projectRoot, 'dist-test/src/vendor')
await rm(target, { force: true, recursive: true })
await mkdir(resolve(target, '..'), { recursive: true })
await cp(resolve(projectRoot, 'dist/vendor'), target, { recursive: true })
await cp(resolve(projectRoot, 'test/fixtures'), resolve(projectRoot, 'dist-test/test/fixtures'), {
  recursive: true,
})
