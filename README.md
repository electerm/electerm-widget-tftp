# Local TFTP Server — an electerm widget

A TFTP server that lives in electerm's widget list. Point a router, a switch, a
PXE booting machine or `curl` at it and serve a folder — or let them upload into
it, if you turn that on.

No dependency, no build step: the protocol is implemented in this repo against
`dgram`, because a widget installed from git cannot run `npm install`.

[中文说明](./README.zh-CN.md)

## Install

In electerm: **Settings → Widgets → Import from URL**, then paste

```
https://github.com/zxdong262/electerm-widget-tftp
```

`owner/repo` works too. The widget lands in `<data dir>/widgets/tftp-server/`,
and its config form is rendered by electerm itself — there is no custom panel,
which is what lets **Start with electerm** work.

## What TFTP is

Trivial File Transfer Protocol (RFC 1350) is the file transfer that fits in a
ROM. One UDP packet asks for a file, the answer is a numbered sequence of
512-byte blocks, and every block is acknowledged before the next one is sent.
There is no authentication, no directory listing, no encryption and no way to
ask for a range of bytes — which is exactly why network gear still uses it and
why it is the wrong protocol for anything else.

Two details that surprise people:

- **Every transfer moves to a new port.** The request arrives on 69 (or 6969
  here), the reply comes from a fresh ephemeral port, and the rest of the
  conversation happens there. A firewall has to allow that, or the first packet
  is the only one that ever arrives.
- **There is no file size in the protocol.** The transfer ends at the first
  block shorter than the negotiated block size, so a file that is an exact
  multiple of the block size ends with an empty block.

## Configure

| Setting | Default | What it does |
|---|---|---|
| Listen address | `0.0.0.0` | Interface to bind. `0.0.0.0` is what a device on the LAN needs. |
| Port | `6969` | TFTP's own port is 69, which needs root. electerm runs as you, so 6969. |
| Served folder | `~/tftp` | Created if missing. Clients cannot leave it — see *Safety*. |
| Allow uploads | off | Accept WRQ. Off by default: there is no password. |
| Overwrite existing files | off | With uploads on, refuse a name that already exists instead of replacing it. |
| Max block size | `1468` | Ceiling for the `blksize` option. 1468 keeps a packet inside a 1500-byte MTU. |
| Timeout | `3` s | How long to wait for the next packet before retransmitting. |
| Retries | `5` | Retransmissions before the transfer is abandoned. |
| Start with electerm | off | Autostart the instance when electerm starts. |

The URL shown after starting is the address a client on your LAN would type:
`tftp://192.168.1.20:6969`.

## Use it

Read a file:

```bash
curl -o firmware.bin tftp://192.168.1.20:6969/firmware.bin
curl --tftp-blksize 1428 -o firmware.bin tftp://192.168.1.20:6969/firmware.bin
```

Upload a file (needs **Allow uploads**):

```bash
curl -T running-config.txt tftp://192.168.1.20:6969/backup.txt
```

With the classic client, which defaults to `netascii` — the mode is supported,
so line endings are translated rather than mangled:

```bash
tftp 192.168.1.20 6969
tftp> binary
tftp> get firmware.bin
tftp> put running-config.txt
```

From a Cisco-style CLI, the same thing with no client at all:

```
copy flash:running-config tftp://192.168.1.20:6969/backup.txt
```

Every transfer is recorded in the instance log (**Settings → Widgets → running
instances**), one line per request with its outcome, which is where to look when
a device says "timeout" and you want to know whether the request even arrived.

## What is implemented

- RFC 1350: RRQ, WRQ, DATA, ACK, ERROR, block numbers wrapping at 65536, a
  timeout with retransmission, and ERROR 5 for a packet from an unknown transfer
  id.
- RFC 2347/2348/2349 options: `blksize` (clamped to the configured maximum),
  `tsize` (the real size on a read), `timeout`. Unknown options are ignored, as
  the RFC requires — `windowsize` (RFC 7440) is not implemented, so a client
  that asks for it falls back to one block at a time.
- Both transfer modes, `octet` and `netascii`.
- The Sorcerer's Apprentice fix: a duplicate ACK re-sends the block immediately
  instead of waiting out the timer.
- Duplicate DATA on an upload is acknowledged again and not written twice.

Not implemented, on purpose: multicast (RFC 2090), the `mail` mode, and any form
of authentication — TFTP has none to implement.

## Safety

TFTP has no authentication, so the defaults are the safe ones:

- **Read-only.** Uploads are off until you turn them on.
- **One folder.** A request that resolves outside the served folder is refused,
  including one that escapes through a symlink pointing out of it.
- **Local network.** Bind to `0.0.0.0` on a laptop that joins café Wi-Fi and you
  are serving that folder to the café. Do not forward the port from the
  internet; TFTP has nothing to protect it with.

## Development

```bash
npm test    # 57 tests, no network access needed beyond localhost
npm run lint
```

Layout:

```
index.js              widget contract: widgetRun(config, ctx) → { start, stop }
lib/server.js         the protocol: listening socket, one Transfer per request
lib/packet.js         encode/decode, pure functions
lib/safe-path.js      name → path inside the root, with symlink resolution
lib/block-reader.js   stream → fixed-size blocks, short last block
lib/netascii.js       the two netascii transforms
test/                 node:test, with a minimal TFTP client in test/helpers
```

The widget contract itself is documented in electerm's
[`src/app/widgets/user-widget.js`](https://github.com/electerm/electerm/blob/master/src/app/widgets/user-widget.js):
`package.json` is the manifest (the host lists widgets without executing their
code), `widgetRun` is the entry, and `ctx.log` / `ctx.event` are what fills the
instance log.

## License

MIT
