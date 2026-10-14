# v0.7.0 固定共享库接线

本版 manifest.schemaVersion 为 2，sharedLibraries 声明确切运行库。只在 App v1.6.2 或支持这些引用的 Host 中运行；旧 App 不能执行共享引用。本地 standalone 开发用 npm ci 安装 package-lock 的精确依赖，Host 运行不会安装或下载。

Host 注入 PNDS_SHARED_LIBRARIES JSON 映射。lib/shared-libraries.js 只接受本工程声明的固定 id/version/kind 与存在的绝对入口；Host 环境存在时缺项、错误版本或缺文件明确失败，不静默使用本地依赖。Node CommonJS 通过 requireLibrary 加载；浏览器资源由工程 /__pnds/shared/ 同源路由提供，手机和可信 HTTPS 使用相同含义。标准模块和工具策略仍属于工程。

共享 .pnds 只携带引用、源码与工程资产，不携带重复库或 node_modules；打包安装须由 App 检查接收方能力。Standalone 不注入该环境，继续使用精确本地 npm 依赖。公开 Node/HTTP/受控进程回归与真实设备验收分开记录；健康检查、HTTP 成功不能代表传感器、推理、诊断功能或声音已通过。

本地候选产物尚未发布。维护者完成真机验收并发布固定工具产物后，App 才能引用真实 release URL 与对应 sha256；不得把本地候选写成已发布来源。

验证记录（2026-10-14）：npm run check 与 npm test 全绿（188 tests）；缺项、版本错误、缺文件、无本地依赖的共享启动与关停已通过受控进程回归。模型、真实手机、声音、原生 App 和安装验收按支持模式分别记录，不由这些回归替代。
