import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'

const forbidden = String.fromCharCode(100, 114, 105, 97, 104)
const listed = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
  encoding: 'buffer',
})
if (listed.status !== 0) {
  throw new Error(listed.stderr.toString('utf8'))
}

const paths = listed.stdout.toString('utf8').split('\0').filter(Boolean)

const violations = []
for (const path of paths) {
  if (path.toLowerCase().includes(forbidden)) {
    violations.push(path)
    continue
  }
  const contents = await readFile(path)
  if (contents.includes(0)) {
    continue
  }
  if (contents.toString('utf8').toLowerCase().includes(forbidden)) {
    violations.push(path)
  }
}

if (violations.length > 0) {
  throw new Error(`Independence scan failed:\n${violations.join('\n')}`)
}
