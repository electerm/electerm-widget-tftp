'use strict'

/**
 * TFTP wire format (RFC 1350, plus the option extension of RFC 2347).
 *
 * Everything here is pure: buffers in, objects out, and back. The server in
 * ./server.js owns the sockets, the timers and the file handles; keeping the
 * encoding separate is what makes the state machine testable without a network.
 *
 * All fields are big endian and every string is NUL terminated.
 *
 *   RRQ/WRQ  opcode(2) filename(0) mode(0) [option(0) value(0)]*
 *   DATA     opcode(2) block(2) data(0..blksize)
 *   ACK      opcode(2) block(2)
 *   ERROR    opcode(2) errcode(2) message(0)
 *   OACK     opcode(2) [option(0) value(0)]*
 */

const OPCODE = {
  RRQ: 1,
  WRQ: 2,
  DATA: 3,
  ACK: 4,
  ERROR: 5,
  OACK: 6
}

const ERROR_CODE = {
  NOT_DEFINED: 0,
  FILE_NOT_FOUND: 1,
  ACCESS_VIOLATION: 2,
  DISK_FULL: 3,
  ILLEGAL_OPERATION: 4,
  UNKNOWN_TID: 5,
  FILE_EXISTS: 6,
  NO_SUCH_USER: 7,
  OPTION_NEGOTIATION: 8
}

// 65536, not 65535: block numbers are 16 bit and wrap to 0 after 65535.
const BLOCK_MOD = 0x10000

class PacketError extends Error {
  constructor (message) {
    super(message)
    this.name = 'PacketError'
    this.code = ERROR_CODE.ILLEGAL_OPERATION
  }
}

function nextBlock (block) {
  return (block + 1) % BLOCK_MOD
}

function previousBlock (block) {
  return (block + BLOCK_MOD - 1) % BLOCK_MOD
}

// A NUL terminated string, and where the next field starts. A truncated packet
// is a protocol error, not something to guess at: a filename with a missing
// terminator would otherwise silently become the rest of the packet.
function readString (buf, offset, what) {
  const end = buf.indexOf(0, offset)
  if (end === -1) {
    throw new PacketError(`${what} is not NUL terminated`)
  }
  return { value: buf.toString('utf8', offset, end), next: end + 1 }
}

/**
 * Decode any packet. Returns `{ opcode, ... }`; throws PacketError for a packet
 * too short to hold its own header, which the server answers with ERROR 4.
 */
function parse (buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) {
    throw new PacketError('packet shorter than 4 bytes')
  }
  const opcode = buf.readUInt16BE(0)
  switch (opcode) {
    case OPCODE.RRQ:
    case OPCODE.WRQ: {
      const file = readString(buf, 2, 'file name')
      const mode = readString(buf, file.next, 'mode')
      const options = {}
      let offset = mode.next
      // An odd number of trailing fields is a client bug; the option without a
      // value is simply dropped rather than failing the whole request.
      while (offset < buf.length) {
        const name = readString(buf, offset, 'option name')
        if (name.next >= buf.length) {
          break
        }
        const value = readString(buf, name.next, 'option value')
        const key = name.value.toLowerCase()
        if (key) {
          options[key] = value.value
        }
        offset = value.next
      }
      return {
        opcode,
        filename: file.value,
        mode: mode.value.toLowerCase(),
        options
      }
    }
    case OPCODE.DATA:
      if (buf.length < 4) {
        throw new PacketError('DATA without a block number')
      }
      return {
        opcode,
        block: buf.readUInt16BE(2),
        data: buf.subarray(4)
      }
    case OPCODE.ACK:
      return {
        opcode,
        block: buf.readUInt16BE(2)
      }
    case OPCODE.ERROR:
      return {
        opcode,
        code: buf.readUInt16BE(2),
        message: buf.length > 4 ? buf.toString('utf8', 4).replace(/\0+$/, '') : ''
      }
    case OPCODE.OACK: {
      const options = {}
      let offset = 2
      while (offset < buf.length) {
        const name = readString(buf, offset, 'option name')
        if (name.next >= buf.length) {
          break
        }
        const value = readString(buf, name.next, 'option value')
        options[name.value.toLowerCase()] = value.value
        offset = value.next
      }
      return { opcode, options }
    }
    default:
      throw new PacketError(`unknown opcode ${opcode}`)
  }
}

function header (opcode) {
  const buf = Buffer.allocUnsafe(4)
  buf.writeUInt16BE(opcode, 0)
  return buf
}

function data (block, payload) {
  const body = payload || Buffer.alloc(0)
  const buf = Buffer.allocUnsafe(4 + body.length)
  buf.writeUInt16BE(OPCODE.DATA, 0)
  buf.writeUInt16BE(block % BLOCK_MOD, 2)
  body.copy(buf, 4)
  return buf
}

function ack (block) {
  const buf = header(OPCODE.ACK)
  buf.writeUInt16BE(block % BLOCK_MOD, 2)
  return buf
}

function error (code, message) {
  const text = Buffer.from(String(message || '').slice(0, 500), 'utf8')
  const buf = Buffer.allocUnsafe(4 + text.length + 1)
  buf.writeUInt16BE(OPCODE.ERROR, 0)
  buf.writeUInt16BE(code, 2)
  text.copy(buf, 4)
  buf[buf.length - 1] = 0
  return buf
}

function oack (options) {
  const parts = [Buffer.from([0, OPCODE.OACK])]
  for (const [name, value] of Object.entries(options)) {
    parts.push(Buffer.from(String(name), 'utf8'), Buffer.from([0]))
    parts.push(Buffer.from(String(value), 'utf8'), Buffer.from([0]))
  }
  return Buffer.concat(parts)
}

module.exports = {
  OPCODE,
  ERROR_CODE,
  BLOCK_MOD,
  PacketError,
  parse,
  nextBlock,
  previousBlock,
  data,
  ack,
  error,
  oack
}
