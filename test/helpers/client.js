'use strict'

/**
 * A minimal TFTP client, only as capable as the tests need.
 *
 * Written here rather than shelling out to `tftp`/`curl` because the interesting
 * cases are protocol-level — the empty final block, an OACK handshake, an ACK
 * arriving from a third party — and a real client hides exactly those. The end
 * to end check with the system clients is a separate script (see README).
 */

const dgram = require('dgram')
const { OPCODE, parse, data, ack, error, oack } = require('../../lib/packet')

function buildRequest (opcode, filename, mode, options) {
  const parts = [
    Buffer.from([0, opcode]),
    Buffer.from(filename, 'utf8'),
    Buffer.from([0]),
    Buffer.from(mode || 'octet', 'utf8'),
    Buffer.from([0])
  ]
  for (const [name, value] of Object.entries(options || {})) {
    parts.push(Buffer.from(name, 'utf8'), Buffer.from([0]))
    parts.push(Buffer.from(String(value), 'utf8'), Buffer.from([0]))
  }
  return Buffer.concat(parts)
}

class Client {
  constructor () {
    this.socket = dgram.createSocket('udp4')
    this.inbox = []
    this.waiter = null
    this.tid = null
    this.closed = false
  }

  async bind () {
    await new Promise((resolve, reject) => {
      this.socket.once('error', reject)
      this.socket.bind(0, '127.0.0.1', () => {
        this.socket.removeListener('error', reject)
        this.socket.on('message', (msg, rinfo) => {
          const packet = { msg, rinfo }
          if (this.waiter) {
            const resolveWaiter = this.waiter
            this.waiter = null
            resolveWaiter(packet)
          } else {
            this.inbox.push(packet)
          }
        })
        this.socket.on('error', () => {})
        resolve()
      })
    })
    return this
  }

  get port () {
    return this.socket.address().port
  }

  // Queued through a promise chain: the last ACK of a transfer is sent and the
  // client closed in the same tick, and closing the socket before the datagram
  // has left drops it — which looks exactly like a server that never finished.
  send (buf, port, address) {
    this.outbox = (this.outbox || Promise.resolve()).then(() => new Promise((resolve) => {
      this.socket.send(buf, port, address || '127.0.0.1', () => resolve())
    }))
    return this.outbox
  }

  next (timeoutMs = 2000) {
    if (this.inbox.length) {
      return Promise.resolve(this.inbox.shift())
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null
        reject(new Error(`client timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.waiter = (packet) => {
        clearTimeout(timer)
        resolve(packet)
      }
    })
  }

  async close () {
    if (this.closed) {
      return
    }
    this.closed = true
    try {
      await this.outbox
    } catch (e) {}
    try {
      this.socket.close()
    } catch (e) {}
  }
}

async function createClient () {
  const client = new Client()
  await client.bind()
  return client
}

/**
 * Read one file. Returns { content, blocks, blockSize, options }.
 * Throws with `tftpCode` set when the server answers with ERROR.
 */
async function readFile (port, filename, options = {}) {
  const client = await createClient()
  try {
    client.send(
      buildRequest(OPCODE.RRQ, filename, options.mode, options.options),
      port
    )
    let blockSize = 512
    let expected = 1
    let tid = null
    const chunks = []
    let blocks = 0
    let accepted = null

    for (;;) {
      const { msg, rinfo } = await client.next(options.timeoutMs)
      const packet = parse(msg)
      if (!tid) {
        tid = rinfo.port
      } else if (rinfo.port !== tid) {
        throw new Error(`reply from an unexpected port: ${rinfo.port} (transfer is on ${tid})`)
      }
      if (packet.opcode === OPCODE.ERROR) {
        const err = new Error(packet.message)
        err.tftpCode = packet.code
        throw err
      }
      if (packet.opcode === OPCODE.OACK) {
        accepted = packet.options
        if (accepted.blksize) {
          blockSize = Number(accepted.blksize)
        }
        client.send(ack(0), tid)
        continue
      }
      if (packet.opcode !== OPCODE.DATA) {
        continue
      }
      if (packet.block !== expected) {
        throw new Error(`expected block ${expected}, got ${packet.block}`)
      }
      chunks.push(Buffer.from(packet.data))
      blocks++
      client.send(ack(packet.block), tid)
      expected = (expected + 1) % 0x10000
      if (packet.data.length < blockSize) {
        return {
          content: Buffer.concat(chunks),
          blocks,
          blockSize,
          options: accepted,
          tid
        }
      }
    }
  } finally {
    await client.close()
  }
}

/**
 * Write one file. Returns { blocks, blockSize, options }.
 */
async function writeFile (port, filename, content, options = {}) {
  const client = await createClient()
  try {
    const body = Buffer.isBuffer(content) ? content : Buffer.from(content)
    client.send(
      buildRequest(OPCODE.WRQ, filename, options.mode, options.options),
      port
    )
    let blockSize = 512
    let tid = null
    let accepted = null

    // the first reply is either OACK or ACK(0)
    const first = await client.next(options.timeoutMs)
    tid = first.rinfo.port
    const firstPacket = parse(first.msg)
    if (firstPacket.opcode === OPCODE.ERROR) {
      const err = new Error(firstPacket.message)
      err.tftpCode = firstPacket.code
      throw err
    }
    if (firstPacket.opcode === OPCODE.OACK) {
      accepted = firstPacket.options
      if (accepted.blksize) {
        blockSize = Number(accepted.blksize)
      }
    } else if (firstPacket.opcode !== OPCODE.ACK || firstPacket.block !== 0) {
      throw new Error(`unexpected first reply: ${JSON.stringify(firstPacket)}`)
    }

    let offset = 0
    let block = 1
    let blocks = 0
    for (;;) {
      const payload = body.subarray(offset, offset + blockSize)
      client.send(data(block, payload), tid)
      const reply = await client.next(options.timeoutMs)
      const packet = parse(reply.msg)
      if (packet.opcode === OPCODE.ERROR) {
        const err = new Error(packet.message)
        err.tftpCode = packet.code
        throw err
      }
      if (packet.opcode !== OPCODE.ACK || packet.block !== block) {
        throw new Error(`expected ACK ${block}, got ${JSON.stringify(packet)}`)
      }
      blocks++
      offset += payload.length
      if (payload.length < blockSize) {
        return { blocks, blockSize, options: accepted, tid }
      }
      block = (block + 1) % 0x10000
    }
  } finally {
    await client.close()
  }
}

module.exports = {
  createClient,
  buildRequest,
  readFile,
  writeFile,
  OPCODE,
  parse,
  ack,
  data,
  error,
  oack
}
