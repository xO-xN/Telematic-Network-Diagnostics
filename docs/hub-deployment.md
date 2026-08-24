# hub 部署指南（Telematic Network Diagnostics v0.1）

本文面向 VPS 运维者：仅凭本文即可在一台公网服务器上把 TND 的 hub
跑起来——快速路径（裸 `ws://IP:端口`）与正式路径（域名 + Caddy +
`wss://`）各一条。

## hub 是什么

hub 是星型拓扑（hub/star）的中心：一台公网 VPS 上的 Socket.IO 中继。
每个站点的 score server（PNDS App 打开本工程后运行的那个进程）出站
连接 hub；hub 按**房间**把各节点发出的消息中继给同房间的其他节点，
并在每条消息上盖 **hub 接收时间戳**。它只有 Node + socket.io，没有
浏览器界面，不落盘、不存储任何数据。

- **鉴权**：连接时的握手参数 `token` 必须等于 hub 进程环境变量
  `HUB_TOKEN`，否则拒绝连接。
- **房间**：握手参数 `room` 可选，缺省 `"default"`；消息只在同房间
  内中继，跨房间互相隔离。
- **时间戳**：每条中继消息带上 `hubReceivedAt`（hub 收到该消息的
  epoch 毫秒）。

hub 是**项目侧模块**（随本仓库走），不是平台设施：不同作品可以替换
成自己的同步策略，本实现即参考实现。hub 从源码部署，不进 `.pnds`
演出包。

## 前置要求

| 项目 | 要求 |
| --- | --- |
| 服务器 | 一台公网 VPS（1 vCPU / 512 MB 足够） |
| Node.js | **≥ 20**（本仓库开发与 CI 用 24.18.1；`node --version` 确认） |
| 正式路径额外 | 一个域名（DNS A 记录指向 VPS） |

安装 Node.js（Debian / Ubuntu，NodeSource 方式）：

```sh
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # v22.x —— 任何 ≥ 20 的版本都可以
```

## 快速路径：裸 `ws://IP:端口`

适合 DNS / 证书就绪之前的先跑通验证。token 会在公网上明文传输，**仅
用于测试**。

### 1. 拿代码、装依赖

```sh
sudo mkdir -p /opt/tnd
sudo chown "$USER" /opt/tnd
git clone https://github.com/xO-xN/Telematic-Network-Diagnostics.git /opt/tnd
cd /opt/tnd
npm ci --omit=dev
```

### 2. 生成 token、手动试跑

```sh
openssl rand -hex 24          # 生成一个 48 字符的共享密钥，抄下来
HUB_TOKEN=<上面生成的值> HUB_PORT=4000 node hub/hub.js
# [hub] Telematic Network Diagnostics hub v0.1.0 listening on 0.0.0.0:4000
```

`Ctrl-C` 停止。`HUB_PORT` 缺省 4000，`HUB_HOST` 缺省 `0.0.0.0`。

### 3. 交给 systemd 常驻

```sh
# 专用系统用户（无登录 shell、无家目录需求）
sudo useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin tnd-hub
sudo chown -R tnd-hub:tnd-hub /opt/tnd

# token 写进环境文件（600，仅 root 可读；不要写进 unit 文件——unit 是 644）
sudo install -m 600 /dev/null /etc/tnd-hub.env
sudo tee /etc/tnd-hub.env >/dev/null <<EOF
HUB_TOKEN=<你的 token>
HUB_PORT=4000
EOF

sudo cp /opt/tnd/hub/tnd-hub.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tnd-hub
systemctl status tnd-hub          # active (running) 即成功
```

（unit 文件逐项含义见文末。）

### 4. 开防火墙、连上试试

```sh
sudo ufw allow 4000/tcp
```

客户端（工具侧）连接地址：`ws://<VPS公网IP>:4000`。

## 正式路径：域名 + Caddy + `wss://`

推荐的生产形态：hub 只监听本机回环，公网入口由 Caddy 做 TLS 终结。
token 不再明文过公网，长连接也不会被中间设备干扰。

### 1. DNS

给你的域名加一条 A 记录，例如 `hub.example.com → <VPS公网IP>`。

### 2. 安装 Caddy

```sh
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
```

（官方安装文档：<https://caddyserver.com/docs/install>）

### 3. Caddyfile

```sh
sudo tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
hub.example.com {
    reverse_proxy 127.0.0.1:4000
}
EOF
sudo systemctl reload caddy
```

Caddy 会自动向 Let's Encrypt 申请并续期 `hub.example.com` 的证书，
WebSocket 升级（`ws → wss`）开箱即用，无需额外配置。把上面域名换成
你自己的。

### 4. 让 hub 只听本机

```sh
sudo tee /etc/tnd-hub.env >/dev/null <<EOF
HUB_TOKEN=<你的 token>
HUB_PORT=4000
HUB_HOST=127.0.0.1
EOF
sudo systemctl restart tnd-hub
```

公网只剩 443（Caddy）一个入口，4000 只在本机回环。

### 5. 连接地址

客户端（工具侧）连接地址：`wss://hub.example.com`。

## ws 与 wss 是什么

WebSocket（`ws://`）是浏览器/程序里"一条长连着的双向通道"，适合
持续测量这种每秒都在发消息的场景。`ws` 与 `wss` 的关系完全对应
`http` 与 `https`：

- `ws://` —— 明文。任何中间设备（公共 Wi-Fi、运营商 NAT）都能看到
  内容，包括握手里的 token；某些中间设备还会掐断闲置长连接。
- `wss://` —— WebSocket over TLS。加密、防篡改，中间设备只看得到
  你连了哪个域名。

这正是"快速路径先跑通、正式路径换 wss"的原因：协议一样，只换地址。

## systemd unit 逐项说明

`hub/tnd-hub.service`（随仓库）的要点：

| 配置 | 含义 |
| --- | --- |
| `User=tnd-hub` / `Group=tnd-hub` | 专用系统用户，权限最小化 |
| `WorkingDirectory=/opt/tnd` | 仓库 clone 的位置（按你的实际路径改） |
| `EnvironmentFile=/etc/tnd-hub.env` | token 等环境变量所在（600，root 专属） |
| `ExecStart=/usr/bin/node hub/hub.js` | 用 `which node` 确认 node 路径；nvm 装的 node 需写绝对路径 |
| `Restart=on-failure` / `RestartSec=3` | 崩溃 3 秒后自动拉起 |
| `NoNewPrivileges` / `PrivateTmp` / `ProtectSystem=strict` / `ProtectHome` | 沙箱加固：hub 无需写盘、无需提权 |

## 安全清单

- token 只经环境变量（`/etc/tnd-hub.env`）与握手参数传递，**不拼进
  URL**——URL 会泄进日志和历史记录。
- token 比较在 hub 内是常量时间的（先哈希再 `timingSafeEqual`），不
  逐字符泄露匹配进度。
- 快速路径（裸 ws）下 token 明文过公网，仅用于测试；正式路径一律
  `wss://`。
- 生产形态只暴露 443（Caddy），hub 本体只绑 `127.0.0.1`。
- 换 token：改 `/etc/tnd-hub.env` 后 `sudo systemctl restart tnd-hub`，
  并同步告知各站点工具侧。

## 排障

| 症状 | 排查 |
| --- | --- |
| 连接被拒（connect timeout / ECONNREFUSED） | `systemctl status tnd-hub` 是否 running；防火墙是否放行（快速路径 `ufw status`）；Caddy 路径确认 443 开放 |
| `connect_error: invalid hub token` | 两边 token 不一致：核对 `/etc/tnd-hub.env` 与客户端配置；改完记得 `systemctl restart tnd-hub` |
| wss 连不上、ws 能连 | DNS 是否生效（`dig hub.example.com`）；Caddy 证书是否签发（`journalctl -u caddy`） |
| hub 起不来 | `journalctl -u tnd-hub -n 50`——最常见是没设 `HUB_TOKEN`（hub 会拒绝启动）或 node 路径不对 |
| 升级 hub | `cd /opt/tnd && git pull && npm ci --omit=dev && sudo systemctl restart tnd-hub` |

## 客户端如何连（工具侧）

score server 侧的连接已随 issue #3 落地：设置四个环境变量（或打开
monitor 页填表单）即自动连接并开始测量（探测节奏与本地腿一致：2 秒
30 msg/s 突发 ↔ 2 秒 1 Hz 平静，自动交替）：

```sh
PNDS_HUB_URL=ws://<VPS公网IP>:4000 \
PNDS_HUB_TOKEN=<你的 token> \
PNDS_NODE_ID=site-a \
npm start          # 正式路径把 URL 换成 wss://hub.example.com
```

底层握手契约（freeze 自 hub v0.1）：

```js
// Node（socket.io-client）：
const socket = io("wss://hub.example.com", {
  auth: { token: "<HUB_TOKEN>", room: "rehearsal", node: "site-a" },
});

socket.on("welcome", ({ room, hubTime }) => { /* 房间确认 */ });
socket.on("relay", (body) => { /* body.from + body.hubReceivedAt 已盖戳 */ });
socket.emit("relay", { /* 任意 JSON，同房间其他节点收到 */ });
// RTT 测量（工具的 hub 腿）：发 echo、原样收带回戳的回包，往返计时在发送方
socket.emit("echo", { seq: 1, sentAt: Date.now() });
```

环境变量契约（App v1.3.0 冻结点）：`PNDS_NODE_ID` / `PNDS_HUB_URL`
（不含 token）/ `PNDS_HUB_TOKEN` / `PNDS_HUB_ROOM`（可选，缺省
`"default"`）。
