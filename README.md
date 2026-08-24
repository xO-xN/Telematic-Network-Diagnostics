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
  Wi-Fi (the Local Network Diagnostics logic).

The tool ships with its own relay: [`hub/hub.js`](hub/hub.js) — a
Socket.IO hub (token auth, rooms, hub receive timestamps) deployed from
source on a public VPS. No audio, no SuperCollider: the project runs
audio mode `none` only.

### Status

v0.1.0 base (issue #2): the de-templatized score server (performer /
monitor dual server, health, theme following) and the deployable hub.
The hub-leg measurement, the flower view and the local-leg diagnostics
land with issues #3–#5.

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

### Structure

```
hub/      The relay: hub.js + tnd-hub.service (systemd unit)
lib/      Reusable core (config / network / health / lifecycle /
          qr / theme-follow)
public/   Browser side (performer + monitor pages)
test/     node --test (config / integration / hub / theme-follow)
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
  Network Diagnostics 逻辑移植）。

工程自带中继：[`hub/hub.js`](hub/hub.js)——Socket.IO hub（token 鉴权、
房间、hub 接收时间戳），从源码部署在公网 VPS 上。无音频、无
SuperCollider：工程仅以 audio mode `none` 运行。

### 状态

v0.1.0 基础（issue #2）：去模板化后的 score server（performer /
monitor 双 server、health、主题跟随）+ 可部署的 hub。hub 腿测量、花
视图与本地腿诊断随 issue #3–#5 落地。

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

### 结构

```
hub/      中继：hub.js + tnd-hub.service（systemd unit）
lib/      可复用核心（config / network / health / lifecycle /
          qr / theme-follow）
public/   浏览器端（performer + monitor 页面）
test/     node --test（config / integration / hub / theme-follow）
docs/     hub 部署指南
```

### 许可证

MIT — 详见 [LICENSE](LICENSE)。
