# Reader 0.41.0

本版本为 Reader 增加默认关闭、仅限本机且可彻底删除的 macOS Spotlight 搜索。用户明确开启后，Reader 才会把标题、摘要、作者、来源、标签与有限正文写入受数据保护的系统索引；文章编辑、标签、归档和删除通过 SQLite 持久化队列可靠同步。SQLite schema 从 v10 升级到 v11，升级前仍自动创建一致性快照，文章、附件、备份与 Markdown 导入导出格式保持兼容。

## Spotlight 搜索

- 设置新增独立“在 macOS Spotlight 中搜索”开关，默认关闭。旧设置缺失字段、类型错误、读取失败、源码模式或 helper 不可用时都不会隐式开启。
- 开启后索引标题、最多 2,000 字摘要、最多 20,000 字正文、作者、来源、类型、语言、标签与时间；使用 Reader 专属命名 index/domain 和 `completeUntilFirstUserAuthentication` 数据保护级别。
- Spotlight 结果点击由嵌套 Swift helper 生成 `reader-local://open?article=<id>`。helper 与 Electron 主进程分别验证固定 action、唯一参数、长度和控制字符，主进程还会向 SQLite 确认文章存在，再复用只读专注窗口。
- 关闭会先删除 Reader 的整个 Spotlight domain；只有系统确认删除后才保存关闭状态并清空待处理队列。删除失败不会误报为已关闭。

## 可靠性与安全

- schema v11 新增每文章单行、单调 revision 的 `spotlight_outbox`。文章可索引字段、归档状态和标签变化由 SQLite trigger 记录；Core Spotlight 成功后才按 `(article_id, revision)` 条件确认，处理中再次编辑不会被旧批次覆盖。
- 启用时重新排队全部文章，随后以最多 100 条顺序批次增量同步。helper 超时、崩溃、非零退出、过大/无效响应或系统索引失败只留下待重试项，不阻断 Reader 启动、文章写入或本地 API。
- Swift helper 同时包含 x86_64 与 arm64，无 Dock 图标，不读 Reader 数据库、不接受任意路径且不联网。正文只经 stdin JSON 传入，不进入 argv；子进程只继承固定 `PATH` 与 `LANG`，输入、输出、字段长度和运行时间均有上限。
- 系统索引不进入 Reader 完整备份、Markdown 导出或多设备同步；关闭开关可从系统索引删除全部 Reader 内容。

## 验证

- 自动测试覆盖 v7/v8→v11 迁移与审计、并发 revision 确认、标签/归档/删除触发、全量启用、内容长度上限、失败保留与重试、关闭删除、默认关闭/旧设置、严格布尔 API、helper 不可用闭锁、Spotlight 深链语法与打包资源。
- `npm test`：120/120 通过；`npm run build`：生产构建通过；`npm run audit:dependencies`：生产依赖 0 漏洞。
- Universal Swift helper 独立构建与严格签名校验通过，同时包含 `x86_64` 与 `arm64`。在当前 x64 Mac 以签名 helper 完成 Core Spotlight availability、写入、按标题查询命中指定 identifier、删除及删除后查询为空的真实闭环。
- Universal 候选 App 使用隔离资料目录真实启动；回读 schema v11、4 条迁移审计、SQLite `integrity_check=ok` 与 `0700/0600` 权限。打包服务报告 Spotlight 可用，启用后 3 条初始内容全部确认；标题更新可检索、归档后结果删除，停用后 domain 删除、outbox 为 0 且 `settings.json` 保持 `0600`。

## Universal 包

- `release/Reader-0.41.0-universal.dmg`：253,659,642 bytes。
- SHA-256：`fa555938165314c5c1a71c834de7ba0c2e64803ca88dae43c9b547e64d7e5b43`。
- 发行候选 App 的主程序、嵌套 Spotlight helper 均同时包含 `x86_64` 与 `arm64`；App 深度严格签名与 `hdiutil verify` 通过。
- 当前仍为 ad-hoc 签名，不生成自动更新 ZIP。

## 已知边界

- Core Spotlight 的真实写入、查询和删除已经在当前 x64 Mac 通过；从系统 Spotlight UI 点击结果唤起最终打包 Reader，仍需在 Developer ID 签名、公证包上完成最终人工验收。
- 当前包仍缺少真实 Apple Developer ID、公证、正式 GitHub Release、Apple Silicon Gatekeeper/跨版本升级验收，以及正式签名包的系统通知、恢复提示重载按钮、原生 AX 与启用 VoiceOver 的完整人工复验。
