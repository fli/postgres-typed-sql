import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

const script = resolve('scripts/package-receipt.mjs')
const commit = 'a'.repeat(40)
const metadata = JSON.parse(readFileSync('package.json', 'utf8'))

test('package receipt binds the tested tarball, commit, and package version', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'package-receipt-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const pack = join(root, 'packs')
  const source = join(root, 'package')
  mkdirSync(pack)
  mkdirSync(source)
  const tarball = join(pack, 'package.tgz')
  const makePack = (version = metadata.version, extra = '') => {
    writeFileSync(join(source, 'package.json'), JSON.stringify({ name: metadata.name, version }))
    writeFileSync(join(source, 'extra'), extra)
    execFileSync('tar', ['-czf', tarball, '-C', root, 'package'])
  }
  const run = (mode, sha = commit) => spawnSync(process.execPath, [script, mode, pack, sha], { encoding: 'utf8' })
  makePack()
  assert.equal(run('create').status, 0)
  assert.equal(run('verify').stdout, tarball)
  assert.notEqual(run('verify', 'b'.repeat(40)).status, 0)
  const receiptPath = join(pack, 'receipt.json')
  const originalReceipt = readFileSync(receiptPath, 'utf8')
  const tamperedReceipt = JSON.parse(originalReceipt)
  tamperedReceipt.version = '0.0.0'
  writeFileSync(receiptPath, JSON.stringify(tamperedReceipt))
  assert.notEqual(run('verify').status, 0)
  writeFileSync(receiptPath, originalReceipt)
  makePack(metadata.version, 'modified after validation')
  assert.notEqual(run('verify').status, 0)
  makePack('0.0.0')
  assert.notEqual(run('verify').status, 0)
  makePack()
  writeFileSync(join(pack, 'second.tgz'), '')
  assert.notEqual(run('verify').status, 0)
  rmSync(join(pack, 'second.tgz'))
  rmSync(tarball)
  assert.notEqual(run('verify').status, 0)
})
