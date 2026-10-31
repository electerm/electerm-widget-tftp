'use strict'

/**
 * Turning a name a client sent into a path on disk, without ever leaving the
 * served folder.
 *
 * TFTP has no authentication worth the name and the file name comes straight
 * off the wire, so this is the only thing standing between "serve ~/tftp" and
 * "serve /etc/shadow": two checks, because they fail differently.
 *
 *   1. the requested name must resolve inside the root — catches `../`,
 *      absolute paths, and Windows-style separators sent by a confused client;
 *   2. the path on disk must really be inside the root after symlinks are
 *      resolved — catches a link inside the served folder pointing out of it,
 *      which check 1 cannot see.
 *
 * Check 2 needs the path to exist, so it runs on the file (read) or on the
 * parent folder (write), not here.
 */

const fs = require('fs')
const path = require('path')

class PathError extends Error {
  constructor (message) {
    super(message)
    this.name = 'PathError'
  }
}

function isInside (parent, child) {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function resolveInRoot (root, name) {
  if (typeof name !== 'string' || !name.trim()) {
    throw new PathError('empty file name')
  }
  if (name.includes('\0')) {
    throw new PathError('file name contains a NUL byte')
  }
  // A Windows client may send `dir\file`; treating the backslash as a separator
  // is what the client meant, and it also stops it from being a legal file name
  // character on macOS/Linux, which would put a literal `\` in the path.
  const normalized = name.replace(/\\/g, '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new PathError('absolute paths are not allowed')
  }
  const absRoot = path.resolve(root)
  const abs = path.resolve(absRoot, normalized)
  if (!isInside(absRoot, abs)) {
    throw new PathError(`path escapes the served folder: ${name}`)
  }
  return abs
}

// Resolve symlinks and re-check. `target` may not exist yet (write): then the
// nearest existing ancestor is what has to be inside the root.
function assertRealPathInside (root, target) {
  let realRoot
  try {
    realRoot = fs.realpathSync(root)
  } catch (e) {
    throw new PathError(`served folder is not readable: ${root}`)
  }
  let probe = path.resolve(target)
  for (;;) {
    try {
      const real = fs.realpathSync(probe)
      if (!isInside(realRoot, real)) {
        throw new PathError(`path escapes the served folder: ${path.relative(realRoot, real)}`)
      }
      return real
    } catch (e) {
      if (e instanceof PathError) {
        throw e
      }
      // ENOENT: walk up to the parent and try again
      const parent = path.dirname(probe)
      if (parent === probe) {
        throw new PathError(`cannot resolve ${target}`)
      }
      probe = parent
    }
  }
}

module.exports = {
  PathError,
  isInside,
  resolveInRoot,
  assertRealPathInside
}
