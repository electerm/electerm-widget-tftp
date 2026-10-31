'use strict'

const test = require('node:test')
const assert = require('node:assert')

const {
  OPCODE,
  ERROR_CODE,
  parse,
  nextBlock,
  previousBlock,
  data,
  ack,
  error,
  oack
} = require('../lib/packet')

// NUL terminated fields, which is how every string in TFTP is written
function field (value) {
  return Buffer.concat([Buffer.from(String(value), 'latin1'), Buffer.from([0])])
}

function request (opcode, filename, mode, options) {
  const parts = [Buffer.from([0, opcode]), field(filename), field(mode)]
  for (const [name, value] of Object.entries(options || {})) {
    parts.push(field(name), field(value))
  }
  return Buffer.concat(parts)
}

test('parses an RRQ with options', () => {
  const parsed = parse(request(OPCODE.RRQ, 'firmware.bin', 'octet', {
    blksize: '1024',
    tsize: '0'
  }))
  assert.equal(parsed.opcode, OPCODE.RRQ)
  assert.equal(parsed.filename, 'firmware.bin')
  assert.equal(parsed.mode, 'octet')
  assert.deepEqual(parsed.options, { blksize: '1024', tsize: '0' })
})

test('parses a WRQ without options', () => {
  const parsed = parse(request(OPCODE.WRQ, 'config.txt', 'netascii'))
  assert.equal(parsed.opcode, OPCODE.WRQ)
  assert.equal(parsed.filename, 'config.txt')
  assert.equal(parsed.mode, 'netascii')
  assert.deepEqual(parsed.options, {})
})

test('lowercases option names but keeps values as sent', () => {
  const parsed = parse(request(OPCODE.RRQ, 'a', 'octet', { BLKSIZE: '1428' }))
  assert.equal(parsed.options.blksize, '1428')
})

test('a trailing option name without a value is dropped, not fatal', () => {
  const packet = Buffer.concat([
    request(OPCODE.RRQ, 'a', 'octet'),
    field('blksize')
  ])
  const parsed = parse(packet)
  assert.deepEqual(parsed.options, {})
})

test('rejects a request without a NUL terminator', () => {
  const packet = Buffer.concat([Buffer.from([0, OPCODE.RRQ]), Buffer.from('a.bin')])
  assert.throws(() => parse(packet), /not NUL terminated/)
})

test('rejects a packet shorter than its header', () => {
  assert.throws(() => parse(Buffer.from([0, OPCODE.ACK, 0])), /shorter than 4 bytes/)
  assert.throws(() => parse(Buffer.alloc(0)), /shorter than 4 bytes/)
})

test('rejects an unknown opcode', () => {
  assert.throws(() => parse(Buffer.from([0, 42, 0, 0])), /unknown opcode/)
})

test('round-trips DATA, ACK, ERROR and OACK', () => {
  const payload = Buffer.from('hello')
  const dataPacket = parse(data(7, payload))
  assert.equal(dataPacket.opcode, OPCODE.DATA)
  assert.equal(dataPacket.block, 7)
  assert.deepEqual(dataPacket.data, payload)

  assert.equal(parse(ack(65535)).block, 65535)

  const err = parse(error(ERROR_CODE.FILE_NOT_FOUND, 'nope'))
  assert.equal(err.code, ERROR_CODE.FILE_NOT_FOUND)
  assert.equal(err.message, 'nope')

  const options = parse(oack({ blksize: '1428', tsize: '10' }))
  assert.equal(options.opcode, OPCODE.OACK)
  assert.deepEqual(options.options, { blksize: '1428', tsize: '10' })
})

test('block numbers wrap at 65536', () => {
  assert.equal(nextBlock(65535), 0)
  assert.equal(nextBlock(0), 1)
  assert.equal(previousBlock(0), 65535)
  assert.equal(previousBlock(1), 0)
  // the encoder must not write 65536 into a 16 bit field
  assert.equal(parse(ack(65536)).block, 0)
  assert.equal(parse(data(65537, Buffer.alloc(1))).block, 1)
})
