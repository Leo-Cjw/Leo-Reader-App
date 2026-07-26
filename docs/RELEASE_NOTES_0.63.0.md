# Reader 0.63.0

本版本收紧 AI 非密钥设置与 macOS Keychain 之间的跨存储一致性。此前普通更新已经会在设置写盘失败时恢复原凭据，但并发更新可能按异步完成顺序倒置最终结果；重置则会先删除密钥，随后若设置写盘失败，留下仍指向原提供商的配置却失去密钥。现在 AI 配置变更按调用顺序执行，重置失败也会尽力补偿原凭据。Schema 保持 v12，`settings.json` 格式保持 version 1，用户数据、备份与导入格式不变。

## AI 配置事务协调

- AI `update` 与 `reset` 共享独立的进程内变更队列；后一调用会等待前一调用完成，再读取最新设置与 Keychain 状态。
- 同时提交两次提供商、端点和密钥更新时，最终状态稳定对应后一次调用，不再由 Keychain 或设置文件的异步完成时序决定。
- `reset` 在删除 Keychain 密钥后若设置重置失败，会尽力恢复原密钥，并保留运行中 AI 服务的既有配置。
- 失败事务仍把错误返回给调用方，但队列会恢复，后续更新或重置可以继续。
- Keychain 补偿本身若失败仍会保留原错误；跨两个独立存储无法获得系统级原子提交，Reader 不把该边界误报为绝对原子性。

## 验证

- 161/161 项自动测试通过。新增确定性并发回归，复现先调用的更新覆盖后调用结果；新增故障注入回归，确认设置重置失败时恢复原 Keychain，且失败事务不堵塞下一次重置。
- TypeScript 与 Vite 生产构建通过；生产依赖为 0 个已知漏洞，构建树只保留已评估且精确放行的 `GHSA-mh99-v99m-4gvg`。
- 100,003 篇资料库门禁中，各类查询 p95 最高 32.84 ms；10,003 个 RAG 片段的词法与语义查询 p95 分别为 31.33 ms 和 141.93 ms，均低于 250 ms 门槛。
- Universal 最终包继续通过非回环监听、DNS rebinding、跨域来源、七项统一响应头、拒绝后零写入与精确同源请求门禁。
- 主 App、Share Extension 和 Spotlight helper 均回读为 `0.63.0 (63)` 且为 x86_64 + arm64；Canvas 原生模块切片、entitlement 与深度严格签名验证通过。
- 最终包 318 个 AX 节点/14 个对话框/0 个未命名交互控件、Share 文本/文件/URL handoff 与确认前零写入门禁全部通过。
- 冻结的 Reader 0.43.0/schema v11 资料库升级到 0.63.0/schema v12 后，文章、资料夹、标签、高亮、版本、智能资料夹、待处理导入、设置和附件均保留，附件 SHA-256 不变，升级后写入、重启与 SQLite 完整性检查通过。

## 发行边界

- Universal DMG 为 253,902,128 bytes；SHA-256 为 `22c52dd50235b692ad0fbf7defb5bcdfbc1d8e379d544a2a01ee075ff4d54e25`，`hdiutil verify` 与 `.sha256` sidecar 独立校验均通过。
- 当前本地发行仍使用 ad-hoc 签名且未公证，因此清单只包含 DMG，不生成或使用自动更新 ZIP。
- Developer ID、Apple 公证、正式 GitHub Release、Intel/Apple Silicon 跨版本自动安装、Gatekeeper 和真实系统来源 Share/Spotlight/通知验收仍需发行凭据与真机条件。
