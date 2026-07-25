# Reader 0.36.0

本版本收口顶层模态框的真实交互边界：`aria-modal="true"` 不再只是语义标记，窗口打开期间主界面和较低层窗口会成为浏览器原生 inert 子树，鼠标、键盘、程序化菜单焦点与辅助技术都只能操作最上层窗口。SQLite schema 保持 v10，HTTP API、设置、文章、附件、备份和导入导出格式均不变。

## 模态隔离

- 任一顶层模态框出现时，应用根部的 `DialogAccessibilityManager` 为 `.app-window` 设置原生 HTML `inert`；全部窗口关闭或管理器卸载时立即清除。
- 如果桌面菜单或同一次 React 状态切换使多个模态框短暂共存，只有 DOM 最上层窗口保持可交互，其他窗口同样进入 inert。
- 捕获到意外移出当前窗口的焦点时，Reader 会把焦点送回当前窗口的首个可用控件，不会把逃逸目标记成新的恢复位置。
- 既有初始焦点、Tab/Shift+Tab 回环、Escape、忙碌态关闭门禁和关闭后触发器恢复保持不变；非模态的正文高亮浮层不受影响。

## 验证

- 新增静态回归覆盖主窗口 inert、较低层窗口 inert、焦点逃逸纠正、Escape、恢复路径和卸载清理。
- 真实 Chromium 回归确认：打开“添加到 Reader”后初始焦点位于网页地址，主窗口持续 inert；输入触发 React 重渲染后隔离仍存在；Tab 与 Shift+Tab 在首尾控件之间回环；Escape 关闭后 inert 被移除并把焦点还给“＋ 添加”。
- 最终 Universal App 通过真实 macOS“编辑 → 搜索资料库”菜单触发程序化聚焦：模态框打开时焦点仍留在网页地址，关闭后同一菜单可以正常聚焦背景搜索框。测试期间导入队列始终为空。
- `npm test`：104/104 通过；`npm run build`：生产构建通过；`npm run audit:dependencies`：生产依赖 0 漏洞，完整树仅保留 0.34 已评估的构建工具公告。

## Universal 包

- `Reader-0.36.0-universal.dmg`：253,643,257 字节；SHA-256 `e914bc0b6b98fccef9d8e0c8fd788c8f7094b8eb79ea0754e1237ecb2d9c79ad`。
- DMG 校验通过；App 主程序同时包含 `x86_64` 与 `arm64`，短版本与 build 均为 `0.36.0`，Bundle ID 为 `com.reader.localfirst`。
- 深度严格签名校验通过；最终 ASAR 包含 0.36 服务端版本和模态 inert/清理实现，隔离数据目录中的最终 App `/api/health` 返回 0.36.0。
- 最终包仍为 ad-hoc 签名且没有 Team Identifier，因此未生成可用于正式自动更新的 ZIP。

## 已知边界

- 自动回归验证了 Chromium 交互树和最终 App 菜单焦点行为，不等同于启用 VoiceOver 后对转子顺序、冗余播报和长时间导航的完整人工听读。
- 当前包仍缺少真实 Apple Developer ID、公证、正式 GitHub Release、Apple Silicon Gatekeeper/跨版本升级验收，以及最终包原生 AX 复验。
