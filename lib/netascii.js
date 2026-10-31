'use strict'

/**
 * `netascii` is TFTP's other transfer mode: US-ASCII with CR LF line endings,
 * and a lone CR sent as CR NUL (RFC 764, quoted by RFC 1350).
 *
 * Most gear uses `octet` — network boot, firmware uploads, `curl tftp://` all
 * do — but the classic BSD `tftp` client defaults to netascii, so a server that
 * rejects the mode looks broken to anyone using the command line tool. Rather
 * than buffer the file to translate it, the conversion is a pair of streams:
 * blocks are cut from the converted bytes, which keeps memory flat and the
 * block boundaries correct for the receiver.
 */

const { Transform } = require('stream')

const CR = 0x0d
const LF = 0x0a
const NUL = 0x00

class NetasciiEncode extends Transform {
  _transform (chunk, encoding, callback) {
    const out = Buffer.allocUnsafe(chunk.length * 2)
    let n = 0
    for (const byte of chunk) {
      if (byte === LF) {
        out[n++] = CR
        out[n++] = LF
      } else if (byte === CR) {
        out[n++] = CR
        out[n++] = NUL
      } else {
        out[n++] = byte
      }
    }
    this.push(out.subarray(0, n))
    callback()
  }
}

class NetasciiDecode extends Transform {
  constructor () {
    super()
    // a CR at the end of a chunk cannot be classified until the next chunk
    this.pendingCR = false
  }

  _transform (chunk, encoding, callback) {
    const out = Buffer.allocUnsafe(chunk.length + 2)
    let n = 0
    for (const byte of chunk) {
      if (this.pendingCR) {
        this.pendingCR = false
        if (byte === LF) {
          out[n++] = LF
          continue
        }
        if (byte === NUL) {
          out[n++] = CR
          continue
        }
        // a bare CR that was not an escape: keep it and reprocess the byte
        out[n++] = CR
        if (byte === CR) {
          this.pendingCR = true
          continue
        }
        out[n++] = byte
        continue
      }
      if (byte === CR) {
        this.pendingCR = true
        continue
      }
      out[n++] = byte
    }
    this.push(out.subarray(0, n))
    callback()
  }

  _flush (callback) {
    if (this.pendingCR) {
      this.pendingCR = false
      this.push(Buffer.from([CR]))
    }
    callback()
  }
}

module.exports = {
  NetasciiEncode,
  NetasciiDecode
}
