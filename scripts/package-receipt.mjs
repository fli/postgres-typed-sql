import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { URL } from 'node:url'

const [mode, directoryArg, commit] = process.argv.slice(2)
if (!['create', 'verify'].includes(mode) || !directoryArg || !/^[a-f0-9]{40}$/.test(commit ?? '')) {
  throw new Error('Usage: node scripts/package-receipt.mjs <create|verify> <directory> <commit-sha>')
}
const directory = resolve(directoryArg)
const packs = readdirSync(directory).filter((name) => name.endsWith('.tgz'))
if (packs.length !== 1) throw new Error('Expected exactly one package tarball')
const filename = packs[0]
const tarball = join(directory, filename)
const files = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).trim().split('\n')
if (files.filter((name) => name === 'package/package.json').length !== 1) {
  throw new Error('Expected exactly one package/package.json in tarball')
}
const metadata = JSON.parse(execFileSync('tar', ['-xOzf', tarball, 'package/package.json'], { encoding: 'utf8' }))
const expected = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
if (metadata.name !== expected.name || metadata.version !== expected.version) {
  throw new Error('Tarball package name or version does not match checkout')
}
const receipt = {
  commit,
  name: metadata.name,
  version: metadata.version,
  filename: basename(filename),
  sha256: createHash('sha256').update(readFileSync(tarball)).digest('hex'),
}
const receiptPath = join(directory, 'receipt.json')
if (mode === 'create') {
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
} else {
  const recorded = JSON.parse(readFileSync(receiptPath, 'utf8'))
  for (const [key, value] of Object.entries(receipt)) {
    if (recorded[key] !== value) throw new Error(`Package receipt mismatch: ${key}`)
  }
  process.stdout.write(tarball)
}
