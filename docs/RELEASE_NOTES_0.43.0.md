# Reader 0.43.0

本版本把最终打包 App 的可访问性行为加入 macOS 发行阻断门禁，并改善复杂对话框的初始读屏焦点。SQLite schema 保持 v11；文章、附件、设置、备份和 Markdown 导入导出格式均与 0.42.0 兼容。

## 打包可访问性门禁

- Universal App 合并和签名后、DMG 生成前，流水线会从隔离临时资料库启动最终候选 App，并直接读取 Chromium 完整 Accessibility Tree。
- 主工作区必须暴露命名的产品导航、资料列表、阅读器和文章助手 landmarks、资料夹 tree；所有 button、textbox、combobox、treeitem 等交互节点都必须有可访问名称，DOM id 不得重复。
- 门禁真实打开设置、添加内容、订阅管理、普通/智能资料夹、重复内容、导入队列和数据安全八个核心模态框。每个窗口都必须让背景 inert 并从 AX 主内容中移除，焦点进入窗口，Tab 不逃逸，Escape 可关闭，关闭后焦点返回原入口。
- 带 `aria-labelledby` 的复杂窗口优先聚焦命名标题，避免首次进入时把整个窗口作为一段冗长内容朗读；其他窗口继续使用既有首个可用控件或 dialog 焦点策略。

## 隔离与兼容

- QA 只监听 `127.0.0.1` 随机调试端口，使用独立临时 Chromium profile 和 Reader 数据根目录；完成后关闭自己的 App 进程并删除全部临时资料。
- `READER_RELEASE_QA` 只让被测候选跳过 URL scheme 注册，避免发行测试改写用户系统协议偏好。正常产品启动、深链和 Share Extension 行为不变。
- `/api/health` 增加只读 `schemaVersion`，让候选包可以同时证明应用版本和数据层版本；不返回路径、内容或记录标识。

## 验证

- `npm test`：123/123 通过；`npm run build`：生产构建通过；`npm run audit:dependencies`：生产依赖 0 个已知漏洞。
- 最终 Universal 候选实测暴露 318 个 AX 节点，八个模态框闭环全部通过，无无名交互控件，临时资料完成清理。
- 主程序、Spotlight Helper 与 Share Extension 均包含 x86_64/arm64，App 深度严格签名和 `hdiutil verify` 通过；最终 entitlement 分别精确为 V8 JIT、App Sandbox 和空集合。

## Universal 包

- `release/Reader-0.43.0-universal.dmg`：252,626,518 bytes。
- SHA-256：`ea967aa44e320fb422fd0e4abc7cb7dba889dd61e43e5aced914785941fe2fcb`。
- 当前仍为 ad-hoc 签名，不生成自动更新 ZIP。

## 已知边界

- 自动门禁验证最终 Chromium AX 树与键盘焦点行为，不等同于启用 VoiceOver 的人工听读，也不替代正式 Developer ID 包的 AppKit 原生 AX、系统通知、Spotlight 和 Share Extension 验收。
- 当前交付仍为 ad-hoc 签名；真实 Developer ID、公证、正式 GitHub Release、Apple Silicon Gatekeeper 与跨版本升级仍待完成。
