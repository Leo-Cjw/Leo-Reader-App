# Reader 0.54.0

本版本收紧无账号本地 HTTP API 的浏览器来源边界。Reader 仍只在随机 `127.0.0.1` 端口运行，但此前服务端会接受任意 Host 与跨站 Origin；0.54 在所有路由和数据访问之前拒绝 DNS rebinding 与浏览器跨站请求。Schema 保持 v12，产品功能、用户数据和现有备份格式不变。

## 精确回环 Host

- 默认回环模式从已监听 socket 读取本轮真实随机端口，并要求每个 HTTP `Host` 精确等于 `127.0.0.1:<port>`。
- 攻击者域名即使经 DNS rebinding 解析到 `127.0.0.1`，其 Host 仍不匹配，不能访问静态界面、读取 API 或提交写入。
- 校验不信任请求 URL 中的 authority，也不使用可由客户端提供的 forwarded host。

## 浏览器来源边界

- 请求带 `Origin` 时必须精确等于 Reader 本轮 `http://127.0.0.1:<port>` origin；恶意网页、其他回环端口与 `null` origin 都会返回 403。
- 请求带 `Sec-Fetch-Site` 时只接受 `same-origin` 与顶层导航的 `none`，拒绝 `cross-site` 和 `same-site`。
- 三项检查位于 URL 解析、路由、请求体读取、备份/导入操作和 SQLite 访问之前，拒绝请求不会产生文章、任务、设置或诊断中的成功记录。

## 兼容与边界

- Electron 渲染器继续使用精确随机 origin；Share Extension 文件桥、最终包 QA 和不带浏览器来源头的同机 Node/CLI 调用保持兼容。
- 这不是面向已取得当前用户权限进程的身份认证；同权限进程仍能直接访问回环 socket 或数据文件。
- 用户显式修改 `READER_HOST` 会离开默认回环保护，安全文档继续明确不建议这样做。

## 验证

- 147/147 项自动测试通过。新增真实 HTTP 回归分别验证恶意 Host 无法读取健康端点、恶意 Origin 无法创建文章、无 Origin 的 `cross-site` 请求无法读取文章列表、三次拒绝后资料库零写入，以及精确同源请求仍可正常写入。
- TypeScript 与 Vite 生产构建通过；生产依赖为 0 个已知漏洞，构建树只保留已评估且精确放行的 `GHSA-mh99-v99m-4gvg`。
- 100,003 篇资料库门禁中，各类查询 p95 最高 34.87 ms；10,003 个 RAG 片段的词法与语义查询 p95 分别为 27.40 ms 和 154.70 ms，均低于 250 ms 门槛。
- Universal 最终包深度严格签名校验通过，主 App、Share Extension 和 Spotlight helper 均回读为 `0.54.0 (54)` 且为 x86_64 + arm64。最终包回环门禁直接启动候选 App，确认恶意 Host、跨域写入和 cross-site 读取均被阻断、拒绝请求产生 0 次资料库写入，并验证精确同源写入正常。AX 门禁暴露 318 个节点、14 个对话框、0 个未命名交互控件；Share 文本/文件/URL handoff 与确认前零写入门禁全部通过。
- 冻结的 Reader 0.43.0/schema v11 资料库升级到 0.54.0/schema v12 后，文章、资料夹、标签、高亮、版本、智能资料夹、待处理导入、设置和附件均保留，附件 SHA-256 不变，升级后写入、重启与 SQLite 完整性检查通过。

## 发行边界

- Universal DMG 为 255,137,717 bytes；SHA-256 为 `33ea3fd16d746cf4b1aa26dcd715fe491cc4efd9a6531e2626a45103bba63036`，`hdiutil verify` 通过。
- 当前本地发行仍使用 ad-hoc 签名且未公证，不会生成或使用自动更新 ZIP。
- Developer ID、Apple 公证、正式 GitHub Release、Intel/Apple Silicon 跨版本自动安装、Gatekeeper 和真实系统来源 Share/Spotlight/通知验收仍需发行凭据与真机条件。
