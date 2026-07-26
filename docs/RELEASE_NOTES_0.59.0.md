# Reader 0.59.0

本版本收紧正式更新下载完成后的安装协调。下载事件、菜单“检查更新”和重复回调现在共享同一提示与安装状态，避免并发弹窗、重复关闭后台或重复调用系统 updater。Schema 保持 v12，用户数据、备份与导入格式不变。

## Single-flight 更新安装

- 安装提示进行中时，所有并发入口复用同一 Promise，同一已下载版本只显示一个确认框。
- 用户选择“稍后”会释放提示状态；安装前安全关闭失败会显示既有警告并允许之后重试，不会调用 updater。
- 安全关闭成功后，本轮只调用一次 `quitAndInstall()`；后续下载事件或菜单检查不会重复弹窗、重复关闭后台或重复安装。
- 如果系统 updater 在安全关闭完成后同步拒绝启动，Reader 会立即走正常 App 退出，不留下界面尚在但本地服务已停止的失效进程。

## 验证

- 155/155 项自动测试通过。新增确定性回归覆盖三个并发安装入口、取消/关闭失败后的重试，以及 updater 启动失败后的安全退出顺序。
- TypeScript 与 Vite 生产构建通过；生产依赖为 0 个已知漏洞，构建树只保留已评估且精确放行的 `GHSA-mh99-v99m-4gvg`。
- 100,003 篇资料库门禁中，各类查询 p95 最高 33.08 ms；10,003 个 RAG 片段的词法与语义查询 p95 分别为 28.97 ms 和 138.75 ms，均低于 250 ms 门槛。
- Universal 最终包继续通过非回环监听、DNS rebinding、跨域来源、七项统一响应头、拒绝后零写入与精确同源请求门禁。
- 主 App、Share Extension 和 Spotlight helper 均回读为 `0.59.0 (59)` 且为 x86_64 + arm64；Canvas 原生模块切片、entitlement 与深度严格签名验证通过。
- 最终包 318 个 AX 节点/14 个对话框/0 个未命名交互控件、Share 文本/文件/URL handoff 与确认前零写入门禁全部通过。
- 冻结的 Reader 0.43.0/schema v11 资料库升级到 0.59.0/schema v12 后，文章、资料夹、标签、高亮、版本、智能资料夹、待处理导入、设置和附件均保留，附件 SHA-256 不变，升级后写入、重启与 SQLite 完整性检查通过。

## 发行边界

- Universal DMG 为 253,810,209 bytes；SHA-256 为 `dbfdedb8a8051624a5fa411ef9b24d37c681a318aff5fad53696b1fcff605097`，`hdiutil verify` 与 `.sha256` sidecar 独立校验均通过。
- 当前本地发行仍使用 ad-hoc 签名且未公证，因此清单只包含 DMG，不生成或使用自动更新 ZIP。
- Developer ID、Apple 公证、正式 GitHub Release、Intel/Apple Silicon 跨版本自动安装、Gatekeeper 和真实系统来源 Share/Spotlight/通知验收仍需发行凭据与真机条件。
