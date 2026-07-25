# Reader 0.38.0

本版本增加用户可控、隐私安全的后台导入系统通知。通知默认关闭，只在 Reader 不处于前台时按 worker 批次显示成功与失败数量；任务内容和错误不会进入操作系统通知。SQLite schema 保持 v10，HTTP 文章 API、备份、附件、导入导出格式和既有设置字段均不变。

## 后台导入通知

- Mac App 的“设置”现包含“后台导入通知”开关。旧 `settings.json` 没有该字段时保持关闭，只有严格布尔值 `true` 才能启用；异常或被篡改的字符串不会隐式 opt-in。
- 导入 worker 每轮最多处理 20 项，完成后只向桌面层交付 `{ completed, failed }`。连续完成的一批任务只产生一条通知，新通知会替换上一条活动通知，避免逐条打扰。
- Reader 位于前台、正在退出或系统不支持通知时不显示。通知创建失败不会影响任务入库、重试或后续队列。
- 点击通知会聚焦 Reader；窗口已关闭时先重建主窗口，再通过受限单向命令打开导入队列。

## 隐私边界

- 通知只包含 0–99 范围内的成功/失败数量和固定中文模板。
- 文章标题、正文、摘要、URL、来源、附件/文件名、磁盘路径、任务/文章 ID、资料夹、错误原文、堆栈和凭据不会传给 Electron 通知控制器。
- 通知开关保存在权限为 `0600` 的非敏感 `settings.json`，不进入完整备份、Markdown 导出或诊断日志。

## 验证

- 新增测试覆盖默认关闭、显式开启、重启兼容、恶意类型不能启用、批次聚合、前台抑制、系统不支持、替换去重、点击回队列与敏感字段不外泄。
- `npm test`：109/109 通过；`npm run build`：生产构建通过；`npm run audit:dependencies`：生产依赖 0 漏洞，完整树仅保留已评估的构建工具公告。
- 在最终 Universal App 的隔离资料库中打开设置页，确认通知开关默认关闭；通过真实界面开启后，API 与权限为 `0600` 的 `settings.json` 均只保存 `{ enabled, updatedAt }`。隐藏 Reader 后导入一份 Markdown，任务和文章完整落库，macOS 统一日志确认主进程连接 `com.apple.usernoted.client` 并由 `usernoted` 处理通知设置变更。该步骤证明最终包已到达系统通知服务，但不替代 Developer ID 包上的可见横幅与点击验收。

## Universal 包

- `release/Reader-0.38.0-universal.dmg`：255,320,183 bytes。
- SHA-256：`5e0b3822f35e66bb7106b42bea5b65731b1ea8da93e03db09ae21f90083342a8`。
- `hdiutil verify` 通过；主程序同时包含 `x86_64` 与 `arm64`，Info.plist 版本为 0.38.0。
- ASAR 已包含通知控制器、设置存储和 0.38.0 版本模块；App 深度严格签名校验通过。
- 当前仍为 ad-hoc 签名，`TeamIdentifier` 未设置；未生成自动更新 ZIP。

## 已知边界

- Electron 的 macOS 系统通知依赖代码签名。当前 ad-hoc 交付不能代替 Developer ID 签名/公证包上的授权、显示与点击验收。
- 当前包仍缺少真实 Apple Developer ID、公证、正式 GitHub Release、Apple Silicon Gatekeeper/跨版本升级验收，以及恢复提示重载按钮的最终包人工点击、原生 AX 复验和启用 VoiceOver 的完整人工听读。
