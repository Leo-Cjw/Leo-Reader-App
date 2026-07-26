# Reader 0.47.0

本版本把 macOS Share Extension 从网页 URL 与短文本扩展为单个文件的确认式导入，并为易失的 `NSItemProvider` 文件建立可验证、可清理的本机交接生命周期。SQLite schema 保持 v11；文章、附件、设置、备份和 Markdown 导入导出格式均与 0.46.0 兼容。

## 文件系统分享

- “存入 Reader”现在接受单个 PDF、PNG/JPEG/GIF/WebP/HEIC、MP4/MOV/M4V/WebM、Markdown 或纯文本文件，单文件最大 100 MB。
- Share Extension 在系统临时文件失效前把内容复制到自己的沙箱缓存；目录权限为 `0700`，载荷与固定 schema 描述文件为 `0600`。
- 每次分享使用不可推导的 UUID v4、精确字节数、受控 MIME、SHA-256 与创建时间；描述文件最后原子写入，过期时间为 24 小时。
- `reader-local://add?file=...` 只携带 token，不携带真实路径、名称、MIME、大小、摘要或内容。URL、文本和文件参数互斥，主进程与 preload 独立重新校验。
- Reader 只从固定 Share Extension 容器读取，以 `O_NOFOLLOW` 拒绝符号链接，并重新验证私有权限、普通文件、描述字段、时效、大小、类型和 SHA-256。渲染器只能查看受限元数据，不能读取路径或任意文件。
- 用户仍需在 Reader 中核对文件、选择资料夹并确认；确认前不会创建文章或导入任务。确认后复用既有附件流式端点及服务端格式/签名校验，取消或成功后立即清理，失败时可以重试并最迟在过期时回收。

## 最终包门禁

- Share 门禁新增两条文件路径：确认前文章与导入任务数均不变，确认后 Markdown 正文和附件精确落库且暂存删除；取消第二个文件后暂存立即删除，资料库和队列保持不变。
- 文本逐字预填/保存和 URL 回归继续执行；QA 使用独立临时 Chromium、Reader 数据和 Share 暂存根目录，不接触用户资料或系统扩展偏好。
- 三个最终包 QA 脚本在自动测试中先执行 Node 语法检查，避免门禁脚本自身的解析错误延迟到发行阶段。
- 全部 14 个顶层模态框的 Chromium AX、背景 inert、焦点进入、Tab 闭环、Escape 和焦点返回门禁继续通过。

## 验证

- `npm test`：130/130 通过。
- `npm run build`：生产构建通过。
- `npm run audit:dependencies`：生产依赖 0 个已知漏洞；构建树仅保留已评估的既有 Electron 打包公告。
- Swift URL/文本与文件暂存自测通过；覆盖允许类型、文件名规范化、100 MB 边界、0700/0600、SHA-256、UUID 深链、符号链接目录拒绝和 TTL 清理。
- Node 文件交接测试覆盖路径/token 拒绝、描述/摘要/权限篡改、`O_NOFOLLOW`、过期、失败重试、显式取消与成对清理。
- 最终 0.47 Universal 候选的 14 个顶层模态框、Share 文本/文件/取消/URL、以及 0.43.0 schema v11 冻结资料库升级闭环全部通过。
- 主程序、Spotlight Helper 与 Share Extension 均包含 x86_64/arm64，各自严格签名和 `hdiutil verify` 通过；Share Extension 签名 entitlement 仍精确等于 App Sandbox。

## Universal 包

- `release/Reader-0.47.0-universal.dmg`：255,322,354 bytes。
- SHA-256：`b4d72823afb7d04be46b2b723efc8c1192654034b51cc422916db7ef38eadfe0`。
- 当前仍为 ad-hoc 签名，不生成自动更新 ZIP。

## 已知边界

- 当前自动化验证扩展原生逻辑和最终 App token/确认/导入闭环，但 ad-hoc 包不能代替 Developer ID、公证后从 Safari、Finder、照片及第三方 App 逐项触发的真实系统分享验收。
- Chromium AX 自动化不能替代正式签名包的 AppKit 外层复验或启用 VoiceOver 后的完整人工听读。
- 仍需真实 Developer ID、公证、正式 GitHub Release、`autoUpdater` 跨版本安装及 Apple Silicon Gatekeeper/升级真机验收。
