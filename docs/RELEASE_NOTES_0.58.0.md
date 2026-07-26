# Reader 0.58.0

本版本收紧普通退出、渲染器故障安全退出和正式更新安装共用的本地服务关闭顺序。Reader 现在先进入不再接收新请求的 quiescing 状态，再等待已经开始的 HTTP 请求和后台事务自然完成，避免长任务收尾期间出现新的资料库写入。Schema 保持 v12，用户数据、备份与导入格式不变。

## Single-flight 安全关闭

- 首次 `readerServer.close()` 立即调用 HTTP server close，停止接受新的回环连接；已经进入的请求仍按 Node HTTP 语义完成。
- 导入、订阅、Spotlight、语义索引和自动备份继续并行停止，并保留原有任务/事务收尾，不增加短超时，也不调用 `closeAllConnections` 强杀活动操作。
- 普通退出、安全退出和更新安装若并发触发，会复用同一关闭 Promise；后台组件 stop、`app_stopped` 诊断和日志 flush 只执行一次。
- HTTP close 放在收尾 `finally` 中等待，即使后台组件停止报错也不会跳过 listener 关闭。

## 验证

- 152/152 项自动测试通过。新增确定性回归用延迟完成的 Spotlight stop 保持后台 drain，直接确认 listener 已停止监听、两个 close 引用同一 Promise、组件只停止一次、停止诊断在 drain 前为零且完成后精确为一。
- TypeScript 与 Vite 生产构建通过；生产依赖为 0 个已知漏洞，构建树只保留已评估且精确放行的 `GHSA-mh99-v99m-4gvg`。
- 100,003 篇资料库门禁中，各类查询 p95 最高 36.94 ms；10,003 个 RAG 片段的词法与语义查询 p95 分别为 30.76 ms 和 132.11 ms，均低于 250 ms 门槛。
- Universal 最终包继续通过非回环监听、DNS rebinding、跨域来源、七项统一响应头、拒绝后零写入与精确同源请求门禁。
- 主 App、Share Extension 和 Spotlight helper 均回读为 `0.58.0 (58)` 且为 x86_64 + arm64；Canvas 原生模块切片、entitlement 与深度严格签名验证通过。
- 最终包 318 个 AX 节点/14 个对话框/0 个未命名交互控件、Share 文本/文件/URL handoff 与确认前零写入门禁全部通过。
- 冻结的 Reader 0.43.0/schema v11 资料库升级到 0.58.0/schema v12 后，文章、资料夹、标签、高亮、版本、智能资料夹、待处理导入、设置和附件均保留，附件 SHA-256 不变，升级后写入、重启与 SQLite 完整性检查通过。

## 发行边界

- Universal DMG 为 253,836,265 bytes；SHA-256 为 `9d4de56572c236ead1d0c4d3bf9b92214973f329a3c1da0c2eb115924ab6d2f2`，`hdiutil verify` 与 `.sha256` sidecar 独立校验均通过。
- 当前本地发行仍使用 ad-hoc 签名且未公证，因此清单只包含 DMG，不生成或使用自动更新 ZIP。
- Developer ID、Apple 公证、正式 GitHub Release、Intel/Apple Silicon 跨版本自动安装、Gatekeeper 和真实系统来源 Share/Spotlight/通知验收仍需发行凭据与真机条件。
