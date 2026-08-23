# PNDS Template — Handoff（开发交接笔记）

面向继续开发此模板的开发者与 AI 代理：记录结构约定、边界与已知决策。

## 分层约定

- `lib/` 是可复用核心，**不得包含作品特定逻辑**。改动它意味着所有基于模板的工程都受影响。
- `audio/controller.js` 是作品语义层：id → voice、声道分配、external OSC 协议。
- `server.js` 只做编排（挂载协议、生命周期），不含业务算法。Socket.IO 协议语义（join / claim / 重连恢复 / 控制转发 / 席位记录与重配 / 广播）在 `lib/protocol.js`。
- `lib/seats-store.js` 是席位持久化核心（claim token → {id, out}，跨重启），状态文件默认在工程根 `.pnds-seats.json`（`PNDS_SEATS_FILE` 可重定位）；推子状态刻意留在内存（protocol.js 的 lastControls）——它只需扛锁屏重连，不需扛重启。
- `public/shared.js` 是浏览器与 server 的**单一事实来源**（事件名、频率范围、常量），必须保持 UMD 形态（浏览器全局 `window.PNDS` + Node `module.exports`）。
- `lib/theme-follow.js` 是主题跟随参考实现（spec §5.3，自 Multichannel Signal Generator **逐字节拷贝**——它按 MSG 代码风格书写（无分号/单引号），与本仓库其余 lib 风格不同，属有意为之：字节一致便于三仓库同步与 diff）：UMD（浏览器全局 `PNDS_THEME` 自接线 + Node 导出供测试），是唯一被浏览器加载的 lib/ 文件，经 monitor 端口的 `GET /__pnds/theme-follow.js` 提供。

## 端口约定

端口只在 `manifest.json` 定义（`scoreServer.performerPort` / `monitorPort`）。`shared.js` 在 Node 端从 manifest 读取，浏览器端通过 server 注入的 `__config.js` 获取。创作者改端口只需改 manifest.json，无需手动同步任何文件。

## PNDS 契约要点（必须遵守）

- `scoreServer.entry` 指向 `server.js`，路径必须在工程根内；禁止绝对路径与 `../`。
- Internal 模式只加载 `supercollider/synthdefs/*.scsyndef`（编译产物），`.scd` 只是创作期文件。
- 读取 `PNDS_AUDIO_OUTPUT_BUS`（首个输出 bus）、`PNDS_AUDIO_OUTPUT_CHANNELS`（离散输出数）。
- health ready 前创建项目 group（`GROUP_ID = 1000`）；所有动态 synth 放在 group 内。
- 不使用 App 保留的 node ID 范围 `2147480000..=2147483647`（本模板 node id = `1000 + clientId`）。
- 退出时释放全部资源（Socket.IO、OSC socket、HTTP server）——见 `lib/lifecycle.js`。
- 每个 voice 的 `out` 指向 `PNDS_AUDIO_OUTPUT_BUS + channel - 1`。

## 外部 OSC 协议（作品自定义，非平台标准）

```
/c<id>/amp  [float 0..1]
/c<id>/freq [float, range defined in public/shared.js freqRange]
/c<id>/out  [float 1..16]
```

`supercollider/debug/template-debug.scd` 是创作期 bridge，App 不启动、不打包。

## 决策记录

- 每客户端一个**单声道** voice；上限 = `audio.outputChannels`（16）。monitor 页声道下拉与 server 解析值同源（`__config.js` 注入 `outputChannels`），不再硬编码 16。
- 声道可重叠，冲突由创作者自行管理（模板不阻止）。
- AMP 推子映射 audio taper 曲线（`value²`），在 server 端完成（`audio/controller.js` 的 `mapAmp`）。
- 平滑（`Lag.kr`：amp 50ms / freq 100ms）在 SynthDef 内实现，通过 `lagAmp` / `lagFreq` control 暴露，创作者可调。
- 每 voice -6 dB 上限在 SynthDef 内实现（`amp * 0.5`），推子全范围可用。
- 超过上限的新客户端**拒绝加入**（`PlayerRegistry`，含 reason）。
- 断开连接立即释放 voice 与 id；重连凭 localStorage 中的 claim token 恢复 id 与最后状态（`lib/protocol.js` 内按 token 键控）。恢复是 **born-restored**：持久化状态随 `ProjectAudio.addVoice(id, state)` 一次性建声（internal 模式单条 `/s_new` 即携带正确的 amp/freq/out bus；external 模式首批 OSC 即真实值），不产生"默认值建声再逐步改写"的可听中间态；仅当 voice 尚存活（接管型重连，旧 socket 的 disconnect 未及触发）才走 `restoreVoice()` 原地重喂。`ProjectAudio` 不再检查 `instanceof AudioEngine`——按引擎接口（mode / outputChannels / outputBus / 命令方法）约束，测试可注入替身引擎；`AudioEngine` 接受 `transportFactory` 注入，boot 序列与 scsynth 命令编码经记录型假传输单测（`test/audio.test.js` / `test/controller.test.js`）。
- `set-out` 双来源：performer 页不带 `id`（改自身 voice）；monitor 页不 join、带 `id` 指定目标客户端（LAN 信任模型，不鉴权）。
- performer 页状态行显示 `ID: N CH: N`（CH 订阅 state 广播）；协议的 join / disconnect / rejected 都打终端日志，用于定位循环重连的客户端（其重连节奏 = `reconnectionDelay: 1000` + 抖动，每轮 join 都会重建 voice——以持久化状态直接建声，internal 模式仍在发声中 free synth，可闻周期 click）。
- QR 码由 `lib/qr.js` 生成（`qrcode` npm 包，`GET /qr` 挂在 monitor server），monitor 页面 `<img src="/qr">` 显示。
- FREQ 推子带音高刻度（2026-08-14）：每区 19 个半音小刻度（**等长**），只标中心音及其上下五度 3 个音名，这 3 格的刻度用**更亮的颜色**区分（大小不变）；范围端点不在音高上，不标。映射保持线性 Hz（每区 `freqRange` 不同），刻度数据在 `public/shared.js` 的每区 `freqTicks`，performer 页按 `freqFraction` 线性定位。
- 三档音区 switch（2026-08-14）：performer 页状态文字下方居中的三位置 switch（1 低音 / 2 中音 / 3 高音），切换左侧 FREQ 推子的频率区段。`public/shared.js` 的 `registers` 是单一事实来源：每区 `freqRange` + `freqTicks`，中心音 **E6 / A5 / D5**（相邻差 7 半音；整体比原 1000–3000 Hz 低一个五度），音名 **A-E-B / D-A-E / G-D-A**——每区的标注音 = 上一区整体下移一个五度（中心音即上一区的下五度；3 为 A5/E6/B6，2 为 D5/A5/E6，1 为 G4/D5/A5）。`control` 消息携带 `range`（1|2|3，缺省 3）；持久化形状由 `ProjectAudio.voiceState()` 唯一定义（**原始推子值** `rawAmp`/`rawFreq` + `range` + `out`），重连时随 `addVoice(id, state)` 重新映射一次建声（避免双重映射）。monitor 页新增 RANGE 列显示每位演奏者的音区。
- 本模板**不预装 node_modules**（`.gitignore` 排除）；首次使用按 creator-guide 执行 `npm install`。发布包必须预装。
- p5 是模板的默认视觉方案，不是平台组件。
- **主题跟随走 spec §5.3（App issue #44/#46 的模板落地）**：monitor 分支加载 `/__pnds/theme-follow.js` 并前置 `window.PNDS_THEME_OPTIONS = { applyVariables: false, onTheme }`——本页 p5 绘制、无 CSS 变量，示范**回调消费**路径（DOM 页零配置走默认 CSS 变量路径的范例是 MSG）。加载顺序契约：模块先于 monitor.js 加载，`?theme=` 初值可能在 monitor.js 之前送达，故 index.html 的 onTheme 钩子把送达 stash 到 `window.PNDS_LAST_THEME`，monitor.js 启动时回放（有测试）。
- **monitor.js 的主题映射**：`DEFAULT_THEME` 即原硬编码深色（hex 字符串形式）；`applyTheme(name, palette)` **原子应用**——bg 或 text 缺失/为空则整体保留上一主题（绝不跨主题混键，混色正是不可读组合的来源），颜色以 CSS 字符串直接喂给 fill/stroke/background（p5 原生解析 #rrggbb，也兼容未来 rgb()/oklch() 记法）。映射：bg/text/text-secondary→背景/正文/次要文字；**分隔线与控件边框也取 text-secondary**（recessed 的 pill 在浅色主题下对背景仅 ~1.05:1，本页画布没有卡片间隙或阴影可依赖）；控件以 card（缺省回退 bg）/text 作底/字。`draw()` 每帧读 THEME，新调色板下一帧生效。
- **select 的 WKWebView 修复（v0.3.1，用户报告）**：原生 `<select>` 忽略 CSS background 但应用 CSS color——主题化的深色文字叠在原生深色控件上看不清（lavender 报告）。修复三层：`color-scheme` 按 bg 亮度设到 documentElement（原生闭合控件与弹出列表整体翻转明暗）；select 加 `appearance:none` + 自绘 caret（`caretImage()` 按文字色生成 SVG data URI，`styleControlColors(control, isSelect)`）；文字/底/边框照常 CSS 上色。button 无需 appearance（WKWebView 尊重其 background）。
- **`?theme=<name>` 为前瞻支持**：App 目前不携带该参数；四套主题初值在模块内（复制自 App theme-variables.css）。参数缺席时 monitor 页用 `DEFAULT_THEME`，行为与从前完全一致。

## 验证命令

```sh
npm run check   # 全部 JS 语法检查（含 lib/theme-follow.js）
npm test        # node --test（config / audio 契约 / players / protocol / seats / shared / client / integration / theme-follow，共 100 个）
PNDS App → Settings → Developer Tools → Compile SynthDef   # 重新编译 SynthDef
```
