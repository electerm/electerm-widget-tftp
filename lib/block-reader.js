'use strict'

/**
 * Read a stream in fixed size blocks, the way TFTP sends it.
 *
 * The last block is the short one (a multiple of the block size means a final
 * zero-length block), which is how the receiver knows the file ended: TFTP has
 * no length in DATA, so "shorter than blksize" is the only end marker.
 */

class BlockReader {
  constructor (stream, size) {
    if (!Number.isInteger(size) || size < 8) {
      throw new Error(`invalid block size: ${size}`)
    }
    this.size = size
    this.stream = stream
    this.iterator = stream[Symbol.asyncIterator]()
    this.buffer = Buffer.alloc(0)
    this.done = false
  }

  // A Buffer of 1..size bytes, or 0 bytes once the stream is exhausted.
  async next () {
    while (this.buffer.length < this.size && !this.done) {
      const { value, done } = await this.iterator.next()
      if (done) {
        this.done = true
        break
      }
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
      this.buffer = this.buffer.length
        ? Buffer.concat([this.buffer, chunk])
        : chunk
    }
    const block = this.buffer.subarray(0, this.size)
    this.buffer = this.buffer.subarray(block.length)
    // copy: subarray shares memory with a buffer the stream may still own
    return Buffer.from(block)
  }

  async close () {
    if (this.done) {
      return
    }
    this.done = true
    if (typeof this.stream.destroy === 'function') {
      this.stream.destroy()
    }
  }
}

module.exports = BlockReader
