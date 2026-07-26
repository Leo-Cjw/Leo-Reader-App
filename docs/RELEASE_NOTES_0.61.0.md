# Reader 0.61.0

本版本收紧桌面退出期间的更新入口。普通退出、渲染器故障安全退出或正式更新安装一旦开始，Reader 会先停止新的更新检查与 updater 事件，再等待已经进入的本地请求和后台事务自然完成，避免长任务收尾期间弹出新的安装提示。Schema 保持 v12，用户数据、备份与导入格式不变。

## 更新入口先行静默

- `closeReader()` 首先清除更新检查定时器并移除 updater 事件监听，然后停止电源/网络后台协调器。
- 本地 HTTP listener 与导入、订阅、Spotlight、语义索引和自动备份继续按 0.58 的 single-flight 语义自然 drain；不增加短超时，也不强杀活动操作。
- 更新 controller 引用只在本地服务成功关闭后清空。由更新安装触发的关闭若失败，已下载版本仍可按 0.59 的规则再次确认。
- 退出窗口期间不再处理新的检查结果或下载完成事件，因此不会与正在进行的资料库收尾竞争或再次弹窗。

## 验证

- 158/158 项自动测试通过。新增确定性桌面回归固定 updater stop、后台协调 stop、server drain 与 controller clear 的顺序，既有更新安装及服务 single-flight 测试继续通过。
- TypeScript 与 Vite 生产构建通过；生产依赖为 0 个已知漏洞，构建树只保留已评估且精确放行的 `GHSA-mh99-v99m-4gvg`。
- 100,003 篇资料库门禁中，各类查询 p95 最高 56.78 ms；10,003 个 RAG 片段的词法与语义查询 p95 分别为 43.51 ms 和 160.16 ms，均低于 250 ms 门槛。
- Universal 最终包继续通过非回环监听、DNS rebinding、跨域来源、七项统一响应头、拒绝后零写入与精确同源请求门禁。
- 主 App、Share Extension 和 Spotlight helper 均回读为 `0.61.0 (61)` 且为 x86_64 + arm64；Canvas 原生模块切片、entitlement 与深度严格签名验证通过。
- 最终包 318 个 AX 节点/14 个对话框/0 个未命名交互控件、Share 文本/文件/URL handoff 与确认前零写入门禁全部通过。
- 冻结的 Reader 0.43.0/schema v11 资料库升级到 0.61.0/schema v12 后，文章、资料夹、标签、高亮、版本、智能资料夹、待处理导入、设置和附件均保留，附件 SHA-256 不变，升级后写入、重启与 SQLite 完整性检查通过。

## 发行边界

- Universal DMG 为 254,570,339 bytes；SHA-256 为 `e9a5e57e924dbd5895922500aba6c5b0b87b9b92e1d151c45b57119cf681af8b`，`hdiutil verify` 与 `.sha256` sidecar 独立校验均通过。
- 当前本地发行仍使用 ad-hoc 签名且未公证，因此清单只包含 DMG，不生成或使用自动更新 ZIP。
- Developer ID、Apple 公证、正式 GitHub Release、Intel/Apple Silicon 跨版本自动安装、Gatekeeper 和真实系统来源 Share/Spotlight/通知验收仍需发行凭据与真机条件。
