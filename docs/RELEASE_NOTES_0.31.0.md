# Reader 0.31.0

本版本补齐视觉选中状态与屏幕阅读器语义之间的断层，并让文章列表在不读取完整正文的前提下提供足够上下文。资料库 schema 仍为 v10，数据、API、备份和导入格式均保持兼容，暖白三栏视觉体系不变。

## 当前项与切换状态

- 资料库、智能资料夹和标签导航通过 `aria-current` 公开当前视图，不再只依赖 `active` class。
- 内容类型、文章助手功能、RAG 检索范围、添加内容类型、智能规则匹配、重复组和文章批量选择通过 `aria-pressed` 同步视觉状态；版本历史公开当前预览项。
- 仍使用现有原生按钮、点击路径与 Tab 顺序，没有引入需要额外方向键模型的自定义 tab widget。
- 语义选择遵循 W3C 的 [`aria-current` 技术](https://www.w3.org/WAI/WCAG22/Techniques/aria/ARIA26)与[切换按钮模式](https://www.w3.org/WAI/ARIA/apg/patterns/button/examples/button/)。

## 文章上下文

- “打开文章”和“选择文章”按钮关联同一段受限描述，包含已读/未读、收藏、来源、日期、类型、资料夹、最多三个标签和最多 180 字摘要。
- 描述节点本身隐藏，只参与 `aria-describedby` 计算，不会在浏览顺序中成为一段重复静态文本；W3C 的[名称与描述实践](https://www.w3.org/WAI/ARIA/apg/practices/names-and-descriptions/)明确允许描述引用隐藏元素。
- 描述只使用文章列表响应中已经存在的摘要字段，不请求完整正文，不新增 API、IPC、数据库读取、诊断日志或网络传输。
- 当前打开文章使用 `aria-current`；批量选择按钮同时保留动作名称并公开 pressed 状态。

## 真实浏览器回归

- 隔离资料库中，“全部/网页”筛选从 `true/false` 正确切换为 `false/true`；切回后恢复。
- 选择 VoiceOver 标签后，`aria-current="page"` 从收件箱移到标签；文章选择从 `aria-pressed="false"` 变为 `true`，动作名称更新为“取消选择”。
- 添加窗口的“网页 URL/附件”从 `true/false` 切换为 `false/true`；文章助手初始摘要按钮被识别为 pressed。
- 文章按钮的描述关联进入实际 DOM，包含预期的本机测试来源、状态、资料夹、标签与摘要；截图目检确认没有视觉回归。隔离标签页、服务和资料库均已关闭或移入废纸篓。

## Mac 可访问性验收

- 按 [Electron 官方 macOS 无障碍方式](https://www.electronjs.org/docs/latest/tutorial/accessibility)从外部设置 `AXManualAccessibility`，没有把测试开关写入 Reader 设置。
- 打包候选 App 的原生树确认了状态映射：筛选和选择按钮成为带 0/1 值的 `AXCheckBox`，导航公开 `AXARIACurrent`，当前文章公开 `AXARIACurrent=true`，关联描述进入 `AXCustomContent`。通过原生 `AXPress` 后，“全部/网页”、标签导航和文章选择均随 React 状态更新。
- 候选包验收后唯一的渲染变化是把描述节点从视觉隐藏改为 HTML `hidden`。最终 App 的窗口由 CoreGraphics 确认为屏幕可见；对该精确产物读取的 Chromium 可访问树仍包含完整按钮描述和 pressed 状态，且描述没有成为独立 `StaticText` 或 `InlineTextBox`。
- 最终包自动化时，当前运行器未取得前台 macOS AX 窗口枚举，因而没有把候选包的原生 `AXPress` 结论冒充为最终产物的重复原生验收。最终人工 VoiceOver 听读与原生 AX 复验保留为发行前门禁。

## 自动验证

- 93/93 项自动测试通过，生产构建通过；`npm audit --audit-level=moderate` 为 0 漏洞。
- 100,003 篇、12 轮资料库基准：总览统计 p50 15.49 ms、p95 15.99 ms；全部列表、筛选和检索子项最高 p95 为 34.34 ms，低于 250 ms 门槛。
- 100 篇列表摘要载荷为 57,074 B；若携带完整正文则为 10,298,374 B，继续满足 512 KiB 摘要载荷门槛。
- 10,003 个检索片段、30 轮本地 RAG 基准：p50 25.65 ms，p95 27.21 ms，低于 250 ms 门槛。
- Universal App 的主程序和 Electron Framework 均包含 `x86_64 arm64`，包内短版本与构建号均为 0.31.0。
- 当前 App 通过 ad-hoc 深度严格签名验证，实测 `Signature=adhoc`、`TeamIdentifier=not set`；同版本 universal 更新 ZIP 与 `latest-mac.yml` 不存在。
- Universal DMG 通过 `hdiutil verify`，大小为 256,165,985 B，SHA-256 为 `822ff8ba29bc831018c14826cae4551528f9dadd41ecf4c4cc5f101936c40da3`。

## 已知边界

- 本轮验证了打包候选 App 的原生 Mac AX 属性和 `AXPress` 行为，以及最终精确产物的 Chromium 可访问树；最终包的原生 AX 复验、VoiceOver 真实语音听读、转子顺序、冗余播报与长时间连续导航仍需人工专项。
- 当前本地包仍缺少真实 Apple Developer ID、公证凭据、正式 GitHub Release 与 Apple Silicon 真机 Gatekeeper/跨版本升级验收；ad-hoc 包不会连接自动更新服务。
