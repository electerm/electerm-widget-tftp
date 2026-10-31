'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { Readable } = require('node:stream')

const { NetasciiEncode, NetasciiDecode } = require('../lib/netascii')

async function convert (transform, input) {
  const chunks = []
  const stream = Readable.from([Buffer.from(input, 'latin1')]).pipe(transform)
  for await (const chunk of stream) {
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('latin1')
}

test('encode turns LF into CR LF and a lone CR into CR NUL', async () => {
  assert.equal(await convert(new NetasciiEncode(), 'a\nb\rc'), 'a\r\nb\r\0c')
})

test('encode leaves plain text alone', async () => {
  assert.equal(await convert(new NetasciiEncode(), 'hello'), 'hello')
})

test('decode turns CR LF back into LF and CR NUL into CR', async () => {
  assert.equal(await convert(new NetasciiDecode(), 'a\r\nb\r\0c'), 'a\nb\rc')
})

test('decode keeps a bare CR that is not an escape', async () => {
  assert.equal(await convert(new NetasciiDecode(), 'a\rb'), 'a\rb')
})

test('a CR split across chunks is still classified correctly', async () => {
  const decoder = new NetasciiDecode()
  const chunks = []
  decoder.on('data', (chunk) => chunks.push(chunk))
  const done = new Promise((resolve) => decoder.on('end', resolve))
  decoder.write(Buffer.from('a\r', 'latin1'))
  decoder.write(Buffer.from('\nb', 'latin1'))
  decoder.end()
  await done
  assert.equal(Buffer.concat(chunks).toString('latin1'), 'a\nb')
})

test('a CR at the very end is flushed as a CR', async () => {
  assert.equal(await convert(new NetasciiDecode(), 'abc\r'), 'abc\r')
})

test('encode and decode are inverse for text with mixed endings', async () => {
  const original = 'line one\nline two\r\nlast\r'
  const encoded = await convert(new NetasciiEncode(), original)
  const decoded = await convert(new NetasciiDecode(), encoded)
  assert.equal(decoded, original)
})
