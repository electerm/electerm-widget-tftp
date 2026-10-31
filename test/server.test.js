'use strict'

const test = require('node:test')
const assert = require('node:assert')
const dgram = require('node:dgram')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { TftpServer } = require('../lib/server')
const { OPCODE, ERROR_CODE, parse, ack } = require('../lib/packet')
const {
  createClient,
  buildRequest,
  readFile,
  writeFile
} = require('./helpers/client')

async function withServer (t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-tftp-'))
  const server = new TftpServer({ host: '127.0.0.1', port: 0, root, ...options })
  const port = await server.listen()
  t.after(async () => {
    await server.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { server, root, port }
}

// The client returns as soon as it has the last block, which is before the
// server has necessarily read the final ACK.
async function waitFor (check, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error('condition was not met in time')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function write (root, name, content) {
  const file = path.join(root, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  return file
}

test('reads a file in 512 byte blocks', async (t) => {
  const { root, port } = await withServer(t)
  const body = Buffer.alloc(1500)
  for (let i = 0; i < body.length; i++) {
    body[i] = i % 251
  }
  write(root, 'firmware.bin', body)

  const result = await readFile(port, 'firmware.bin')
  assert.deepEqual(result.content, body)
  assert.equal(result.blockSize, 512)
  // 1500 = 512 + 512 + 476, the short block is the end marker
  assert.equal(result.blocks, 3)
})

test('a file that is an exact multiple of the block size ends with an empty block', async (t) => {
  const { root, port } = await withServer(t)
  const body = Buffer.alloc(1024, 0x61)
  write(root, 'exact.bin', body)

  const result = await readFile(port, 'exact.bin')
  assert.deepEqual(result.content, body)
  assert.equal(result.blocks, 3, 'two full blocks plus the empty terminator')
})

test('reads an empty file as one empty block', async (t) => {
  const { root, port } = await withServer(t)
  write(root, 'empty.txt', '')

  const result = await readFile(port, 'empty.txt')
  assert.equal(result.content.length, 0)
  assert.equal(result.blocks, 1)
})

test('negotiates blksize (RFC 2348) and uses it for the transfer', async (t) => {
  const { root, port } = await withServer(t)
  const body = Buffer.alloc(3000, 0x62)
  write(root, 'big.bin', body)

  const result = await readFile(port, 'big.bin', { options: { blksize: 1024 } })
  assert.equal(result.options.blksize, '1024')
  assert.equal(result.blockSize, 1024)
  assert.equal(result.blocks, 3)
  assert.deepEqual(result.content, body)
})

test('clamps blksize to the configured maximum', async (t) => {
  const { root, port } = await withServer(t, { maxBlockSize: 600 })
  write(root, 'a.bin', Buffer.alloc(2000, 0x63))

  const result = await readFile(port, 'a.bin', { options: { blksize: 4096 } })
  assert.equal(result.options.blksize, '600')
  assert.equal(result.blockSize, 600)
  assert.equal(result.content.length, 2000)
})

test('answers tsize with the real size (RFC 2349)', async (t) => {
  const { root, port } = await withServer(t)
  write(root, 'sized.bin', Buffer.alloc(1234, 0x64))

  const result = await readFile(port, 'sized.bin', { options: { tsize: 0 } })
  assert.equal(result.options.tsize, '1234')
  assert.equal(result.content.length, 1234)
})

test('rejects an impossible blksize with error 8', async (t) => {
  const { root, port } = await withServer(t)
  write(root, 'a.bin', 'hello')

  await assert.rejects(
    readFile(port, 'a.bin', { options: { blksize: 4 } }),
    (err) => {
      assert.equal(err.tftpCode, ERROR_CODE.OPTION_NEGOTIATION)
      return true
    }
  )
})

test('missing file is error 1', async (t) => {
  const { port } = await withServer(t)
  await assert.rejects(readFile(port, 'nope.bin'), (err) => {
    assert.equal(err.tftpCode, ERROR_CODE.FILE_NOT_FOUND)
    return true
  })
})

test('refuses to leave the served folder', async (t) => {
  const { root, port } = await withServer(t)
  const outside = path.join(path.dirname(root), `secret-${Date.now()}.txt`)
  fs.writeFileSync(outside, 'top secret')
  t.after(() => fs.rmSync(outside, { force: true }))

  for (const name of ['../' + path.basename(outside), outside, 'a/../../x']) {
    await assert.rejects(readFile(port, name), (err) => {
      assert.equal(err.tftpCode, ERROR_CODE.ACCESS_VIOLATION, `${name} should be refused`)
      return true
    })
  }
})

test('refuses a symlink that points out of the served folder', async (t) => {
  const { root, port } = await withServer(t)
  const outside = path.join(os.tmpdir(), `electerm-tftp-outside-${Date.now()}.txt`)
  fs.writeFileSync(outside, 'top secret')
  t.after(() => fs.rmSync(outside, { force: true }))
  fs.symlinkSync(outside, path.join(root, 'link.txt'))

  await assert.rejects(readFile(port, 'link.txt'), (err) => {
    assert.equal(err.tftpCode, ERROR_CODE.ACCESS_VIOLATION)
    return true
  })
})

test('refuses a directory', async (t) => {
  const { root, port } = await withServer(t)
  fs.mkdirSync(path.join(root, 'sub'))
  await assert.rejects(readFile(port, 'sub'), (err) => {
    assert.equal(err.tftpCode, ERROR_CODE.ACCESS_VIOLATION)
    return true
  })
})

test('refuses an unsupported mode', async (t) => {
  const { root, port } = await withServer(t)
  write(root, 'a.txt', 'hi')
  await assert.rejects(readFile(port, 'a.txt', { mode: 'mail' }), (err) => {
    assert.equal(err.tftpCode, ERROR_CODE.NOT_DEFINED)
    return true
  })
})

test('uploads are refused while the server is read-only', async (t) => {
  const { root, port } = await withServer(t)
  await assert.rejects(writeFile(port, 'upload.bin', 'data'), (err) => {
    assert.equal(err.tftpCode, ERROR_CODE.ACCESS_VIOLATION)
    return true
  })
  assert.equal(fs.existsSync(path.join(root, 'upload.bin')), false)
})

test('stores an upload when writing is allowed', async (t) => {
  const { root, port } = await withServer(t, { allowWrite: true })
  const body = Buffer.alloc(2000)
  for (let i = 0; i < body.length; i++) {
    body[i] = i % 97
  }

  const result = await writeFile(port, 'received.bin', body)
  assert.equal(result.blocks, 4)
  assert.deepEqual(fs.readFileSync(path.join(root, 'received.bin')), body)
})

test('an upload with blksize lands byte for byte', async (t) => {
  const { root, port } = await withServer(t, { allowWrite: true })
  const body = Buffer.alloc(4096, 0x7a)

  const result = await writeFile(port, 'blk.bin', body, { options: { blksize: 1024 } })
  assert.equal(result.options.blksize, '1024')
  assert.equal(result.blocks, 5, 'four full blocks and the empty terminator')
  assert.deepEqual(fs.readFileSync(path.join(root, 'blk.bin')), body)
})

test('an upload to an existing name is refused unless overwrite is on', async (t) => {
  const { root, port } = await withServer(t, { allowWrite: true })
  write(root, 'exists.bin', 'original')

  await assert.rejects(writeFile(port, 'exists.bin', 'replacement'), (err) => {
    assert.equal(err.tftpCode, ERROR_CODE.FILE_EXISTS)
    return true
  })
  assert.equal(fs.readFileSync(path.join(root, 'exists.bin'), 'utf8'), 'original')
})

test('overwrite replaces the file', async (t) => {
  const { root, port } = await withServer(t, { allowWrite: true, overwrite: true })
  write(root, 'exists.bin', 'original')

  await writeFile(port, 'exists.bin', 'replacement')
  assert.equal(fs.readFileSync(path.join(root, 'exists.bin'), 'utf8'), 'replacement')
})

test('netascii read converts line endings', async (t) => {
  const { root, port } = await withServer(t)
  write(root, 'text.txt', 'a\nb\r\n')

  const result = await readFile(port, 'text.txt', { mode: 'netascii' })
  assert.equal(result.content.toString('latin1'), 'a\r\nb\r\x00\r\n')
})

test('netascii write converts line endings back', async (t) => {
  const { root, port } = await withServer(t, { allowWrite: true })

  await writeFile(port, 'text.txt', 'a\r\nb\r\x00', { mode: 'netascii' })
  // the last ACK is sent before the server has closed the file
  await waitFor(() => fs.existsSync(path.join(root, 'text.txt')))
  assert.equal(fs.readFileSync(path.join(root, 'text.txt'), 'latin1'), 'a\nb\r')
})

test('a packet from an unknown transfer id gets error 5 and the transfer survives', async (t) => {
  const { root, port } = await withServer(t)
  // two blocks, so the transfer is still open when the stranger speaks up
  const body = Buffer.alloc(600, 0x65)
  write(root, 'a.txt', body)

  const client = await createClient()
  t.after(() => client.close())
  client.send(buildRequest(OPCODE.RRQ, 'a.txt', 'octet'), port)
  const first = await client.next()
  const tid = first.rinfo.port
  const firstPacket = parse(first.msg)
  assert.equal(firstPacket.opcode, OPCODE.DATA)

  const stranger = dgram.createSocket('udp4')
  t.after(() => stranger.close())
  await new Promise((resolve) => stranger.bind(0, '127.0.0.1', resolve))
  const strangerSaw = new Promise((resolve) => stranger.on('message', (msg) => resolve(parse(msg))))
  stranger.send(ack(1), tid, '127.0.0.1')

  const reply = await strangerSaw
  assert.equal(reply.opcode, OPCODE.ERROR)
  assert.equal(reply.code, ERROR_CODE.UNKNOWN_TID)

  // the real client can still finish the transfer
  client.send(ack(1), tid)
  const last = parse((await client.next()).msg)
  assert.equal(last.opcode, OPCODE.DATA)
  assert.equal(last.block, 2)
  assert.equal(last.data.length, 600 - 512)
})

test('retransmits a lost block', async (t) => {
  const { root, port } = await withServer(t, { timeout: 0.3, retries: 2 })
  write(root, 'a.txt', Buffer.alloc(600, 0x66))

  const client = await createClient()
  t.after(() => client.close())
  client.send(buildRequest(OPCODE.RRQ, 'a.txt', 'octet'), port)

  const first = await client.next(1000)
  const tid = first.rinfo.port
  // do not ACK: the server has to send the same block again
  const again = await client.next(2000)
  assert.equal(again.rinfo.port, tid)
  const packet = parse(again.msg)
  assert.equal(packet.opcode, OPCODE.DATA)
  assert.equal(packet.block, 1)
  assert.equal(packet.data.length, 512)

  // acknowledging lets the transfer continue to its second block
  client.send(ack(1), tid)
  const second = parse((await client.next(1000)).msg)
  assert.equal(second.block, 2)
  assert.equal(second.data.length, 600 - 512)
})

test('reports status and counts transfers', async (t) => {
  const { server, root, port } = await withServer(t)
  write(root, 'a.txt', 'hello')
  await readFile(port, 'a.txt')

  await waitFor(() => server.getStatus().activeTransfers === 0)
  const status = server.getStatus()
  assert.equal(status.running, true)
  assert.equal(status.port, port)
  assert.equal(status.readOnly, true)
  assert.equal(status.transfers, 1)
  assert.equal(status.sent, 5)
  assert.equal(status.activeTransfers, 0)
})

test('stop() closes the socket', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-tftp-'))
  const server = new TftpServer({ host: '127.0.0.1', port: 0, root })
  const port = await server.listen()
  await server.close()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  await assert.rejects(readFile(port, 'a.txt', { timeoutMs: 500 }))
})

test('a busy port is reported, not swallowed', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-tftp-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const first = new TftpServer({ host: '127.0.0.1', port: 0, root })
  const port = await first.listen()
  t.after(() => first.close())

  const second = new TftpServer({ host: '127.0.0.1', port, root })
  await assert.rejects(second.listen(), (err) => {
    assert.equal(err.code, 'EADDRINUSE')
    return true
  })
})
