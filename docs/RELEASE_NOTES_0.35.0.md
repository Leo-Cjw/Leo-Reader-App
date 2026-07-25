# Reader 0.35.0

本版本为浏览器、快捷指令和未来 Share Extension 建立安全的外部保存入口：打包 App 注册 `reader-local://add?url=<编码后的网页地址>`，兼容冷启动和运行中的第二次唤起，但只预填既有添加窗口，用户确认前不会创建导入任务、联网或写入资料库。SQLite schema 保持 v10，API、设置、文章、附件、备份和导入导出格式均不变。

## 外部保存入口

- macOS 包在 `Info.plist` 中声明唯一的 `reader-local` scheme；Electron 主进程在应用 ready 前监听 `open-url`，并从冷启动和第二实例 argv 中提取候选链接。
- 解析器只接受固定 `add` 动作、唯一 `url` 参数、最长 2,048 字符且不含用户名或密码的 HTTP(S) 地址。未知动作、额外或重复参数、外层 fragment、其他目标协议及畸形输入直接忽略。
- 合格地址最多排队 20 个，并在渲染器完成加载后通过单向 IPC 逐个送入现有“添加到 Reader”窗口。运行中的窗口会恢复、显示并获得焦点。
- preload 只公开 `onAddURL` 订阅，不提供通用 IPC、文件系统或网络能力；外部唤起本身不调用本地 API。

## 确认与网络安全

- 深链只预填网页地址，用户仍可修改目标资料夹或取消操作；只有点击“加入导入队列”才复用原有 URL 导入 API。
- 预填阶段不解析 DNS，也不把地址当作可信输入。提交后服务端仍重新执行 URL 凭据、DNS 全量解析、私网与云元数据地址、重定向、固定连接地址和响应体大小等既有检查。
- 主进程、preload 与 React 均有有界队列；地址不会写入诊断日志。重复目标在等待期间去重，避免外部应用造成无界内存增长或重复弹窗。

## 验证

- 新增深链解析和桌面交接契约测试，覆盖合法编码地址、冷启动 argv、重复/额外参数、未知动作、外层凭据或 fragment、`javascript:`/`file:` 目标、长度上限、渲染器就绪门禁、preload 缓冲和显式确认边界。
- 在隔离资料库中运行开发版 Electron，验证冷启动预填、运行中第二实例聚焦与预填、非法目标忽略；三种情况下 `/api/import-jobs` 均保持空数组。
- 最终 Universal App 通过真实 macOS LaunchServices 接收运行中 `reader-local` 链接，并显示正确的预填地址；直接冷启动最终可执行文件也正确消费 argv。取消和非法 `file://` 链接后导入队列仍为空。
- 两轮连续 `npm test` 均为 103/103 通过；`npm run build` 生产构建通过；`npm run audit:dependencies` 确认生产依赖 0 漏洞，完整树仅保留 0.34 已评估的构建工具公告。

## Universal 包

- `Reader-0.35.0-universal.dmg`：253,184,397 字节；SHA-256 `66b6b5953ce4b257e0b64495821e0e259cf09e964d1d2c931f43e4d7ee389ceb`。
- DMG 校验通过；App 主程序同时包含 `x86_64` 与 `arm64`，短版本与 build 均为 `0.35.0`，Bundle ID 为 `com.reader.localfirst`。
- 深度严格签名校验通过；最终 `Info.plist` 包含名称 `Reader URL`、角色 `Viewer` 和 scheme `reader-local`，ASAR 内含本版本主进程、preload、解析器、服务端版本和前端构建。
- 最终包仍为 ad-hoc 签名且没有 Team Identifier，因此未生成可用于正式自动更新的 ZIP。

## 已知边界

- 自定义 URL scheme 可被任意本机应用或网页调用，不提供调用方身份认证；本版本通过有界解析、明确预填和服务端重复校验控制风险。
- 当前只提供外部 URL 边界，尚未实现 Safari/系统分享菜单中的 Share Extension，也没有浏览器扩展。
- 当前包仍缺少真实 Apple Developer ID、公证、正式 GitHub Release、Apple Silicon Gatekeeper/跨版本升级验收，以及启用 VoiceOver 后的完整人工听读。
