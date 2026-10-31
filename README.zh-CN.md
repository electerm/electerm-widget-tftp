# Local TFTP Server —— electerm 小组件

一个跑在 electerm 小组件列表里的 TFTP 服务器。路由器、交换机、PXE 启动的机器或者
`curl`，都可以从这里取文件；需要的话，也可以往里面上传。

零依赖、无构建步骤：协议直接用 `dgram` 实现，因为从 git 安装的组件没法执行
`npm install`。

[English](./README.md)

## 安装

electerm 里打开 **设置 → 小组件 → 从 URL 导入**，粘贴：

```
https://github.com/zxdong262/electerm-widget-tftp
```

`owner/repo` 这种写法也认。组件会装到 `<数据目录>/widgets/tftp-server/`，配置表单由
electerm 自己渲染 —— 没有自定义面板，所以「随 electerm 启动」是能用的。

## TFTP 是什么

Trivial File Transfer Protocol（RFC 1350），一个塞得进 ROM 的文件传输协议。一个 UDP
包请求文件，回复是一串带编号的 512 字节块，每一块都要确认之后才发下一块。没有认证、
没有目录列表、没有加密、也不能只取文件的一段 —— 这正是网络设备至今还在用它、而其他
场合都不该用它的原因。

两个容易踩的点：

- **每次传输都会换端口。** 请求打到 69（这里是 6969），回复却来自一个临时的随机端口，
  后续对话都在那个端口上。防火墙必须放行它，否则你只会收到第一个包。
- **协议里没有文件长度。** 传输在「第一个短于协商块大小的块」处结束，所以文件长度正好
  是块大小整数倍时，末尾会多出一个空块。

## 配置项

| 配置 | 默认值 | 说明 |
|---|---|---|
| 监听地址 | `0.0.0.0` | 绑定哪块网卡。局域网设备要用 `0.0.0.0`。 |
| 端口 | `6969` | TFTP 标准端口是 69，绑定它需要 root；electerm 以你的身份运行，所以默认 6969。 |
| 服务目录 | `~/tftp` | 不存在会自动创建。客户端出不去这个目录，见「安全」。 |
| 允许上传 | 关 | 接受 WRQ。默认关：这东西没有密码。 |
| 覆盖同名文件 | 关 | 开了上传才相关。关着时，上传到已存在的文件名会被拒绝。 |
| 最大块大小 | `1468` | `blksize` 选项的上限。1468 能让一个包待在 1500 字节 MTU 里。 |
| 超时 | `3` 秒 | 等下一个包多久后重传。 |
| 重试 | `5` | 重传几次后放弃本次传输。 |
| 随 electerm 启动 | 关 | 开机就起实例。 |

启动后显示的 URL 就是局域网设备该填的地址，比如 `tftp://192.168.1.20:6969`。

## 用法

取文件：

```bash
curl -o firmware.bin tftp://192.168.1.20:6969/firmware.bin
curl --tftp-blksize 1428 -o firmware.bin tftp://192.168.1.20:6969/firmware.bin
```

上传（需要打开「允许上传」）：

```bash
curl -T running-config.txt tftp://192.168.1.20:6969/backup.txt
```

用系统自带的经典客户端 —— 它默认是 `netascii`，这个模式是支持的，换行会被正确转换
而不是弄坏文件：

```bash
tftp 192.168.1.20 6969
tftp> binary
tftp> get firmware.bin
tftp> put running-config.txt
```

设备命令行里也可以，不需要任何客户端：

```
copy flash:running-config tftp://192.168.1.20:6969/backup.txt
```

每次传输都会记进实例日志（**设置 → 小组件 → 运行中的实例**），一条请求一行，带结果 ——
设备报 timeout 的时候，先看请求到底有没有到。

## 实现了什么

- RFC 1350：RRQ、WRQ、DATA、ACK、ERROR，块号在 65536 处回绕，超时重传，以及给未知
  TID 的包回 ERROR 5。
- RFC 2347/2348/2349 选项：`blksize`（按配置上限截断）、`tsize`（读的时候回真实大小）、
  `timeout`。未知选项按 RFC 要求忽略 —— `windowsize`（RFC 7440）没实现，所以请求它的
  客户端会退回一次一块。
- 两种传输模式：`octet` 和 `netascii`。
- Sorcerer's Apprentice 修正：收到重复 ACK 立刻重发当前块，而不是干等定时器。
- 上传时收到重复 DATA 会重新 ACK，但不会重复写盘。

刻意没做：多播（RFC 2090）、`mail` 模式，以及任何形式的认证 —— TFTP 本来就没有。

## 安全

TFTP 没有认证，所以默认值都往安全的一边靠：

- **只读。** 上传要你手动打开。
- **一个目录。** 解析到服务目录之外的请求一律拒绝，包括通过指向外面的软链接逃出去的那种。
- **局域网。** 笔记本连着咖啡厅 Wi-Fi 时绑 `0.0.0.0`，等于把那个目录给整个咖啡厅看。
  也不要把端口从公网转发进来，TFTP 没有任何东西可以保护它。

## 开发

```bash
npm test    # 57 个测试，除了本机回环不需要网络
npm run lint
```

结构：

```
index.js              组件契约：widgetRun(config, ctx) → { start, stop }
lib/server.js         协议本体：监听 socket，每个请求一个 Transfer
lib/packet.js         编解码，纯函数
lib/safe-path.js      文件名 → 根目录内的路径，含软链接解析
lib/block-reader.js   流 → 定长块，最后一块是短的
lib/netascii.js       两个 netascii 转换流
test/                 node:test，test/helpers 里有个最小 TFTP 客户端
```

组件契约本身见 electerm 的
[`src/app/widgets/user-widget.js`](https://github.com/electerm/electerm/blob/master/src/app/widgets/user-widget.js)：
`package.json` 是清单（宿主列组件时不执行代码），`widgetRun` 是入口，`ctx.log` /
`ctx.event` 就是实例日志的来源。

## 许可

MIT
