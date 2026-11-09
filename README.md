# Telematic Network Diagnostics

[English](#english) · [中文](#中文)

## English

An internet-only PNDS diagnostic. Each node measures its outbound connection to
the public HUB, shares its readings within the room, and shows them in one
compact geographic or topology view. The project runs with audio mode `none`.

Version 0.8.0 introduces the internet-only diagnostic and regional map. PNDS App
fetches the verified version and checksum pinned in its own `utilities.json`;
updating the tool source alone does not change that built-in reference.

### Reading the diagnostic

- Geographic view fits the nodes and the known HUB position with a little margin.
  The background is a local, simplified continental land outline. There are no
  map tiles, administrative boundaries, or map-library downloads.
- Node colors identify nodes consistently in the map, connection lines and table.
  Nearby nodes keep their real projected positions. Only the local-node marker
  stays labeled. Hover or keyboard focus highlights the corresponding row and
  details below; click fixes the selected node. Topology remains available for
  nodes with unknown or coincident geographic positions.
- Quality is a separate text/status indicator. The 15-second rolling measurement
  reports RTT p50/p95, jitter (IQR), loss and reconnects. RTT magnitude does not
  determine quality: a long, stable international path can still be stable.
- A stale remote node keeps its last location, but its old readings cease to be
  presented as live. If this node loses HUB connectivity, remote states become
  unconfirmed; the tool cannot diagnose a remote outage through its own outage.
- Both PNDS HTTP entry points display this same internet diagnostic. Browser
  observers are not enrolled as performers, and there are no phone joins, local
  Wi-Fi probes, performer-removal controls or end-to-end audio verdicts.

The current quality bands are initial values awaiting actual two-node public
network calibration:

| State | Internet connection criteria |
| --- | --- |
| Sampling | Fewer than 5 samples without enough negative evidence |
| Stable | Jitter < 10 ms, loss < 0.5%, no reconnect in 15 s |
| Attention | Between the stable and abnormal bands, including one reconnect |
| Abnormal | Disconnected, jitter ≥ 30 ms, loss ≥ 3%, or ≥ 2 reconnects in 15 s |

### Location and HUB compatibility

Location metadata comes from the HUB. With the extended network protocol, the
HUB observes the node's public exit IP and may return an estimated city location.
IP location is approximate: it does not establish a district, street, venue, or
device location. A missing lookup leaves the node in the unknown-location list;
it does not stop network measurements. The legacy HUB also remains usable for
measurements and topology without geographic metadata.

A node's location can be corrected for the current diagnostic session using latitude, longitude and an optional
label. Clearing the correction restores automatic
estimation. It survives this node's transport reconnects and explicit retries,
but is discarded when the diagnostic process ends or the node/HUB/room changes.
It is not an App preference and never changes another node's location.

The HUB marker uses the deployment's configured location. The Nanjing position
in the design prototype was an example, not a production default. With no valid
HUB location metadata, the tool leaves it unknown rather than guessing from a
host name or URL.

The HUB source in `hub/` and the separate `pnds-hub` deployment both accept:

| Environment variable | Meaning |
| --- | --- |
| `HUB_LOCATION_LABEL` | Optional label for the HUB location |
| `HUB_LOCATION_LATITUDE` / `HUB_LOCATION_LONGITUDE` | Complete valid coordinate pair for the HUB |
| `HUB_GEO_API_KEY` | Optional server-only key for the IP location provider |
| `HUB_TRUST_PROXY` | Comma-separated exact proxy IP allowlist for forwarded node IPs |

The extended HUB queries `https://api.ipapi.is/` for eligible public IPs, using a
bounded cache and request budget. The query goes from HUB to that provider;
location service keys are never sent to node pages. An untrusted forwarded-IP
header is ignored. API failure, exhaustion or unavailable metadata all retain
unknown-location behavior. The public HUB is deployed separately from the tool
bundle; releasing this project does not upgrade an existing HUB.

### Run and configure

In PNDS App, open the installed tool from Utilities. A compatible Host supplies
these values; the server automatically connects when URL and token are present:

| Environment variable | Meaning | Default |
| --- | --- | --- |
| `PNDS_HUB_URL` | Complete HUB URL without a token | — |
| `PNDS_HUB_TOKEN` | Shared connection secret | — |
| `PNDS_HUB_ROOM` | App-derived room | `default` |
| `PNDS_NODE_ID` | Node identity within the room | Host name |

The monitor uses the App's effective configuration and read-only derived room.
Standalone development also supports a connection form. A connected identical
submission leaves the rolling measurement intact; retrying a disconnected
connection starts a new attempt. Invalid-token errors remain visible until the
connection succeeds with accepted credentials.

```sh
npm ci
npm start
```

The manifest's default HTTP entries are `http://127.0.0.1:6868/` and
`http://127.0.0.1:6869/`. Standalone dependencies come from npm; packaged projects
use the exact App shared-library versions declared in `manifest.json`. See
[shared libraries](docs/shared-libraries.md). In the App, the diagnostic follows
Pond, Sand, Stage and Brutal themes and English/简体中文 locale messages.

To check the source:

```sh
npm run check
npm test
```

Tests use controlled loopback HUB/score-server fixtures, including legacy HUB
compatibility, two-node statistics, configuration/retry, location correction,
health and shutdown. They do not contact the public geolocation service or prove
real two-node internet performance.

### Structure

```text
server.js  Two HTTP entries, health and observer state/configuration protocol
lib/       HUB measurement, aggregation, runtime and App bridges
public/    One diagnostic UI, local land geometry, geographic projection
hub/       Deployable relay with optional location metadata; not in .pnds
test/      Unit, page and controlled loopback integration tests
docs/      Deployment, shared-library and UI contracts
```

The included relay can be run with `HUB_TOKEN=<secret> npm run hub`; deployment
steps are in [the HUB guide](docs/hub-deployment.md). It supports the same optional
network metadata and IP lookup as the separately maintained `pnds-hub` source.
Neither source update automatically changes an existing deployed HUB.

## 中文

仅诊断互联网连接的 PNDS 工具工程。每个节点持续测量自己到公网 HUB 的
链路，在房间内共享读数，以简洁的地理／拓扑视图查看。工程使用 audio mode
`none`，没有音频引擎。

0.8.0 版改为仅诊断公网链路，并加入区域地图。PNDS App 按自身
`utilities.json` 中固定的版本及校验和拉取已验证工具；更新工具源码本身
不会改变 App 的内置引用。

### 查看诊断

- 地理视图按节点和已知 HUB 位置自动取景，保留适量边距。底图只有随工程
  携带的简化大陆轮廓，没有地图瓦片、省市边界或地图运行库下载。
- 颜色区分节点，在圆点、连线和表格色点中保持一致。相近节点不偏移坐标；
  地图只常显“本站”。悬停或键盘聚焦节点时高亮下方对应行与详情，点击可
  固定选择。位置未知或重合时仍可从列表选择，并切换拓扑视图。
- 质量由单独的状态文案及状态色表达。最近 15 秒的滚动读数包含 RTT
  p50/p95、抖动（IQR）、丢包及重连。RTT 大小不参与质量判定：较远但
  稳定的公网路径仍可显示稳定。
- 远端停止更新时保留上次位置，隐藏过期实时读数。本站到 HUB 断开时，
  远端改为待确认；本站断线不能证明远端也发生故障。
- PNDS 的两个 HTTP 入口显示相同的公网诊断。浏览页面不会注册演奏者，
  没有手机加入、局域网探测、演奏者移除或端到端音频可演奏性判定。

质量阈值为初版，仍待两个真实公网节点实测校准：

| 状态 | 公网链路条件 |
| --- | --- |
| 采样中 | 少于 5 个样本且没有足够异常证据 |
| 稳定 | 抖动 < 10 ms、丢包 < 0.5%、15 秒内未重连 |
| 需注意 | 稳定与异常之间，包括一次重连 |
| 异常 | 断线、抖动 ≥ 30 ms、丢包 ≥ 3%，或 15 秒内重连 ≥ 2 次 |

### 位置和 HUB 兼容

位置元数据由 HUB 提供。支持扩展协议的 HUB 可观察节点的公网出口 IP，
查询其大致城市位置。IP 定位不能保证区县、街道、场地或设备的真实位置。
查询不到时节点进入位置未知列表，链路测量继续。旧 HUB 仍可用于测量和
拓扑视图，只是没有地理元数据。

可用纬度、经度和可选位置名称校正本站在本次诊断会话中的位置；清除校正后
恢复自动估计。校正可跨传输重连和显式重试保留，诊断进程结束，或节点、
HUB、房间改变后丢弃。它不写入 App 偏好，也不修改其他节点。

HUB 标记采用部署时提供的位置。设计原型中的南京只是示例，正式实现没有
南京默认值。未配置有效 HUB 位置时保持未知，不从域名或 URL 猜测。

`hub/` 中继源码与独立 `pnds-hub` 均支持以下部署参数：

| 环境变量 | 用途 |
| --- | --- |
| `HUB_LOCATION_LABEL` | 可选的中继位置名称 |
| `HUB_LOCATION_LATITUDE` / `HUB_LOCATION_LONGITUDE` | 完整有效的中继经纬度 |
| `HUB_GEO_API_KEY` | 可选的 IP 定位服务密钥，仅 HUB 服务端使用 |
| `HUB_TRUST_PROXY` | 逗号分隔的可信代理精确 IP 列表 |

扩展 HUB 通过 `https://api.ipapi.is/` 查询符合条件的公网 IP，并使用有上限的
缓存和请求预算。请求由 HUB 发往定位服务，密钥不会交给节点页面。不可信
来源的转发 IP 请求头会被忽略。服务失败、额度耗尽或缺少元数据时均保持
位置未知。公网 HUB 与工具工程包分别部署；发布本工具不会自动升级现有 HUB。

### 运行与连接

在 PNDS App 的工具列表中打开工程。Host 提供下列配置；URL 与 token
在场时，服务端自动连接：

| 环境变量 | 含义 | 缺省 |
| --- | --- | --- |
| `PNDS_HUB_URL` | 不含 token 的完整 HUB URL | — |
| `PNDS_HUB_TOKEN` | 连接共享密钥 | — |
| `PNDS_HUB_ROOM` | App 推导的房间 | `default` |
| `PNDS_NODE_ID` | 房间内的节点身份 | 主机名 |

监视端采用 App 的生效配置，派生房间只读展示。源码独立运行时仍可填写
连接表单。已连接时重复提交同一配置不会重置测量；断开后重试会发起新的
连接。认证失败会保留明确原因，直到正确凭据通过 HUB 认证。

```sh
npm ci
npm start
```

manifest 中的默认入口是 `http://127.0.0.1:6868/` 与
`http://127.0.0.1:6869/`。源码独立运行采用 npm 依赖；打包工程使用
`manifest.json` 指定的 App 共享库，见[共享库说明](docs/shared-libraries.md)。
在 App 内跟随 Pond、Sand、Stage、Brutal 四套主题及中英文语言消息。

```sh
npm run check
npm test
```

测试使用受控 loopback HUB／score server，覆盖旧 HUB 兼容、双节点统计、
配置／重试、位置校正、health 及关停。测试不请求公网定位服务，也不能代替
两个真实公网节点的性能验收。

### 文件结构

```text
server.js  双 HTTP 入口、health、观察页面的状态与配置协议
lib/       HUB 测量、汇总、运行时及 App 桥
public/    统一诊断页面、本地大陆轮廓与地理投影
hub/       支持可选位置元数据的可部署中继，不进入 .pnds
test/      单元、页面及受控 loopback 集成测试
docs/      部署、共享库及 UI 契约
```

自带中继可用 `HUB_TOKEN=<secret> npm run hub` 启动，见
[HUB 部署指南](docs/hub-deployment.md)。它与独立维护的 `pnds-hub` 源码支持
相同的可选位置元数据及 IP 查询。源码更新不会自动改变已经部署的 HUB。

## License

MIT — see [LICENSE](LICENSE).
