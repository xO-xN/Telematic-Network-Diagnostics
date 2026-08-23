# PNDS Template — Creator Guide（创作者开始指南）

这是一个可直接运行的 PNDS 数字乐谱工程骨架，带最小功能实现，适合作为新作品的起点。

## 快速开始

### 1. 安装依赖

PNDS App **不执行 npm install**，所以工程必须自带可用的 `node_modules/`。首次使用本模板：

```sh
npm install
```

依赖只有四个：`express`、`socket.io`、`osc-min`、`qrcode`。

### 2. 运行

脱离 App 单独调试：

```sh
npm run dev:none    # 无音频模式（只测试页面与网络）
npm run dev         # Internal 模式（需本机 scsynth 在 57110 端口）
```

在 PNDS App 中运行：App 中点击 **Open**，选择本文件夹，音频模式选 **Internal Synth**。

### 3. 两个页面

| 页面 | 地址 | 用途 |
|---|---|---|
| Performer | `http://<Host-LAN-IP>:6868/` | 演奏者触摸界面（手机横屏） |
| Monitor | `http://<Host-LAN-IP>:6869/` | 监视端：客户端列表与声道分配 |

默认端口来自 `manifest.json` 的 `scoreServer.performerPort` / `monitorPort`——这是**唯一来源**。`public/shared.js` 和浏览器都会自动读取，不需要手动同步。

端口建议：**没有特殊理由，沿用本模板的 6868（performer）/ 6869（monitor）**——这是平台惯例，官方工程与内置工具都用这对端口，PNDS App 的端口管理面板也以它为参考。确需换端口时，避开系统保留端口（1–1023）、macOS 临时端口范围（49152–65535，出站连接可能随机占用）与常见服务端口（AirPlay 5000/7000、开发服务器 3000/5173/8000/8080、数据库 3306/5432/6379）；两个使用相同端口对的工程不能在同一台机器上同时运行。完整建议见 PNDS App 仓库的 `docs/PNDS_CREATOR_GUIDE.md`。

## 作品规格（本模板实现的功能）

- 演奏者界面：**手机横屏**触摸；竖屏时提示旋转。左半屏是 **FREQ 推子**（音高），右半屏是 **AMP 推子**（音量）。
- 推子值经 Socket.IO 发到 score server，由 server 转为 OSC 控制 SuperCollider。
- 每个加入的客户端获得一个 sine voice（一个 `template-sine` synth）。
- FREQ 推子映射频率在 `public/shared.js` 的 `freqRange` 定义（**单一事实来源**）：performer 页面用它显示 Hz，server 的 `audio/controller.js` 从同一对象读取并映射为 OSC 频率，改一处两边同步。
- FREQ 推子带**音高参考刻度**：范围内每个半音一小格（19 格），只标 3 个音名（中心音及其上下五度），这 3 格的刻度用**更亮的颜色**区分；范围两端不在音高上，不设刻度。刻度数据在 `public/shared.js` 的 `freqTicks`（单一事实来源）。
- **三档音区 switch**（居中，位于状态文字下方）：`1`（低音）/ `2`（中音）/ `3`（高音），切换左侧 FREQ 推子的频率区段。推子位置不变，Hz 映射随音区改变（server 按同一音区映射）。音区数据在 `public/shared.js` 的 `registers`（单一事实来源）：每区都是同样的 19 半音结构，中心音分别为 **E6 / A5 / D5**（相邻区中心相差 7 半音；整体比原 1000–3000 Hz 低一个五度），标注音名分别为 A-E-B / D-A-E / G-D-A——**每区的标注音 = 上一区整体下移一个五度**（中心音即上一区的下五度）。
- AMP 推子使用 **audio taper 曲线**（`value²`）：推子下半段控制更细腻。
- 推子值在 scsynth 端做 **平滑**（`Lag.kr`，amp 50ms / freq 100ms），推子移动是滑动的，不产生突变/zipper noise。
- **每个 voice 输出上限 -6 dB**（在 SynthDef 内 `amp * 0.5` 实现）。
- 客户端上限 = 输出声道数（manifest 默认 16；App 注入 `PNDS_AUDIO_OUTPUT_CHANNELS` 时以注入值为准）；满员时新客户端被拒绝。
- 默认声道：**奇数 id → 声道 1，偶数 id → 声道 2**（相对 `PNDS_AUDIO_OUTPUT_BUS`）。
- Monitor 端可把任意客户端的输出声道改为 1..N（N = server 实际解析的输出声道数，经 `__config.js` 注入浏览器，与 server 校验同源）；允许重叠。Monitor 页下方显示 **performer 页面的 QR 码**（`GET /qr`，由 `lib/qr.js` 生成）。
- **Monitor 端可调演奏序号**（ID 下拉，与声道分配同款交互）：把设备移到空闲序号——分配、voice（带当前状态原位重建）与席位记录一并迁移，performer 页面经 `joined` 事件自动跟进新序号。目标序号被在线设备占用时不动；被陈旧席位记录占用时覆盖（操作员意图优先）。
- 客户端断开后，重连（同一浏览器，token 保存在 localStorage）会**恢复原 id 与最后推子状态**；恢复**一次到位**——voice 直接以持久化状态创建（单条 `/s_new` 携带正确的音量/频率/声道），不经过默认值中间态，锁屏重连不会在错误声道出声。
- **席位记录跨重启持久**：server 把每台设备的演奏序号与声道（`token → {id, out}`）写进工程根目录的 `.pnds-seats.json`，重新开启工程时同一台设备（同一浏览器）自动拿回原序号与原声道；推子状态（freq/amp）不跨重启，重启后归零。席位为其设备保留——新设备不会占用已记录的序号；陈旧记录（不会再来的手机）占满席位时，用 monitor 页右上角的 **重配 ID** 按钮清空全部记录（在线设备会被断开重连、按重连顺序拿新序号，声道回默认）。测试或 App 可用环境变量 `PNDS_SEATS_FILE` 把状态文件指到别处。
- Performer 状态行显示 **`ID: N CH: N`**：CH 来自 state 广播，monitor 端改道后实时更新。
- score server 的终端日志记录协议生命周期（join / disconnect / rejected）——现场排查"幽灵客户端"循环重连时看这里。

## 主题跟随（可选，App 集成）

PNDS App（≥ v1.2.3）会把当前主题（Lavender / Sand / Stage / Brutal）经跨域 `postMessage` 推给 monitor 页（score project spec §5.3），工程**可选**消费。本模板内置了参考实现 `lib/theme-follow.js`，由 server 经 monitor 端口的 `GET /__pnds/theme-follow.js` 提供给浏览器。

本模板的 monitor 页用 **p5 绘制（无 CSS 变量）**，示范的是**回调消费**路径：`public/index.html` 在 monitor 分支加载模块并设置 `window.PNDS_THEME_OPTIONS = { applyVariables: false, onTheme: ... }`，`public/monitor.js` 的 `applyTheme()` 把 palette 映射成画布颜色，`draw()` 每帧读取 THEME——新调色板下一帧即生效，无需重绘编排。DOM 页面（无 canvas）则可零配置直接用默认的 CSS 变量路径（见 Multichannel Signal Generator）。

要点：

- 消息 best-effort、"最新值覆盖"：App 在 iframe 加载、切主题、窗口重获焦点时重推；页面幂等应用（重复送达无副作用），未知/畸形消息静默忽略。
- 加载时支持 `?theme=<name>` 作为首帧初值（App 目前不携带，缺席时用工程自带配色——本模板即 monitor.js 里 `DEFAULT_THEME` 的深色）。
- performer 分支不加载该模块、永远用工程自带配色。
- 想改映射或做整套设计分叉（按主题名换字体/圆角等），看 `lib/theme-follow.js` 头部注释的 `PNDS_THEME_OPTIONS` 各口子。

## 目录结构

```
manifest.json             PNDS 工程契约（App 只认它和 server 入口）
server.js                 作品主 server：编排协议（通常不用改）
lib/                      可复用核心，任何 PNDS 工程通用（template 骨架，通常不用改）
  config.js               manifest / CLI / 端口 / 环境变量解析
  network.js              LAN IPv4 枚举
  health.js               /__pnds/health
  osc-transport.js        UDP OSC 传输（osc-min + dgram）
  audio-engine.js         scsynth 会话生命周期（bus / group / synthdef 加载）
  players.js              客户端 id 分配与重连恢复（claim token；已记录席位优先、他人席位保留）
  seats-store.js          席位记录持久化（token → {id, out}，跨重启；`.pnds-seats.json`）
  protocol.js             Socket.IO 协议：join / claim / 重连恢复 / 控制转发（载荷不透明，字段语义在作品层）/ 席位记录 / 重配 / 广播
  lifecycle.js            优雅关闭
  theme-follow.js         主题跟随（App ≥ v1.2.3，可选）：消费 pnds:theme 消息（见下文「主题跟随」）
  qr.js                   performer 页面 QR 码（GET /qr）
audio/                    作品音频语义层：推子 → synth 参数的映射（创作时改这里）
  controller.js           每客户端一个 voice，声道分配，外部 OSC 协议
public/                   浏览器端（performer + monitor 双角色单页）
  index.html              双角色入口（按端口加载不同脚本）
  shared.js               浏览器与 server 共用的常量：事件名 / 频率范围（单一事实来源，见下文）
  client.js               浏览器端 score-server 客户端：performer 加入/重连恢复/去抖发送、monitor 状态视图（页面只管绘制与输入；有 Node 测试）
  performer.js            演奏者横屏推子界面（p5）
  monitor.js              监视端：列表 + 声道分配 + 重配 ID 按钮
  style.css
  libraries/p5.min.js     p5 库（本地文件，演出离线可用）
supercollider/
  source/                 SynthDef 创作源码（.scd）——唯一事实源
    template-sine.scd     本模板的 sine voice 定义
  debug/                  External debug bridge（创作期工具）
  synthdefs/              已编译 .scsyndef（运行时 artifact，manifest 引用）
test/                     node --test 回归测试
docs/                     本指南与交接文档
```

## 创作时改什么

| 想做什么 | 改哪里 |
|---|---|
| 换作品名 / 端口 / 声道数 | `manifest.json`（改端口只需改这里） |
| 改推子 → 声音的映射 | `audio/controller.js` |
| 加一个控制字段（如新推子） | `public/performer.js`（发送）+ `audio/controller.js`（在 `applyControls` 读取并钳位；协议层不透明转发，`lib/` 不用动） |
| 改声音本身（波形、效果） | `supercollider/source/template-sine.scd`，然后重新编译 |
| 改演奏者界面 | `public/performer.js`（p5） |
| 改监视端 | `public/monitor.js` |
| 改主题跟随 | `lib/theme-follow.js`（默认映射、onTheme / derive 口子、?theme= 初值） |
| 调设备演奏序号 | monitor 页 ID 下拉（目标序号需空闲） |
| 清空设备席位记录（换手机阵容） | monitor 页 **重配 ID** 按钮，或删除 `.pnds-seats.json` 后重启 |
| 加 Socket.IO 事件 | `public/shared.js`（事件名）+ `lib/protocol.js`（处理——核心协议语义，一般不需要） |
| 改推子频率范围 / 音区 | `public/shared.js` 的 `registers`（每区 `freqRange` + `freqTicks`；页面显示、刻度与 server 发声自动同步，无需改 `audio/controller.js`） |
| 改客户端上限 | `manifest.json` 的 `audio.outputChannels`（id 上限 = 输出声道数） |

## 单一事实来源（Single Source of Truth）

`public/shared.js` 是浏览器页面与 Node server **共用同一份常量**的模块：

- 它用 UMD 包装：浏览器里挂到 `window.PNDS`（页面脚本里 `const P = window.PNDS` 取别名），Node 里走 `module.exports`（server 端 `require`）。
- **Socket.IO 事件名**（`events`）、**频率范围**（`freqRange`）、**客户端上限**（`maxClients`）、**localStorage token 键名**（`tokenKey`）都在这里定义。
- **端口**的单一来源是 `manifest.json`（App 工程契约）。`shared.js` 在 Node 端自动从 manifest 读取，浏览器端由 server 动态注入——创作者只需改 manifest.json。
- 修改频率范围只需改 `registers`（每区 `freqRange.min / max`）一处：performer 页面的 Hz 显示与 server 端 `audio/controller.js` 的 `mapFreq()`（从 shared 读取）自动同步。线性映射辅助（`freqFromValue` / `freqFraction`）与推子刻度（每区的 `freqTicks`）也在 shared.js 中定义；`freqRange` / `freqTicks` 是默认音区（3）的别名。
- 基于模板创建新作品时，建议修改 `tokenKey` 为与作品 id 一致的名称（如 `”my-work-token”`），避免不同工程共用同一个 localStorage 键。

## 声音：编辑与编译 SynthDef

`.scd` 是创作期源码与唯一事实源，`.scsyndef` 是运行时 artifact。改完 `.scd` 后必须重新编译，否则 App 加载的是旧声音：

- 在 PNDS App 中打开本工程，`Settings → Developer Tools → Compile SynthDef`（使用本机安装的 SuperCollider）；
- 或在本机自行运行 sclang。

编译契约：**SynthDef 符号名 = 产物文件名 = manifest 引用**（本模板为 `template-sine`；带连字符的名字在 .scd 中须写作 `'template-sine'` 引号符号形式）。编译产物写入 `supercollider/synthdefs/template-sine.scsyndef`，App 会在编译后逐个校验 manifest 引用的产物。

## 音频模式

| 模式 | 说明 |
|---|---|
| `internal` | App 托管 scsynth，加载编译好的 `.scsyndef`（演出模式） |
| `external` | 向自定义 OSC target 发送作品协议（`/c<id>/amp`、`/c<id>/freq`、`/c<id>/out`） |
| `none` | 不建立音频输出（只测试页面与网络） |

External 模式调试：在 SuperCollider IDE 中先运行 `supercollider/source/template-sine.scd`，再运行 `supercollider/debug/template-debug.scd`，然后：

```sh
node server.js --audio-mode external --osc-target 127.0.0.1:57120
```

## 健康检查

两个端口都提供：

```sh
curl http://127.0.0.1:6868/__pnds/health
```

PNDS App 以 JSON 中 `status === "ready"` 为显示条件。

## test/ 文件夹

`test/` 是给 AI 编程助手用的回归测试。创作者不需要手动运行，也不需要理解它们。当你通过 AI 修改工程时，AI 会用它来验证改动没有破坏已有功能（如客户端加入、推子映射、重连恢复等）。

## 发布

带生产依赖的发布包由 `.github/workflows/package.yml` 构建（ALLOWLIST 裁剪，`node_modules` 预装）。详见 `docs/handoff.md`。
