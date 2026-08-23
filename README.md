# PNDS Template

[English](#english) | [中文](#中文)

---

## English

A ready-to-run PNDS digital score project skeleton with minimal working features. Use this template to start a new PNDS score project.

### Features

- **Performer UI**: landscape touch interface with two curved faders (AMP / FREQ); the FREQ fader carries a semitone pitch scale with highlighted ticks and letter names on the center note and its fifth above/below, and a 3-position register switch (1 low / 2 mid / 3 high) changes the frequency band
- **Audio**: one sine voice per client, 16-channel output (odd/even ids default to channels 1/2)
- **Monitor**: real-time client amp/freq display, per-client output channel reassignment
- **Reconnect recovery**: clients recover their id and fader state after a disconnect
- **Theme following**: inside PNDS App (≥ v1.2.3) the monitor page follows the App color theme (all four themes) — the spec §5.3 optional bridge, consumed here through the p5 `onTheme` callback (`lib/theme-follow.js`, served at `/__pnds/theme-follow.js`)
- **Three audio modes**: `internal` (scsynth), `external` (custom OSC), `none` (UI/network only)

### Getting Started

```sh
npm install
npm run dev:none    # run without audio
```

Full documentation: [`docs/creator-guide.md`](docs/creator-guide.md) (creator guide) and
[`docs/handoff.md`](docs/handoff.md) (developer handoff notes).

### Structure

```
lib/            Reusable core (shared across all PNDS projects — skeleton)
audio/          Work audio layer (fader → synth parameter mapping)
public/         Browser side (performer + monitor dual-role single page)
supercollider/  SynthDef sources, debug bridge, compiled artifacts
test/           Regression tests
docs/           Creator guide and handoff notes
```

### License

MIT — see [LICENSE](LICENSE).

---

## 中文

PNDS 数字乐谱工程模板：可直接运行的骨架 + 最小功能实现。基于此模板创建新的 PNDS 数字乐谱工程。

### 功能

- **演奏者界面**：手机横屏双推子（AMP / FREQ），FREQ 推子带半音音高刻度（中心音及上下五度标音名且刻度高亮），状态文字下方有三档音区 switch（1 低音 / 2 中音 / 3 高音）切换频率区段，圆弧几何直观触摸操控
- **音频**：每客户端一个 sine voice，16 声道输出（默认奇偶 id 分到声道 1/2）
- **监视端**：实时显示客户端 amp / freq，可重新分配每个客户端的输出声道
- **断线重连**：客户端断线后自动恢复 id 与推子状态
- **主题跟随**：在 PNDS App（≥ v1.2.3）中运行时，monitor 页实时跟随 App 主题（全部四套）——spec §5.3 可选契约，本模板经 p5 的 `onTheme` 回调消费（`lib/theme-follow.js`，经 `/__pnds/theme-follow.js` 加载）
- **三音频模式**：`internal`（scsynth）、`external`（自定义 OSC）、`none`（仅页面/网络）

### 开始

```sh
npm install
npm run dev:none    # 无音频运行
```

完整说明见 [`docs/creator-guide.md`](docs/creator-guide.md)（创作指南）与
[`docs/handoff.md`](docs/handoff.md)（开发交接笔记）。

### 结构

```
lib/            可复用核心（PNDS 工程通用，模板骨架）
audio/          作品音频语义（推子 → synth 参数映射）
public/         浏览器端（performer + monitor 双角色单页）
supercollider/  SynthDef 源码、debug bridge、编译产物
test/           回归测试
docs/           指南与交接文档
```

### 许可证

MIT — 详见 [LICENSE](LICENSE)。
