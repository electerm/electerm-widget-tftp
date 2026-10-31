'use strict'

/**
 * Local TFTP server — an electerm user widget.
 *
 * TFTP is the file transfer protocol that network gear still speaks and almost
 * nothing else does: routers and switches pull firmware and push configs with
 * it, PXE boots a machine with it, and it is small enough to live in a ROM.
 * There is no authentication, no directory listing and no encryption — a
 * request names a file and that is the whole negotiation — which is why the
 * default here is read-only over one folder rather than the whole home dir.
 *
 * The protocol itself lives in ./lib/server.js; this file is only the widget
 * contract: the config the host renders as a form, and the instance it starts
 * and stops.
 */

const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { TftpServer } = require('./lib/server')

const NAME = 'Local TFTP Server'
const DEFAULT_DIR = path.join(os.homedir(), 'tftp')

// The manifest — names, labels and descriptions — is package.json, because the
// host lists widgets without executing their code. Only the defaults are
// repeated here, to fill in a field an older install of the form may not have
// sent.
const DEFAULTS = {
  host: '0.0.0.0',
  port: 6969,
  directory: DEFAULT_DIR,
  allowWrite: false,
  overwrite: false,
  maxBlockSize: 1468,
  timeout: 3,
  retries: 5
}

// 0.0.0.0 is right to bind and useless to read, so the URL shows the address a
// client on the LAN would actually type.
function advertisedHost (host) {
  if (host && host !== '0.0.0.0' && host !== '::') {
    return host
  }
  const interfaces = os.networkInterfaces()
  for (const name of Object.keys(interfaces)) {
    for (const item of interfaces[name] || []) {
      if (item.family === 'IPv4' && !item.internal) {
        return item.address
      }
    }
  }
  return host || '127.0.0.1'
}

async function ensureFolder (dir, log) {
  try {
    const stat = await fs.promises.stat(dir)
    if (!stat.isDirectory()) {
      throw new Error(`not a folder: ${dir}`)
    }
    return
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw err
    }
  }
  await fs.promises.mkdir(dir, { recursive: true })
  log('info', `created the served folder ${dir}`)
}

function widgetRun (instanceConfig, ctx = {}) {
  const log = typeof ctx.log === 'function' ? ctx.log : () => {}
  const event = typeof ctx.event === 'function' ? ctx.event : () => {}
  const config = { ...DEFAULTS, ...instanceConfig }
  const instanceId = crypto.randomUUID()
  let server = null

  const start = async () => {
    if (server) {
      throw new Error('Server is already running')
    }
    const root = path.resolve(String(config.directory || DEFAULT_DIR))
    await ensureFolder(root, log)

    const instance = new TftpServer({
      host: config.host,
      port: config.port,
      root,
      allowWrite: !!config.allowWrite,
      overwrite: !!config.overwrite,
      maxBlockSize: config.maxBlockSize,
      timeout: config.timeout,
      retries: config.retries
    }, { log, event })

    let port
    try {
      port = await instance.listen()
    } catch (err) {
      // a port already taken is the most common failure by far, and the raw
      // EADDRINUSE text does not say which setting to change
      if (err.code === 'EADDRINUSE') {
        throw new Error(`UDP port ${config.port} is already in use — pick another port`)
      }
      throw err
    }
    server = instance

    const url = `tftp://${advertisedHost(config.host)}:${port}`
    const mode = config.allowWrite ? 'read/write' : 'read-only'
    const msg = `${NAME} is running at ${url} (${mode})`
    log('info', `serving ${root}, ${mode}, block size up to ${config.maxBlockSize}`)
    console.log(msg)
    console.log(`Serving files from: ${root}`)
    return {
      serverInfo: {
        url,
        path: root,
        port
      },
      msg,
      success: true
    }
  }

  const stop = async () => {
    const instance = server
    server = null
    if (!instance) {
      console.log(`${NAME} is not running`)
      return
    }
    await instance.close()
    console.log(`${NAME} has been stopped`)
  }

  // Not part of the widget contract, but the instance log and anyone poking at
  // this from a console can ask how it is doing without restarting it.
  const getStatus = () => (server
    ? server.getStatus()
    : { running: false, root: path.resolve(String(config.directory || DEFAULT_DIR)) })

  return {
    instanceId,
    start,
    stop,
    getStatus
  }
}

module.exports = {
  widgetRun
}
