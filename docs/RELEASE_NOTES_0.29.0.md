# Reader 0.29.0

本版本补齐静态正文的纯键盘选区和高亮创建路径。资料库 schema 仍为 v10，高亮 API、备份格式和既有鼠标选区保持兼容；正文不会因为进入键盘模式而变成可编辑内容。

## 纯键盘正文选取

- 阅读器工具栏新增“键盘选取”。开启后焦点进入具名只读 document，方向键按字符或视觉行移动，Option+方向键逐词移动，按住 Shift 扩展选区。
- Control+Option 方向键保留给 VoiceOver，不被 Reader 截获。折叠光标和已选原文通过 live status 播报；支持 CSS Custom Highlight 的运行时同时显示光标位置。
- 按 Enter 复用现有高亮保存浮层，可选择四种颜色并填写批注。保存、取消或 Escape 均清理临时 Range，并把焦点还给“键盘选取”按钮。
- 正文始终没有 `contenteditable`。字符输入、删除、粘贴和输入法没有修改 DOM 的编辑面；只有明确保存后，高亮锚点与批注才写入本机 SQLite。
- 鼠标与触控板选区保持原路径，不需要进入键盘模式。

## 隔离浏览器验收

- 使用独立临时资料库创建多段 Markdown 文章，真实浏览器可访问树确认模式开启后正文为具名只读 document，状态说明和保存控件均可发现。
- Shift+方向键成功选择“让阅读留下可访问”；Option+Shift+方向键成功逐词选择“阅读”。
- Enter 后填写批注并改为雾蓝，保存结果以 quote、offset `0–8`、颜色和批注写入 SQLite；焦点回到未按下状态的“键盘选取”。
- Escape 取消没有新增高亮；对选择区发送字符输入后，正文 DOM 文本保持不变。
- 隔离测试标签页已关闭，临时资料库已移入废纸篓。

## 自动验证

- 91/91 项自动测试通过，生产构建通过；`npm audit --audit-level=moderate` 为 0 漏洞。
- 十万篇资料库首两次门禁只有总览统计超标，p95 分别为 521.86 ms 与 341.50 ms，分页和搜索均低于 137 ms。Reader 随后把五项统计改为使用既有覆盖索引的独立计数；数据库与 HTTP 回归通过。
- 修正后的 100,003 篇、12 轮基准：总览统计 p50 19.80 ms、p95 20.53 ms；全部列表/筛选/检索子项最高 p95 为 124.09 ms，低于 250 ms 门槛。
- 100 篇列表摘要载荷为 57,074 B；若携带完整正文则为 10,298,374 B，继续满足 512 KiB 摘要载荷门槛。
- 10,003 个检索片段、30 轮本地 RAG 基准：p50 54.80 ms，p95 67.21 ms，低于 250 ms 门槛。
- Universal App 的主程序和 Electron Framework 均包含 `x86_64 arm64`，包内版本与构建号均为 0.29.0；解包检查确认键盘选取界面和索引化统计查询均进入最终 App。
- 当前 App 通过 ad-hoc 深度严格签名验证，实测 `Signature=adhoc`、`TeamIdentifier=not set`、`updateEligible=false`；同版本自动更新 ZIP 不存在。
- Universal DMG 通过 `hdiutil verify`，大小为 254,496,138 B，SHA-256 为 `b2966c0f9db33aba5aea23bc72bae88bd33fdbd1a8dfb6b6445674416bf85b59`。

## 已知边界

- 本轮验证了 Chromium 可访问结构与键盘行为，但没有在启用 macOS VoiceOver 的真机上逐项听读；Control+Option 避让与 live region 仍需专项人工审计。
- 当前本地包仍缺少真实 Apple Developer ID、公证凭据和 Apple Silicon 真机 Gatekeeper/升级验收。
