'use strict'

/**
 * A TFTP server (RFC 1350) with the option extension of RFC 2347/2348/2349.
 *
 * The shape of TFTP is what makes it awkward to implement: one request per
 * datagram on a well known port, then the whole transfer moves to a fresh
 * ephemeral port ("TID") — the reply comes from a socket the client has never
 * seen, which is why a naive implementation that answers from the listening
 * socket confuses strict clients. Every packet is acknowledged, there is no
 * window, and a lost packet is retransmitted on a timer, so both sides are
 * small state machines with a timeout and a retry budget.
 *
 * One class per transfer keeps the state where it belongs: the block counter,
 * the timer, the retry count and the open file handle. The server only routes
 * the first packet and keeps the list.
 */

const dgram = require('dgram')
const fs = require('fs')
const net = require('net')
const path = require('path')
const { finished } = require('stream/promises')
const {
  OPCODE,
  ERROR_CODE,
  BLOCK_MOD,
  parse,
  nextBlock,
  previousBlock,
  data: dataPacket,
  ack: ackPacket,
  error: errorPacket,
  oack: oackPacket
} = require('./packet')
const {
  resolveInRoot,
  assertRealPathInside
} = require('./safe-path')
const BlockReader = require('./block-reader')
const { NetasciiEncode, NetasciiDecode } = require('./netascii')

const DEFAULTS = {
  host: '0.0.0.0',
  port: 6969,
  root: process.cwd(),
  allowWrite: false,
  overwrite: false,
  // 1468 keeps a DATA packet inside a 1500 byte MTU; the client may ask for
  // less, never for more than this
  maxBlockSize: 1468,
  // seconds, and how many retransmissions before a transfer is abandoned
  timeout: 3,
  retries: 5
}

const MAX_BLOCK_SIZE = 65464

class TimeoutError extends Error {
  constructor (message) {
    super(message || 'timeout')
    this.name = 'TimeoutError'
  }
}

class PeerError extends Error {
  constructor (code, message) {
    super(`client error ${code}: ${message}`)
    this.name = 'PeerError'
    this.tftpCode = code
  }
}

function sameAddress (a, b) {
  const strip = (value) => String(value || '').replace(/^::ffff:/i, '')
  return strip(a) === strip(b)
}

// A transfer socket has to be bound on the same family as the client, and the
// IPv4 wildcard is not a legal address on an IPv6 socket (or the other way
// round), so a wildcard bind follows the family instead of the config value.
function wildcardFor (family, host) {
  if (host === '0.0.0.0' || host === '::') {
    return family === 'udp6' ? '::' : '0.0.0.0'
  }
  return host
}

function normalizeOptions (options) {
  const res = { ...DEFAULTS, ...(options || {}) }
  res.port = Number(res.port)
  if (!Number.isInteger(res.port) || res.port < 0 || res.port > 65535) {
    throw new Error(`invalid port: ${options && options.port}`)
  }
  res.maxBlockSize = Math.min(Math.max(Number(res.maxBlockSize) || 1468, 8), MAX_BLOCK_SIZE)
  res.timeout = Math.max(Number(res.timeout) || 3, 0.2)
  res.retries = Math.min(Math.max(Number.isInteger(res.retries) ? res.retries : 5, 0), 20)
  res.root = path.resolve(String(res.root || process.cwd()))
  res.allowWrite = !!res.allowWrite
  res.overwrite = !!res.overwrite
  return res
}

class Transfer {
  constructor (server, rinfo, request) {
    this.server = server
    this.client = {
      address: rinfo.address,
      port: rinfo.port
    }
    this.key = `${rinfo.address}:${rinfo.port}`
    this.request = request
    this.socket = null
    this.blockSize = 512
    this.timeoutMs = server.options.timeout * 1000
    this.bytes = 0
    this.blocks = 0
    this.startedAt = Date.now()
    this.finished = false
    this.pending = null
  }

  get options () {
    return this.server.options
  }

  get label () {
    return `${this.request.mode} "${this.request.filename}"`
  }

  log (level, ...args) {
    this.server.log(level, `[${this.key}]`, ...args)
  }

  event (payload) {
    this.server.event({ from: this.key, ...payload })
  }

  async start () {
    const family = net.isIPv6(this.client.address) ? 'udp6' : 'udp4'
    const socket = dgram.createSocket(family)
    this.socket = socket
    await new Promise((resolve, reject) => {
      const onError = (err) => {
        socket.close()
        reject(err)
      }
      socket.once('error', onError)
      // Port 0: the OS picks the TID. Binding to the configured host keeps the
      // source address of the reply on the interface the client reached.
      socket.bind(0, wildcardFor(family, this.options.host), () => {
        socket.removeListener('error', onError)
        resolve()
      })
    })
    socket.on('error', (err) => {
      this.log('error', `socket error: ${err.message}`)
      this.abort()
    })

    this.log('debug', `transfer on port ${socket.address().port}`)

    if (this.request.opcode === OPCODE.RRQ) {
      return this.serveRead()
    }
    return this.serveWrite()
  }

  async serveRead () {
    const { request } = this
    if (!(await this.checkMode())) {
      return
    }
    let filePath
    try {
      filePath = resolveInRoot(this.options.root, request.filename)
      assertRealPathInside(this.options.root, filePath)
    } catch (err) {
      return this.refuse(ERROR_CODE.ACCESS_VIOLATION, err.message)
    }

    let stat
    try {
      stat = await fs.promises.stat(filePath)
    } catch (err) {
      const code = err.code === 'EACCES' || err.code === 'EPERM'
        ? ERROR_CODE.ACCESS_VIOLATION
        : ERROR_CODE.FILE_NOT_FOUND
      return this.refuse(code, `${request.filename}: ${err.code || err.message}`)
    }
    if (!stat.isFile()) {
      return this.refuse(ERROR_CODE.ACCESS_VIOLATION, `${request.filename} is not a regular file`)
    }

    const negotiation = this.negotiate({ tsize: stat.size })
    if (negotiation.error) {
      return this.refuse(ERROR_CODE.OPTION_NEGOTIATION, negotiation.error)
    }
    if (Object.keys(negotiation.accepted).length) {
      await this.exchange(oackPacket(negotiation.accepted), 0)
    }

    const fileStream = fs.createReadStream(filePath)
    const body = request.mode === 'netascii'
      ? fileStream.pipe(new NetasciiEncode())
      : fileStream
    // a source error is not forwarded by pipe(): without this the reader waits
    // forever on a stream that has already died
    const onFileError = (err) => body.destroy(err)
    fileStream.on('error', onFileError)
    const reader = new BlockReader(body, this.blockSize)

    this.log('info', `sending ${stat.size} bytes, ${this.blockSize} byte blocks`)
    let block = 0
    try {
      for (;;) {
        const payload = await reader.next()
        block = nextBlock(block)
        await this.exchange(dataPacket(block, payload), block)
        this.bytes += payload.length
        this.blocks++
        if (payload.length < this.blockSize) {
          break
        }
      }
    } finally {
      // the reader owns the transform, the transform does not own the file:
      // both have to go, or the handle outlives the transfer
      await reader.close()
      fileStream.destroy()
      fileStream.removeListener('error', onFileError)
    }
    this.event({
      type: 'read',
      ok: true,
      msg: `sent ${request.filename} (${this.bytes} bytes, ${this.blocks} blocks, ${this.blockSize} byte blocks)`
    })
  }

  async serveWrite () {
    const { request } = this
    if (!(await this.checkMode())) {
      return
    }
    if (!this.options.allowWrite) {
      return this.refuse(ERROR_CODE.ACCESS_VIOLATION, 'this server is read-only')
    }
    let filePath
    try {
      filePath = resolveInRoot(this.options.root, request.filename)
      assertRealPathInside(this.options.root, filePath)
    } catch (err) {
      return this.refuse(ERROR_CODE.ACCESS_VIOLATION, err.message)
    }

    const dir = path.dirname(filePath)
    try {
      const stat = await fs.promises.stat(dir)
      if (!stat.isDirectory()) {
        return this.refuse(ERROR_CODE.ACCESS_VIOLATION, `${dir} is not a folder`)
      }
    } catch (err) {
      return this.refuse(ERROR_CODE.ACCESS_VIOLATION, `no such folder: ${dir}`)
    }

    let exists = true
    try {
      await fs.promises.access(filePath)
    } catch (err) {
      exists = false
    }
    if (exists && !this.options.overwrite) {
      return this.refuse(ERROR_CODE.FILE_EXISTS, `${request.filename} already exists`)
    }

    const negotiation = this.negotiate({})
    if (negotiation.error) {
      return this.refuse(ERROR_CODE.OPTION_NEGOTIATION, negotiation.error)
    }

    const fileStream = fs.createWriteStream(filePath, {
      // `wx` makes the exists check above atomic: two clients racing for the
      // same name cannot both create it
      flags: this.options.overwrite ? 'w' : 'wx'
    })
    const sink = request.mode === 'netascii' ? new NetasciiDecode() : null
    if (sink) {
      sink.pipe(fileStream)
    }
    // Resolves once the file is closed, rejects when the write fails (a full
    // disk, a read-only volume). Caught immediately so a failure surfacing
    // while the receive loop is still running is not an unhandled rejection.
    const stored = finished(fileStream)
    stored.catch(() => {})

    const write = (payload) => new Promise((resolve, reject) => {
      const target = sink || fileStream
      target.write(payload, (err) => (err ? reject(err) : resolve()))
    })

    let pending = null
    try {
      if (Object.keys(negotiation.accepted).length) {
        // RFC 2347: the client acknowledges the OACK with ACK(0). Not every
        // client does — some start sending DATA(1) straight away — so that
        // packet is taken as the acknowledgement rather than dropped and
        // waited out on the retransmit timer.
        pending = await this.openWrite(oackPacket(negotiation.accepted))
      } else {
        this.send(ackPacket(0))
      }

      this.log('info', `receiving ${request.filename}, ${this.blockSize} byte blocks`)
      let expected = 1
      let idle = 0
      for (;;) {
        let packet = pending
        pending = null
        if (!packet) {
          let buf
          try {
            buf = await this.receive()
          } catch (err) {
            if (err instanceof TimeoutError) {
              if (++idle > this.options.retries) {
                throw new TimeoutError('client stopped sending')
              }
              continue
            }
            throw err
          }
          idle = 0
          packet = this.parseOrNull(buf)
        }
        if (!packet) {
          continue
        }
        if (packet.opcode === OPCODE.ERROR) {
          throw new PeerError(packet.code, packet.message)
        }
        if (packet.opcode !== OPCODE.DATA) {
          continue
        }
        if (packet.block === previousBlock(expected)) {
          // our ACK was lost; re-send it and do not write the block twice
          this.send(ackPacket(packet.block))
          continue
        }
        if (packet.block !== expected) {
          this.log('debug', `unexpected block ${packet.block}, expected ${expected}`)
          continue
        }
        await write(packet.data)
        this.bytes += packet.data.length
        this.blocks++
        // ACK only after the bytes are handed to the file, so a client that
        // moves on has actually been stored
        this.send(ackPacket(packet.block))
        expected = nextBlock(expected)
        if (packet.data.length < this.blockSize) {
          break
        }
      }
      // one owner for the end: the pipe closes the file when the decoder ends,
      // and calling end() on the file stream as well is what breaks it
      if (sink) {
        sink.end()
      } else {
        fileStream.end()
      }
      await stored
      this.event({
        type: 'write',
        ok: true,
        msg: `stored ${request.filename} (${this.bytes} bytes, ${this.blocks} blocks)`
      })
    } catch (err) {
      if (sink) {
        sink.destroy()
      }
      fileStream.destroy()
      // a failed upload must not leave half a file behind pretending to be one
      try {
        fs.unlinkSync(filePath)
      } catch (e) {}
      // tell the client why, instead of letting it retransmit into a timeout
      if (!(err instanceof PeerError)) {
        const code = err.code === 'ENOSPC'
          ? ERROR_CODE.DISK_FULL
          : ERROR_CODE.NOT_DEFINED
        await this.sendTo(errorPacket(code, err.message), this.client)
      }
      throw err
    }
  }

  // Awaited, not fire-and-forget: `refuse` sends a datagram and then closes the
  // socket, and returning before it does would let the caller's cleanup close
  // the socket first, so the client sees a timeout instead of the reason.
  async checkMode () {
    const mode = this.request.mode
    if (mode === 'octet' || mode === 'netascii') {
      return true
    }
    await this.refuse(ERROR_CODE.NOT_DEFINED, `unsupported transfer mode: ${mode}`)
    return false
  }

  negotiate (extra) {
    const requested = this.request.options || {}
    const accepted = {}
    let blockSize = 512

    if (requested.blksize !== undefined) {
      const size = Number(requested.blksize)
      if (!Number.isInteger(size) || size < 8 || size > MAX_BLOCK_SIZE) {
        return { error: `blksize must be an integer between 8 and ${MAX_BLOCK_SIZE}` }
      }
      blockSize = Math.min(size, this.options.maxBlockSize)
      accepted.blksize = String(blockSize)
    }
    if (requested.timeout !== undefined) {
      const seconds = Number(requested.timeout)
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 255) {
        return { error: 'timeout must be an integer between 1 and 255 seconds' }
      }
      this.timeoutMs = seconds * 1000
      accepted.timeout = String(seconds)
    }
    // RFC 2349: for a read the server answers with the real size; for a write
    // there is nothing useful to answer, so the option is simply not accepted
    if (requested.tsize !== undefined && extra && extra.tsize !== undefined) {
      accepted.tsize = String(extra.tsize)
    }
    this.blockSize = blockSize
    return { accepted }
  }

  // Send `packet` and wait for the ACK that acknowledges block `block`,
  // retransmitting on timeout. An ACK for the previous block means our last
  // packet was lost, so it is re-sent at once instead of waiting out the timer.
  async exchange (packet, block) {
    for (let attempt = 0; attempt <= this.options.retries; attempt++) {
      this.send(packet)
      for (;;) {
        let buf
        try {
          buf = await this.receive()
        } catch (err) {
          if (err instanceof TimeoutError) {
            break
          }
          throw err
        }
        const reply = this.parseOrNull(buf)
        if (!reply) {
          continue
        }
        if (reply.opcode === OPCODE.ACK) {
          if (reply.block === block) {
            return
          }
          if (reply.block === previousBlock(block)) {
            this.send(packet)
          }
          continue
        }
        if (reply.opcode === OPCODE.ERROR) {
          throw new PeerError(reply.code, reply.message)
        }
      }
      this.log('debug', `timeout on block ${block}, retry ${attempt + 1}`)
    }
    throw new TimeoutError(`no ACK for block ${block} after ${this.options.retries + 1} tries`)
  }

  // Send the OACK and wait for ACK(0), retransmitting on timeout. Returns a
  // DATA packet when the client skipped the acknowledgement — some clients do,
  // and taking that packet as the start of the transfer is cheaper than making
  // them wait out a retransmit timer they will never answer.
  async openWrite (packet) {
    for (let attempt = 0; attempt <= this.options.retries; attempt++) {
      this.send(packet)
      for (;;) {
        let buf
        try {
          buf = await this.receive()
        } catch (err) {
          if (err instanceof TimeoutError) {
            break
          }
          throw err
        }
        const reply = this.parseOrNull(buf)
        if (!reply) {
          continue
        }
        if (reply.opcode === OPCODE.ACK && reply.block === 0) {
          return null
        }
        if (reply.opcode === OPCODE.DATA && reply.block === 1) {
          return reply
        }
        if (reply.opcode === OPCODE.ERROR) {
          throw new PeerError(reply.code, reply.message)
        }
      }
      this.log('debug', `timeout waiting for ACK 0, retry ${attempt + 1}`)
    }
    throw new TimeoutError('the client never acknowledged the options')
  }

  receive () {
    return new Promise((resolve, reject) => {
      const socket = this.socket
      if (!socket) {
        return reject(new Error('transfer is closed'))
      }
      let settled = false
      const cleanup = () => {
        settled = true
        clearTimeout(timer)
        socket.removeListener('message', onMessage)
        socket.removeListener('error', onError)
        this.pending = null
      }
      const onMessage = (msg, rinfo) => {
        if (!sameAddress(rinfo.address, this.client.address) || rinfo.port !== this.client.port) {
          // RFC 1350: a packet from a third party gets ERROR 5 and the transfer
          // continues, which is also how a stray packet is refused politely
          this.sendTo(errorPacket(ERROR_CODE.UNKNOWN_TID, 'unknown transfer id'), rinfo)
          return
        }
        cleanup()
        resolve(msg)
      }
      const onError = (err) => {
        cleanup()
        reject(err)
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new TimeoutError(`no reply within ${this.timeoutMs}ms`))
      }, this.timeoutMs)
      this.pending = {
        reject: (err) => {
          if (!settled) {
            cleanup()
            reject(err)
          }
        }
      }
      socket.on('message', onMessage)
      socket.on('error', onError)
    })
  }

  parseOrNull (buf) {
    try {
      return parse(buf)
    } catch (err) {
      this.log('debug', `ignoring malformed packet: ${err.message}`)
      return null
    }
  }

  send (buf) {
    if (!this.socket) {
      return
    }
    try {
      this.socket.send(buf, this.client.port, this.client.address, (err) => {
        if (err) {
          this.log('debug', `send failed: ${err.message}`)
        }
      })
    } catch (err) {
      this.log('debug', `send failed: ${err.message}`)
    }
  }

  sendTo (buf, target) {
    return new Promise((resolve) => {
      if (!this.socket) {
        return resolve()
      }
      try {
        this.socket.send(buf, target.port, target.address, () => resolve())
      } catch (err) {
        resolve()
      }
    })
  }

  async refuse (code, message) {
    this.log('warn', `${this.label}: ${message}`)
    this.event({ type: 'refused', ok: false, msg: `${message} (error ${code})` })
    await this.sendTo(errorPacket(code, message), this.client)
    this.finish()
  }

  finish () {
    if (this.finished) {
      return
    }
    this.finished = true
    if (this.pending) {
      this.pending.reject(new Error('transfer closed'))
    }
    const socket = this.socket
    this.socket = null
    if (socket) {
      try {
        socket.close()
      } catch (err) {}
    }
    this.server.release(this)
  }

  abort (reason) {
    if (this.finished) {
      return
    }
    this.log('warn', `aborted: ${reason || 'closed'}`)
    this.event({ type: 'aborted', ok: false, msg: reason || 'closed' })
    this.finish()
  }
}

class TftpServer {
  constructor (options, hooks) {
    this.options = normalizeOptions(options)
    const { log, event } = hooks || {}
    this.log = typeof log === 'function' ? log : () => {}
    this.event = typeof event === 'function' ? event : () => {}
    this.socket = null
    this.transfers = new Map()
    this.stats = { transfers: 0, sent: 0, received: 0 }
    this.startedAt = 0
  }

  get port () {
    return this.socket ? this.socket.address().port : this.options.port
  }

  async listen () {
    if (this.socket) {
      throw new Error('server is already listening')
    }
    const { host, port, root } = this.options
    let stat
    try {
      stat = await fs.promises.stat(root)
    } catch (err) {
      throw new Error(`served folder does not exist: ${root}`)
    }
    if (!stat.isDirectory()) {
      throw new Error(`not a folder: ${root}`)
    }

    const socket = dgram.createSocket(net.isIPv6(host) ? 'udp6' : 'udp4')
    await new Promise((resolve, reject) => {
      const onBindError = (err) => {
        socket.close()
        reject(err)
      }
      socket.once('error', onBindError)
      socket.bind(port, host, () => {
        socket.removeListener('error', onBindError)
        resolve()
      })
    })
    socket.on('error', (err) => {
      this.log('error', `listening socket error: ${err.message}`)
    })
    socket.on('message', (msg, rinfo) => {
      this.handleRequest(msg, rinfo)
    })
    this.socket = socket
    this.startedAt = Date.now()
    return socket.address().port
  }

  handleRequest (msg, rinfo) {
    let request
    try {
      request = parse(msg)
    } catch (err) {
      this.log('debug', `${rinfo.address}:${rinfo.port} malformed packet: ${err.message}`)
      this.replyError(rinfo, ERROR_CODE.ILLEGAL_OPERATION, err.message)
      return
    }
    if (request.opcode !== OPCODE.RRQ && request.opcode !== OPCODE.WRQ) {
      // DATA/ACK/OACK only make sense on a transfer port
      this.replyError(rinfo, ERROR_CODE.UNKNOWN_TID, 'this is the listening port')
      return
    }

    const key = `${rinfo.address}:${rinfo.port}`
    if (this.transfers.has(key)) {
      // A client that never saw our first packet repeats its request to the
      // well known port. The transfer already running retransmits on its own
      // timer, so a second one would only race it for the same file.
      this.log('debug', `${key} repeated its request while a transfer is running, ignored`)
      return
    }

    this.stats.transfers++
    const transfer = new Transfer(this, rinfo, request)
    this.transfers.set(key, transfer)
    this.log('info', `${key} ${request.opcode === OPCODE.RRQ ? 'RRQ' : 'WRQ'} ${transfer.label}`)

    transfer.start().then(() => {
      // the transfer finished on its own: close its socket, or it keeps the
      // port and the file handle for the life of the process
      transfer.finish()
    }).catch((err) => {
      if (!(err instanceof PeerError)) {
        this.log('error', `${key} ${transfer.label} failed: ${err.message}`)
        transfer.event({ type: 'error', ok: false, msg: err.message })
      }
      transfer.abort(err.message)
    })
  }

  replyError (rinfo, code, message) {
    if (!this.socket) {
      return
    }
    try {
      this.socket.send(errorPacket(code, message), rinfo.port, rinfo.address, () => {})
    } catch (err) {}
  }

  release (transfer) {
    this.stats.sent += transfer.request.opcode === OPCODE.RRQ ? transfer.bytes : 0
    this.stats.received += transfer.request.opcode === OPCODE.WRQ ? transfer.bytes : 0
    this.transfers.delete(transfer.key)
  }

  getStatus () {
    return {
      running: !!this.socket,
      port: this.port,
      root: this.options.root,
      readOnly: !this.options.allowWrite,
      activeTransfers: this.transfers.size,
      transfers: this.stats.transfers,
      sent: this.stats.sent,
      received: this.stats.received,
      uptime: this.startedAt ? Date.now() - this.startedAt : 0
    }
  }

  async close () {
    const socket = this.socket
    if (!socket) {
      return
    }
    for (const transfer of [...this.transfers.values()]) {
      await transfer.sendTo(
        errorPacket(ERROR_CODE.NOT_DEFINED, 'server shutting down'),
        transfer.client
      )
      transfer.abort('server shutting down')
    }
    this.socket = null
    await new Promise((resolve) => {
      try {
        socket.close(() => resolve())
      } catch (err) {
        resolve()
      }
    })
  }
}

module.exports = {
  TftpServer,
  Transfer,
  DEFAULTS,
  TimeoutError,
  PeerError,
  BLOCK_MOD
}
