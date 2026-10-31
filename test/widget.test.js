'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { widgetRun } = require('../index')
const manifest = require('../package.json')
const { readFile } = require('./helpers/client')

const CONFIG_TYPES = ['string', 'textarea', 'number', 'boolean', 'password', 'file', 'directory', 'select']

function tempDir (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-tftp-widget-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('the manifest is a widget the host can list', () => {
  const conf = manifest.electerm
  assert.ok(conf, 'package.json needs an electerm block')
  assert.match(conf.id, /^[a-z0-9-]+$/)
  assert.equal(conf.type, 'instance')
  assert.equal(manifest.main, 'index.js')
  assert.ok(conf.name)
  assert.ok(conf.description)

  const names = new Set()
  for (const config of conf.configs) {
    assert.ok(config.name, 'every config needs a name')
    assert.equal(names.has(config.name), false, `duplicate config ${config.name}`)
    names.add(config.name)
    assert.ok(CONFIG_TYPES.includes(config.type), `unknown config type ${config.type}`)
    assert.ok('default' in config, `${config.name} needs a default`)
    assert.ok(config.label, `${config.name} needs a label`)
  }
  // the host looks for autoRun in the widget's own configs to offer autostart
  assert.ok(names.has('autoRun'))
})

test('start() serves the configured folder and reports where', async (t) => {
  const dir = tempDir(t)
  fs.writeFileSync(path.join(dir, 'firmware.bin'), 'boot image')
  const instance = widgetRun({ host: '127.0.0.1', port: 0, directory: dir })
  t.after(() => instance.stop())

  const result = await instance.start()
  assert.equal(result.success, true)
  assert.equal(result.serverInfo.path, dir)
  assert.match(result.serverInfo.url, /^tftp:\/\//)
  assert.ok(result.serverInfo.url.endsWith(`:${result.serverInfo.port}`))

  const read = await readFile(result.serverInfo.port, 'firmware.bin')
  assert.equal(read.content.toString(), 'boot image')
  assert.equal(instance.getStatus().running, true)
})

test('start() creates the served folder when it does not exist', async (t) => {
  const dir = tempDir(t)
  const target = path.join(dir, 'nested', 'tftp')
  const logs = []
  const instance = widgetRun(
    { host: '127.0.0.1', port: 0, directory: target },
    { log: (...args) => logs.push(args.join(' ')) }
  )
  t.after(() => instance.stop())

  await instance.start()
  assert.equal(fs.statSync(target).isDirectory(), true)
  assert.ok(logs.some(line => line.includes('created the served folder')))
})

test('start() twice is refused', async (t) => {
  const dir = tempDir(t)
  const instance = widgetRun({ host: '127.0.0.1', port: 0, directory: dir })
  t.after(() => instance.stop())

  await instance.start()
  await assert.rejects(instance.start(), /already running/)
})

test('a busy port is reported in words a user can act on', async (t) => {
  const dir = tempDir(t)
  const first = widgetRun({ host: '127.0.0.1', port: 0, directory: dir })
  t.after(() => first.stop())
  const { serverInfo } = await first.start()

  const second = widgetRun({ host: '127.0.0.1', port: serverInfo.port, directory: dir })
  await assert.rejects(second.start(), (err) => {
    assert.match(err.message, /already in use/)
    assert.match(err.message, new RegExp(String(serverInfo.port)))
    return true
  })
})

test('stop() shuts the server down and is safe to call twice', async (t) => {
  const dir = tempDir(t)
  const instance = widgetRun({ host: '127.0.0.1', port: 0, directory: dir })
  const { serverInfo } = await instance.start()

  await instance.stop()
  assert.equal(instance.getStatus().running, false)
  await instance.stop()
  await assert.rejects(readFile(serverInfo.port, 'x', { timeoutMs: 300 }))
})

test('a transfer is reported to the instance log', async (t) => {
  const dir = tempDir(t)
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello')
  const events = []
  const instance = widgetRun(
    { host: '127.0.0.1', port: 0, directory: dir },
    { event: (event) => events.push(event) }
  )
  t.after(() => instance.stop())

  const { serverInfo } = await instance.start()
  await readFile(serverInfo.port, 'a.txt')
  // the transfer is recorded when it completes, just after the last ACK
  const deadline = Date.now() + 2000
  while (!events.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'read')
  assert.equal(events[0].ok, true)
  assert.match(events[0].msg, /a\.txt/)
})

test('a refused transfer is reported as a failure', async (t) => {
  const dir = tempDir(t)
  const events = []
  const instance = widgetRun(
    { host: '127.0.0.1', port: 0, directory: dir },
    { event: (event) => events.push(event) }
  )
  t.after(() => instance.stop())

  const { serverInfo } = await instance.start()
  await assert.rejects(readFile(serverInfo.port, 'missing.bin'))
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'refused')
  assert.equal(events[0].ok, false)
})
