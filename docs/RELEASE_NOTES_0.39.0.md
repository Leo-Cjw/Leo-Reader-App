# Reader 0.39.0

本版本为 Mac App 增加独立专注阅读窗口。用户可以把当前文章从三栏工作区放入单独窗口，并同时阅读多篇内容；同一文章重复打开时只聚焦原窗口。专注窗口明确只读，避免多个渲染器并发修改文章状态或批注。SQLite schema 保持 v10，HTTP API、备份、附件、导入导出格式和设置字段均不变。

## 专注阅读

- 阅读器工具栏新增“新窗口”。窗口复用现有正文、Markdown、图片、视频、PDF、离线状态、AI 来源回链和高亮定位能力，不复制第二套内容渲染器。
- 每个文章 ID 对应一个原生 `BrowserWindow`；已打开的文章会恢复、显示并聚焦现有窗口，不会重复占用资源。不同文章可以同时保持独立阅读位置。
- 专注窗口提供独立明暗主题切换、原文入口和“返回资料库”。主资料库窗口已关闭时会安全重建；来源回链会继续打开经过验证的专注窗口。
- 专注窗口不显示或调用收藏、资料夹移动、归档、标签增删、版本历史、编辑器、文章助手、阅读进度、高亮创建、批注编辑和删除；现有高亮与批注只读展示。

## 安全与生命周期

- preload 只新增两个固定能力：请求打开受限文章窗口，以及聚焦主资料库。没有暴露通用 IPC、任意 URL、窗口参数、Node、文件系统或数据库对象。
- 主进程重新验证 IPC 发送 frame 必须来自当前随机回环 origin；文章 ID 必须非空、最长 200 字符且不含控制字符，并在创建窗口前向 SQLite 确认内容存在。
- 专注窗口沿用主窗口的 Chromium sandbox、context isolation、CSP、权限拒绝和导航限制。查询参数由 `URLSearchParams` 构建。
- 任一 Reader 窗口处于前台时，后台导入通知均保持抑制。

## 验证

- 新增测试覆盖文章 ID 边界、Unicode 兼容、精确 origin、内容存在性、固定 preload IPC、按 ID 去重、只读渲染及窗口拖动区域。
- `npm test`：111/111 通过；`npm run build`：生产构建通过；`npm run audit:dependencies`：生产依赖 0 漏洞，完整树仅保留已评估的构建工具公告。
- 在 Universal 候选 App 的隔离资料库中通过真实主窗口点击“新窗口”：DevTools 目标从 1 个变为主窗口与 `readerWindow=1&article=rss-quiet-web` 两个；重复点击后仍为 2 个目标、1 个专注窗口。专注窗口标题与文章一致，正文公开“文章正文，只读”，没有 textarea、select、标签输入或批注删除控件。
- 在专注窗口滚到文末并等待写入节流窗口后，API 回读的 `reading_progress` 仍为 0、`is_read` 仍为 false。最终重建包回读 User-Agent 版本为 0.39.0，只读空状态显示“返回资料库即可创建”。
- 最终包保留专注窗口并关闭主窗口后，DevTools 只剩专注阅读目标；点击“返回资料库”后，主窗口以同一回环 origin 重新出现，专注窗口保持打开。

## Universal 包

- `release/Reader-0.39.0-universal.dmg`：253,574,782 bytes。
- SHA-256：`6eac1cf005217fa7ba86e83f72142569b285bd119e5732dfbb1816cad98cb047`。
- `hdiutil verify` 通过；主程序同时包含 `x86_64` 与 `arm64`，Info.plist 短版本和构建版本均为 0.39.0。
- ASAR 已包含 0.39.0 版本模块、专注窗口主进程逻辑、固定 preload IPC 与最终渲染构建；App 深度严格签名校验通过。
- 当前仍为 ad-hoc 签名，`TeamIdentifier` 未设置；未生成自动更新 ZIP。

## 已知边界

- 专注窗口有意不写阅读进度。需要收藏、整理、编辑或修改批注时，点击“返回资料库”继续操作。
- 当前包仍缺少真实 Apple Developer ID、公证、正式 GitHub Release、Apple Silicon Gatekeeper/跨版本升级验收，以及恢复提示重载按钮的最终包人工点击、原生 AX 复验和启用 VoiceOver 的完整人工听读。
