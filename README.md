# Telematic Network Diagnostics

[English](#english) | [中文](#中文)

---

## English

A PNDS score project for cross-internet network diagnostics: before a
telematic (hub/star) performance, it answers the conductor's go/no-go
question — is the whole network playable right now, and if not, which
node and which leg is the problem?

It measures two legs (issue #1, v0.1.0 under construction):

- **Hub leg** — score server ↔ public hub, measured continuously.
  Latency is reported as a number only; quality (jitter, loss,
  reconnects) is what colors the status.
- **Local leg** — performer ↔ their site's score server over local
  Wi-Fi (the Local Network Diagnostics logic). On a LAN, latency
  participates in the coloring — a slow reply there is a real problem.

The tool ships with its own relay: [`hub/hub.js`](hub/hub.js) — a
Socket.IO hub (token auth, rooms, hub receive timestamps) deployed from
source on a public VPS. No audio, no SuperCollider: the project runs
audio mode `none` only.

### Status

v0.1.0 base (issue #2): the de-templatized score server (performer /
monitor dual server, health, theme following) and the deployable hub.
Hub leg + monitor connect form (issue #3) and the flower view
(issue #4) landed: the score server connects out to the hub (env or
form) and measures the hub leg continuously — the automatic probe
cycle matches the local leg's rhythm (2 s burst at 30 msg/s ↔ 2 s
calm at 1 Hz, no buttons). Every node relays its rolling stats
through the hub room, so each site's monitor shows the same picture:
an overall "suitable for performance" banner with fault attribution,
an inline-SVG star diagram (spokes = hub legs with RTT p50 labels and
quality colors, dashed when offline; outer rings = local legs), and
per-node cards with derived end-to-end numbers (site pair = two hub
legs; performer pair = local + hub + hub + local; big number +
composition formula).

The local leg landed with issue #5 (LND port): performers join from
their phones (scan the QR on the monitor — zero controls, the claim
token survives reconnects) and are probed automatically with the same
phase cycle. Per-performer cards with status, metrics and event log
sit in the monitor's local panel; a dropped performer is Red at once,
and the site's worst local status flows to every monitor through the
flower view — the banner then reads "问题在 X 站本地腿". The performer
page shows exactly two dots (this site's local leg, this site's hub
leg) and no cross-site details.

### Quick start

```sh
npm install
npm start        # performer page http://<LAN-IP>:6868/, monitor :6869/
```

### Running the hub

```sh
HUB_TOKEN=$(openssl rand -hex 24) HUB_PORT=4000 npm run hub
```

Deployment guide (systemd, Caddy + wss, bare-ws quick path):
[`docs/hub-deployment.md`](docs/hub-deployment.md).

### Hub connection (env contract — frozen, App v1.3.0)

The score server connects to the hub through either channel; both feed
one path, and a form submission replaces the env config:

| Env var | Meaning | Default |
| --- | --- | --- |
| `PNDS_HUB_URL` | Hub URL (never carries the token), e.g. `wss://hub.example.com` | — |
| `PNDS_HUB_TOKEN` | Shared secret (independent env var — never in the URL, so it stays out of logs) | — |
| `PNDS_HUB_ROOM` | Room name | `"default"` |
| `PNDS_NODE_ID` | This node's display name | host name |

With the env present at boot the server auto-connects without opening
the monitor. The monitor form (hub URL / token / room / node name)
persists in the browser's localStorage and prefills from the env; a
saved form value wins over the env default. Opening the monitor
auto-starts measuring — zero buttons.

### Structure

```
hub/      The relay: hub.js + tnd-hub.service (systemd unit)
lib/      Reusable core (config / network / health / lifecycle /
          qr / theme-follow / status / hub-leg / local-leg + players /
          flower)
public/   Browser side (performer + monitor pages)
test/     node --test (config / integration / hub / hub-leg /
          local-leg / players / flower / pages / theme-follow)
docs/     Hub deployment guide
```

### License

MIT — see [LICENSE](LICENSE).

---

## 中文

跨互联网网络诊断 PNDS 工程：在 telematic（hub/star 星型）演出前回答
conductor 的 go/no-go 问题——此刻整个网络适合演奏吗？如果不适合，问题
在哪个节点、哪一段？

两层测量（issue #1，v0.1.0 施工中）：

- **hub 腿**——score server ↔ 公网 hub，持续测量。延迟只标数字；抖动、
  丢包、重连这类质量指标才决定状态颜色。
- **本地腿**——performer ↔ 本站 score server 的局域网 Wi-Fi（Local
  Network Diagnostics 逻辑移植）。局域网内延迟参与染色——那里慢就是
  真问题。

工程自带中继：[`hub/hub.js`](hub/hub.js)——Socket.IO hub（token 鉴权、
房间、hub 接收时间戳），从源码部署在公网 VPS 上。无音频、无
SuperCollider：工程仅以 audio mode `none` 运行。

### 状态

v0.1.0 基础（issue #2）：去模板化后的 score server（performer /
monitor 双 server、health、主题跟随）+ 可部署的 hub。hub 腿测量 +
monitor 连接表单（issue #3）与花视图（issue #4）已落地：score server
出站连接 hub（env 或表单），以与本地腿一致的节奏持续测量（2 秒
30 msg/s 突发 ↔ 2 秒 1 Hz 平静自动交替，无任何按钮）。各节点把滚动统
计经 hub 房间中继互达，每个站点的 monitor 看到同一份画面：全网
"适宜演奏"横幅（取最差 + 故障归属定位）、内联 SVG 星型图（辐条 = hub
腿，标注 RTT p50、质量色，断线虚线；外环 = 本地腿）、每节点卡片与推
导端到端数字（站点对 = 两条 hub 腿；演奏者对 = 本地 + hub + hub +
本地；大数字 + 小字构成式）。

本地腿随 issue #5 落地（LND 移植）：演奏者手机扫码即加入（零操作，
claim token 保证重连找回身份），自动接受基线 + 突发探测。monitor 的本
地腿面板逐个显示演奏者状态、指标与事件日志；演奏者掉线立即变红，站
点最差本地状态经花视图流到每个 monitor——横幅会写"问题在 X 站本地
腿"。演奏者页只有两个状态点（本站本地腿、本站 hub 腿），没有任何跨
站细节。

### 快速开始

```sh
npm install
npm start        # 演奏者页 http://<局域网IP>:6868/，监视端 :6869/
```

### 运行 hub

```sh
HUB_TOKEN=$(openssl rand -hex 24) HUB_PORT=4000 npm run hub
```

部署指南（systemd、Caddy + wss、裸 ws 快速路径）：
[`docs/hub-deployment.md`](docs/hub-deployment.md)。

### hub 连接（env 契约——已冻结，App v1.3.0）

score server 经两条通道之一连接 hub；两条通道汇入同一条路径，表单提交
会替换 env 配置：

| 环境变量 | 含义 | 缺省 |
| --- | --- | --- |
| `PNDS_HUB_URL` | hub 地址（不含 token），如 `wss://hub.example.com` | — |
| `PNDS_HUB_TOKEN` | 共享密钥（独立 env——绝不拼进 URL，避免泄进日志） | — |
| `PNDS_HUB_ROOM` | 房间名 | `"default"` |
| `PNDS_NODE_ID` | 本节点显示名 | 主机名 |

env 在启动时存在即自动连接，无需打开 monitor。monitor 表单（hub URL /
token / room / 节点名）持久化在浏览器 localStorage 并以 env 预填；已保
存的表单值优先于 env 缺省。打开 monitor 即自动开测——零按钮。

### 结构

```
hub/      中继：hub.js + tnd-hub.service（systemd unit）
lib/      可复用核心（config / network / health / lifecycle /
          qr / theme-follow / status / hub-leg / local-leg + players /
          flower）
public/   浏览器端（performer + monitor 页面）
test/     node --test（config / integration / hub / hub-leg /
          local-leg / players / flower / pages / theme-follow）
docs/     hub 部署指南
```

### 许可证

MIT — 详见 [LICENSE](LICENSE)。
