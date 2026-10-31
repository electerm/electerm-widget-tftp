'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  PathError,
  isInside,
  resolveInRoot,
  assertRealPathInside
} = require('../lib/safe-path')

function tempRoot (t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-tftp-path-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

test('resolves a plain name inside the root', () => {
  const root = '/srv/tftp'
  assert.equal(resolveInRoot(root, 'firmware.bin'), path.resolve(root, 'firmware.bin'))
  assert.equal(resolveInRoot(root, 'dir/file.bin'), path.resolve(root, 'dir/file.bin'))
})

test('refuses to climb out of the root', () => {
  for (const name of ['../etc/passwd', 'a/../../b', '..', './../x']) {
    assert.throws(() => resolveInRoot('/srv/tftp', name), PathError, name)
  }
})

test('refuses absolute paths', () => {
  for (const name of ['/etc/passwd', '\\\\server\\share', 'C:\\Windows\\win.ini']) {
    assert.throws(() => resolveInRoot('/srv/tftp', name), PathError, name)
  }
})

test('accepts a Windows style relative path and treats the backslash as a separator', () => {
  const resolved = resolveInRoot('/srv/tftp', 'dir\\file.bin')
  assert.equal(resolved, path.resolve('/srv/tftp/dir/file.bin'))
})

test('refuses an empty name or one with a NUL byte', () => {
  assert.throws(() => resolveInRoot('/srv/tftp', ''), PathError)
  assert.throws(() => resolveInRoot('/srv/tftp', 'a\0b'), PathError)
  assert.throws(() => resolveInRoot('/srv/tftp', '   '), PathError)
})

test('isInside is not fooled by a sibling with a common prefix', () => {
  assert.equal(isInside('/srv/tftp', '/srv/tftp/a'), true)
  assert.equal(isInside('/srv/tftp', '/srv/tftp'), true)
  assert.equal(isInside('/srv/tftp', '/srv/tftp-evil/a'), false)
  assert.equal(isInside('/srv/tftp', '/srv'), false)
})

test('assertRealPathInside accepts a real file in the root', (t) => {
  const root = tempRoot(t)
  const file = path.join(root, 'a.txt')
  fs.writeFileSync(file, 'x')
  assert.doesNotThrow(() => assertRealPathInside(root, file))
})

test('assertRealPathInside refuses a symlink that points outside', (t) => {
  const root = tempRoot(t)
  const outside = path.join(os.tmpdir(), `electerm-tftp-out-${Date.now()}.txt`)
  fs.writeFileSync(outside, 'secret')
  t.after(() => fs.rmSync(outside, { force: true }))
  const link = path.join(root, 'link.txt')
  fs.symlinkSync(outside, link)
  assert.throws(() => assertRealPathInside(root, link), PathError)
})

test('assertRealPathInside checks the parent of a file that does not exist yet', (t) => {
  const root = tempRoot(t)
  assert.doesNotThrow(() => assertRealPathInside(root, path.join(root, 'new.txt')))

  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-tftp-outdir-'))
  t.after(() => fs.rmSync(outsideDir, { recursive: true, force: true }))
  const link = path.join(root, 'escape')
  fs.symlinkSync(outsideDir, link)
  assert.throws(() => assertRealPathInside(root, path.join(link, 'new.txt')), PathError)
})
