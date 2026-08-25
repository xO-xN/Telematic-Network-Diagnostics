# Telematic Network Diagnostics

[English](#english) | [中文](#中文)

---

## English

A PNDS score project for cross-internet network diagnostics: before a
telematic (hub/star) performance, it answers the conductor's go/no-go
question — is the whole network playable right now, and if not, which
node and which leg is the problem?

It measures two legs (issue #1):

- **Hub leg** — score server ↔ public hub, measured continuously.
  Latency is reported as a number only; quality (jitter, loss,
  reconnects) is what colors the status. A high-but-stable
  intercontinental RTT can be tempered for — jitter and loss cannot.
- **Local leg** — performer ↔ their site's score server over local
  Wi-Fi (the Local Network Diagnostics logic). On a LAN, latency
  participates in the coloring — a slow reply there is a real problem.

The tool ships with its own relay: [`hub/hub.js`](hub/hub.js) — a
Socket.IO hub (token auth, rooms, hub receive timestamps) deployed from
source on a public VPS. No audio, no SuperCollider: the project runs
audio mode `none` only.

### What you get

- **Flower view** — every site's monitor shows the same picture,
  assembled from what each node self-reports over the hub room: an
  overall "suitable for performance" banner with fault attribution
  ("问题在 site-b 本地腿" — which site, which leg), an inline-SVG star
  diagram (hub centered; spokes = hub legs with RTT p50 labels and
  quality colors, dashed when offline; outer rings = each site's local
  worst), per-node cards, and this site's performer panel.
- **Hub leg measurement** — continuous echo probes with an automatic
  phase cycle (2 s burst at 30 msg/s ↔ 2 s calm at 1 Hz — no buttons
  anywhere): RTT p50/p95, jitter (IQR), loss, reconnects, one-way
  estimate ≈ RTT/2.
- **Local leg measurement** — performers join from their phones (scan
  the QR — zero controls; a claim token survives reconnects) and are
  probed automatically with the same phase cycle and LND's thresholds.
  Per-performer cards with status, metrics and event log; a dropped
  performer is Red at once and the site's worst local status flows to
  every monitor.
- **Derived end-to-end numbers** — the star topology has no direct
  site-to-site link, so the numbers are sums of measured segments,
  never a third measurement layer: site pair = two hub-leg p50s;
  performer pair = local + hub + hub + local (big number, small
  composition formula; null while any segment is unmeasured).
- **Performer page** — LND-minimal: "已连接，测试中…" plus exactly two
  site-level dots (this site's local leg, this site's hub leg), no
  cross-site details.
- **A deployable hub** — token auth (timing-safe comparison), rooms,
  relay with sender stamps, systemd unit + Caddy/wss guide.
- **Theme & locale following** — inside PNDS App (theme ≥ v1.2.3,
  locale ≥ v1.3.0) the monitor page follows the App's color theme
  (all four themes) via the `pnds:theme` bridge and the App's language
  (English / 简体中文) via the `pnds:locale` bridge and the `?lang=`
  first-frame parameter — every label, status line, reason and event
  renders live in the App's language; the performer page stays as-is.

### Status

v0.2.0 (issue #7): locale following — the monitor page follows the
App's language (`pnds:locale` bridge + `?lang=` first frame) and
renders its whole console through bilingual copy tables (default
Chinese, this project's historical UI); server-side reasons became
language-neutral keys so the wire carries no prose.

v0.1.0 complete (issues #2–#6): de-templatized score server (performer
/ monitor dual server, health, theme following), the deployable hub,
hub-leg measurement + monitor connect form, the flower view, and the
local leg with performer status page. Quality thresholds are 初版 —
calibration against a real two-node deployment is the expected
post-release step.

### Quick start (one site, no hub yet)

```sh
npm install
npm start        # performer page http://<LAN-IP>:6868/, monitor :6869/
```

Open the monitor, scan the QR with a phone: the phone is measured
automatically (local panel), and its dot shows on the performer page.
The hub leg stays idle until a hub is configured.

### Two-site walkthrough

The rehearsal-day path: a hub on a public VPS, two sites behind
different NATs, phones on each site's Wi-Fi.

1. **Start the hub on a VPS** (any small public box, Node ≥ 20):

   ```sh
   git clone https://github.com/xO-xN/Telematic-Network-Diagnostics.git
   cd Telematic-Network-Diagnostics
   npm ci --omit=dev
   HUB_TOKEN=$(openssl rand -hex 24) HUB_PORT=4000 npm run hub
   ```

   Allow the port through the firewall (`ufw allow 4000` for the bare
   ws quick path). For production use wss behind Caddy + systemd —
   the full guide is [`docs/hub-deployment.md`](docs/hub-deployment.md).
   Note the token: every site needs the SAME token.

2. **Start site A.** Install the `.pnds` bundle into PNDS App (⌘O) or
   run from source (`npm install && npm start`). Open the monitor
   `http://<LAN-IP>:6869/`, fill the connection form — hub URL
   (`http://<VPS-IP>:4000`, or `wss://hub.example.com` behind Caddy),
   token, room, node name `site-a` — and click 连接. Or skip the form:
   set the `PNDS_HUB_*` environment variables (below) and the server
   connects at boot.

3. **Start site B** the same way, node name `site-b`, same token and
   room. Each site's score server makes its own OUTBOUND connection to
   the hub — no port forwarding on either site.

4. **Performers join.** On each site, phones scan the monitor's QR and
   open the performer page. They are measured from their first second
   (baseline + automatic bursts; zero controls), and each phone shows
   its two dots: this site's local leg, this site's hub leg.

5. **Read the monitor** — both sites see the same flower view; see
   [Reading the results](#reading-the-results).

### Reading the results

The **overall banner** is worst-wins across every leg of every node —
no weighting. Green: 适宜演奏. Red: 不适宜演出, with plain attribution
("问题在 site-b 本地腿" / "临界： 本站公网腿"). A gray banner means still
measuring.

The **star diagram**: spokes are hub legs (color = quality, label =
that node's self-reported RTT p50, dashed = offline); each node's outer
ring is its local-leg worst (gray = no performer has joined there).

**When a leg turns red, the thresholds behind it:**

| Leg | Red when | Yellow when | Green when | Latency colors? |
| --- | --- | --- | --- | --- |
| Hub (公网腿) | unreachable, jitter (IQR) ≥ 30 ms, loss ≥ 3%, or ≥ 2 reconnects in 15 s | anything between red and green (incl. exactly one reconnect) | jitter < 10 ms, loss < 0.5%, 0 reconnects | **Never** — reported as a plain number |
| Local (本地腿) | disconnected, 3 consecutive probe timeouts, burst loss > 5% | jitter p95 > 25 ms, RTT p95 > 100 ms, 1–2 timeouts, or between thresholds | jitter < 10 ms and RTT p95 < 50 ms | **Yes** — on a LAN, slow is broken |

All thresholds are 初版，待两节点实测校准 (calibration against a real
two-node deployment is an expected post-release step).

**The numbers** (cards, per performer): RTT p50/p95 are plain round
trips — never colored on the hub leg. One-way ≈ RTT p50 / 2 (the
estimate a future tempering compensation would consume). Jitter is
IQR (p75 − p25) on the hub leg, p95 of adjacent RTT diffs on the local
leg. The two derived end-to-end numbers are sums of measured segments:
site pair = own hub p50 + peer hub p50; performer pair = local + hub +
hub + local (each local segment = that site's worst online performer's
p50). A derived number shows "—" while any segment is unmeasured — the
formula never sums a guess.

**The event logs**: the hub-leg log records connect / disconnect /
reconnect with reasons (a wrong URL or token shows up here as "connect
failed"); each performer card carries its connected / disconnected /
reconnected timeline. A performer whose Wi-Fi drops is Red at once and
stays on the card until it reconnects (claim token recovers the id).

### Hub connection (env contract — frozen, App v1.3.0)

The score server connects to the hub through either channel; both feed
one path, and a form submission replaces the env config:

| Env var | Meaning | Default |
| --- | --- | --- |
| `PNDS_NODE_ID` | This node's display name in the flower view | host name |
| `PNDS_HUB_URL` | Hub URL — **never carries the token**, e.g. `wss://hub.example.com` | — |
| `PNDS_HUB_TOKEN` | Shared secret | — |
| `PNDS_HUB_ROOM` | Room name (optional) | `"default"` |

The token is a SEPARATE env var and never rides the URL: URLs leak
into server logs, browser history, and proxy logs — a credential in
the query string is copied before anyone notices. The monitor form
follows the same rule. The four variables are App v1.3.0's frozen
injection contract: present at boot, the server auto-connects without
opening the monitor, and the monitor form prefills from them (a saved
form value wins over the env default). Opening the monitor
auto-starts measuring — zero buttons.

### Running the hub

```sh
HUB_TOKEN=$(openssl rand -hex 24) HUB_PORT=4000 npm run hub
```

Deployment guide (systemd, Caddy + wss, bare-ws quick path):
[`docs/hub-deployment.md`](docs/hub-deployment.md).

### Structure

```
hub/      The relay: hub.js + tnd-hub.service (systemd unit) — NOT in the .pnds
lib/      Reusable core (config / network / health / lifecycle /
          qr / theme-follow / locale-follow / status / hub-leg /
          local-leg + players / flower)
public/   Browser side (performer + monitor pages; shared.js holds the
          bilingual copy tables)
test/     node --test (config / integration / hub / hub-leg /
          local-leg / players / flower / pages / theme-follow /
          locale-follow)
docs/     Hub deployment guide
```

### License

MIT — see [LICENSE](LICENSE).

---

## 中文

跨互联网网络诊断 PNDS 工程：在 telematic（hub/star 星型）演出前回答
conductor 的 go/no-go 问题——此刻整个网络适合演奏吗？如果不适合，问题
在哪个节点、哪一段？

两层测量（issue #1）：

- **hub 腿**——score server ↔ 公网 hub，持续测量。延迟只标数字；抖动、
  丢包、重连这类质量指标才决定状态颜色。高而稳的跨洲 RTT 可以用补偿
  对付；抖动和丢包不行。
- **本地腿**——performer ↔ 本站 score server 的局域网 Wi-Fi（Local
  Network Diagnostics 逻辑移植）。局域网内延迟参与染色——那里慢就是
  真问题。

工程自带中继：[`hub/hub.js`](hub/hub.js)——Socket.IO hub（token 鉴权、
房间、hub 接收时间戳），从源码部署在公网 VPS 上。无音频、无
SuperCollider：工程仅以 audio mode `none` 运行。

### 功能清单

- **花视图**——每个站点的 monitor 显示同一份画面，由各节点经 hub 房间
  自报拼装：全网"适宜演奏"横幅（取最差 + 故障归属："问题在 site-b
  本地腿"——哪个站、哪一段）、内联 SVG 星型图（hub 居中；辐条 = hub
  腿，标注 RTT p50、质量色，断线虚线；外环 = 各站本地腿最差状态）、
  每节点卡片、本站演奏者面板。
- **hub 腿测量**——持续 echo 探测，相位自动交替（2 秒 30 msg/s 突发 ↔
  2 秒 1 Hz 平静——全程无按钮）：RTT p50/p95、抖动（IQR）、丢包、重连、
  单程估计 ≈ RTT/2。
- **本地腿测量**——演奏者手机扫码即加入（零操作；claim token 保证重连
  找回身份），以相同相位节奏与 LND 阈值自动受测。逐演奏者卡片含状态、
  指标与事件日志；掉线立即变红，站点最差本地状态流到每个 monitor。
- **推导端到端数字**——星型拓扑没有站点直连，数字是实测段之和，绝非
  第三层测量：站点对 = 两条 hub 腿 p50；演奏者对 = 本地 + hub + hub +
  本地（大数字 + 小字构成式；任一段未测出即为空）。
- **演奏者页**——LND 极简："已连接，测试中…" + 恰好两个站点级状态点
  （本站本地腿、本站 hub 腿），无任何跨站细节。
- **可部署 hub**——token 鉴权（timing-safe 比较）、房间、带发送方戳的
  中继、systemd unit + Caddy/wss 指南。
- **主题与语言跟随**——在 PNDS App 中运行时（主题 ≥ v1.2.3、语言 ≥
  v1.3.0），monitor 页通过 `pnds:theme` 消息跟随 App 主题（全部四套），
  通过 `pnds:locale` 消息与 `?lang=` 首帧参数实时跟随 App 语言
  （English / 简体中文）——所有标签、状态文案、原因与事件随 App 语言
  即时切换；performer 页保持原样。

### 状态

v0.2.0（issue #7）：语言跟随——monitor 页跟随 App 语言（`pnds:locale`
消息 + `?lang=` 首帧参数），全部界面经双语文案表渲染（默认中文，即本
工程的历史界面）；server 侧 reason 改为语言中立 key，线协议不再携带
散文。

v0.1.0 完成（issue #2–#6）：去模板化 score server（performer /
monitor 双 server、health、主题跟随）、可部署 hub、hub 腿测量 +
monitor 连接表单、花视图、本地腿与演奏者状态页。质量阈值为初版——
发布后以真实两节点部署校准是既定步骤。

### 快速开始（单站点，暂无 hub）

```sh
npm install
npm start        # 演奏者页 http://<局域网IP>:6868/，监视端 :6869/
```

打开 monitor，手机扫二维码：手机即被自动测量（本地腿面板），演奏者页
亮起两个状态点。hub 腿在配置 hub 前保持空闲。

### 两站点实测走查

排练日路径：公网 VPS 上的 hub、两个不同 NAT 后的站点、各自 Wi-Fi 上
的手机。

1. **在 VPS 上起 hub**（任意小型公网机器，Node ≥ 20）：

   ```sh
   git clone https://github.com/xO-xN/Telematic-Network-Diagnostics.git
   cd Telematic-Network-Diagnostics
   npm ci --omit=dev
   HUB_TOKEN=$(openssl rand -hex 24) HUB_PORT=4000 npm run hub
   ```

   防火墙放行端口（裸 ws 快速路径 `ufw allow 4000`）。生产环境走
   Caddy + systemd 的 wss——完整指南见
   [`docs/hub-deployment.md`](docs/hub-deployment.md)。记下 token：所有
   站点用同一个。

2. **启动站点 A。** 把 `.pnds` 装进 PNDS App（⌘O）或源码运行
   （`npm install && npm start`）。打开 monitor
   `http://<局域网IP>:6869/`，填连接表单——hub 地址
   （`http://<VPS-IP>:4000`，或 Caddy 后的 `wss://hub.example.com`）、
   token、room、节点名 `site-a`——点连接。也可以跳过表单：设好下面的
   `PNDS_HUB_*` 环境变量，服务器开机即连。

3. **同样启动站点 B**，节点名 `site-b`，token 与 room 相同。每个站点
   的 score server 都是自己出站连 hub——两边都不需要端口转发。

4. **演奏者加入。** 各站点手机扫 monitor 上的二维码打开演奏者页。从
   第一秒起被测量（基线 + 自动突发；零操作），每台手机显示两个状态
   点：本站本地腿、本站 hub 腿。

5. **读 monitor**——两站看到同一份花视图；见
   [解读结果](#解读结果)。

### 解读结果

**overall 横幅**取全网所有腿的最差，不加权。绿：适宜演奏。红：不适宜
演出，并给出通俗归属（"问题在 site-b 本地腿" / "临界： 本站公网腿"）。
灰色横幅 = 还在测量。

**星型图**：辐条是 hub 腿（颜色 = 质量，标注 = 该节点自报的 RTT p50，
虚线 = 离线）；每个节点的外环是其本地腿最差状态（灰 = 该站尚无演奏者
加入）。

**腿变红时，背后的阈值：**

| 腿 | 红条件 | 黄条件 | 绿条件 | 延迟染色？ |
| --- | --- | --- | --- | --- |
| hub（公网腿） | 不可达、抖动 (IQR) ≥ 30 ms、丢包 ≥ 3%、15 秒内 ≥ 2 次重连 | 红绿之间（含恰好一次重连） | 抖动 < 10 ms、丢包 < 0.5%、0 重连 | **从不**——只标数字 |
| 本地（本地腿） | 断线、连续 3 次探测超时、突发丢包 > 5% | 抖动 p95 > 25 ms、RTT p95 > 100 ms、1–2 次超时、或介于阈值之间 | 抖动 < 10 ms 且 RTT p95 < 50 ms | **是**——局域网内慢即故障 |

所有阈值均为初版，待两节点实测校准。

**数字**（卡片、逐演奏者）：RTT p50/p95 是普通往返时间——hub 腿上从不
染色。单程 ≈ RTT p50 / 2（未来延迟补偿要用的估计值）。抖动在 hub 腿是
IQR（p75 − p25），在本地腿是相邻 RTT 差的 p95。两个推导端到端数字是
实测段之和：站点对 = 本站 hub p50 + 对站 hub p50；演奏者对 = 本地 +
hub + hub + 本地（本地段取该站在线演奏者中最差的 p50）。任一段未测出
时推导数字显示"—"——构成式从不拼凑猜测值。

**事件日志**：hub 腿日志记录 connect / disconnect / reconnect 及原因
（错误的 URL 或 token 在这里立刻显示为 "connect failed"）；每张演奏者
卡片带自己的 connected / disconnected / reconnected 时间线。Wi-Fi 掉线
的演奏者立即变红并留在卡片上，直到重连（claim token 找回身份）。

### hub 连接（env 契约——已冻结，App v1.3.0）

score server 经两条通道之一连接 hub；两条通道汇入同一条路径，表单提交
会替换 env 配置：

| 环境变量 | 含义 | 缺省 |
| --- | --- | --- |
| `PNDS_NODE_ID` | 本节点在花视图中的显示名 | 主机名 |
| `PNDS_HUB_URL` | hub 地址——**不含 token**，如 `wss://hub.example.com` | — |
| `PNDS_HUB_TOKEN` | 共享密钥 | — |
| `PNDS_HUB_ROOM` | 房间名（可选） | `"default"` |

token 是独立的环境变量，绝不拼进 URL：URL 会泄进服务器日志、浏览器
历史和代理日志——查询串里的凭据总在有人注意之前就被复制走。monitor
表单遵守同一条规则。这四个变量是 App v1.3.0 冻结的注入契约：启动时存
在即自动连接（无需打开 monitor），monitor 表单以它们预填（已保存的表单
值优先于 env 缺省）。打开 monitor 即自动开测——零按钮。

### 运行 hub

```sh
HUB_TOKEN=$(openssl rand -hex 24) HUB_PORT=4000 npm run hub
```

部署指南（systemd、Caddy + wss、裸 ws 快速路径）：
[`docs/hub-deployment.md`](docs/hub-deployment.md)。

### 结构

```
hub/      中继：hub.js + tnd-hub.service（systemd unit）——不进 .pnds
lib/      可复用核心（config / network / health / lifecycle /
          qr / theme-follow / locale-follow / status / hub-leg /
          local-leg + players / flower）
public/   浏览器端（performer + monitor 页面；shared.js 存双语文案表）
test/     node --test（config / integration / hub / hub-leg /
          local-leg / players / flower / pages / theme-follow /
          locale-follow）
docs/     hub 部署指南
```

### 许可证

MIT — 详见 [LICENSE](LICENSE)。
