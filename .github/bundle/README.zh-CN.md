# Telematic Network Diagnostics

[English](README.md) | **中文**

一个 PNDS 工具工程，用于跨互联网（telematic）演出组网的诊断：每个场地各自运行本工程、手机在本地加入，各场地的 monitor 显示同一「星形视图」——带故障归因的整体结论、辐条为 hub 链路 / 外环为本地链路的星图，以及按节点推导端到端数据的卡片。纯网络工具：无音频、无 SuperCollider，工程恒以禁用音频（`none` 模式）运行。

## 使用方式

1. 在 PNDS App 里按 **⌘O**（打开）选择本 `.pnds` 工程包或解压后的文件夹，然后**载入**——音频保持禁用，score server 监听 6868（performer）与 6869（monitor）两个端口。还没有 App？从 https://github.com/xO-xN/PNDS-App/releases/latest 下载（macOS）——无需安装 Node.js，App 已内置。
2. 中继 hub **不**随本工程包分发：从源码部署到公网 VPS（见[仓库](https://github.com/xO-xN/Telematic-Network-Diagnostics)内 `docs/hub-deployment.md`），再通过 monitor 的连接表单（URL / 令牌 / 房间 / 节点名）把本站指向它。
3. 每个场地展开 monitor 底部的「**设备加入**」并让各手机扫码；手机自动加入并应答探针，测试期间保持页面开着。
4. 各场地的 monitor 呈现同一视图：整体「适合演出与否」横幅与故障归因、星图（辐条 = hub 链路，外环 = 本地链路）、按节点的端到端数据卡片，以及本场的 performer 面板。

monitor 跟随 App 的语言与主题；performer 页保持双语文案。


运行条件：本版采用固定 App 共享库，需 PNDS App v1.6.2 或更新且具备 manifest 声明的确切资源。工程包不重复携带运行库；创作机 standalone 调试仍可 npm ci。详情见维护仓库 docs/shared-libraries.md。

## App 演奏端二维码迁移

本版本移除工程自己的二维码界面与 `/qr` 端点。支持内置演奏端二维码的 PNDS App 中，演出模式使用底栏按钮，创作模式使用演奏者栏按钮；手机进入当前工程的 performer 页面。独立浏览器及旧版 App 仍可使用原页面，但不再提供页内扫码入口。
