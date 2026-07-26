# Reader 0.57.0

本版本把 macOS 交付物从“发行说明中人工记录一个哈希”升级为随构建生成、可独立复验的发布身份。DMG 和正式更新 ZIP 在完成原有签名、公证、解包或磁盘映像验证后，才会生成机器可读清单与标准 SHA-256 sidecar。Schema 保持 v12，产品功能、用户数据和现有备份格式不变。

## 可验证发行清单

- `Reader-<version>-release.json` 固定记录 Reader 版本、递增构建号、schema、appId、darwin/Universal 架构、Electron 版本、签名等级、40 位 Git 提交和已跟踪改动状态。
- 每个交付物只记录 basename、字节数和流式 SHA-256；清单不包含生成时间、本机路径、用户名、证书 identity、Keychain、公证 profile、令牌或环境变量。
- DMG 和正式 universal 更新 ZIP 各自带标准 `<artifact>.sha256`，可由系统 `shasum -a 256 -c` 独立复验。

## Fail-closed 构建边界

- 清单与 sidecar 先写入同目录临时文件，再原子替换；最终清单落盘后会重新读取每个产物，比较字节数和 SHA-256，并逐字核对 sidecar。
- Developer ID 公证模式要求源码没有已跟踪的未提交改动，并要求 DMG 与 universal 更新 ZIP 同时存在；任一条件不满足即拒绝形成正式清单。
- ad-hoc 模式只声明 DMG，并在同版本更新 ZIP 残留时失败，避免把旧正式更新包混入本机交付。
- 自动测试使用伪 DMG/ZIP 覆盖清单生成、无本机路径泄露、产物篡改拒绝、正式 clean-source 约束和构建顺序。

## 验证

- 151/151 项自动测试通过；TypeScript 与 Vite 生产构建通过。
- 生产依赖为 0 个已知漏洞；构建树只保留已评估且精确放行的 `GHSA-mh99-v99m-4gvg`。
- 100,003 篇资料库门禁中，各类查询 p95 最高 33.49 ms；10,003 个 RAG 片段的词法与语义查询 p95 分别为 24.96 ms 和 136.89 ms，均低于 250 ms 门槛。
- Universal 最终包继续通过非回环监听、DNS rebinding、跨域来源、七项统一响应头、拒绝后零写入与精确同源请求门禁。
- 主 App、Share Extension 和 Spotlight helper 均回读为 `0.57.0 (57)` 且为 x86_64 + arm64；Canvas 原生模块切片、entitlement 与深度严格签名验证通过。
- 最终包 318 个 AX 节点/14 个对话框/0 个未命名交互控件、Share 文本/文件/URL handoff 与确认前零写入门禁全部通过。
- 冻结的 Reader 0.43.0/schema v11 资料库升级到 0.57.0/schema v12 后，文章、资料夹、标签、高亮、版本、智能资料夹、待处理导入、设置和附件均保留，附件 SHA-256 不变，升级后写入、重启与 SQLite 完整性检查通过。

## 发行边界

- Universal DMG 为 253,819,228 bytes；SHA-256 为 `5893e17cde1124ba948dc2a4a716ffb7ce27877bac4eba74f1849428f783d788`，`hdiutil verify` 与 `.sha256` sidecar 独立校验均通过。
- 当前本地发行仍使用 ad-hoc 签名且未公证，因此清单只包含 DMG，不生成或使用自动更新 ZIP。
- Developer ID、Apple 公证、正式 GitHub Release、Intel/Apple Silicon 跨版本自动安装、Gatekeeper 和真实系统来源 Share/Spotlight/通知验收仍需发行凭据与真机条件。
