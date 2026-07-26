# Reader 0.53.0

本版本修复 macOS 容器 App 与嵌入原生组件的发行身份漂移。0.52 最终包中主 App 的 `CFBundleVersion` 已随发行版本更新，但 Share Extension 和 Spotlight helper 仍停留在构建号 `50`；0.53 建立单一版本契约，避免这个隐患进入 Developer ID、公证与跨版本安装阶段。Schema 保持 v12，应用功能、用户数据和旧备份格式不变。

## 单一发行身份

- `package.json` 的三段数字 `version` 与 Electron Builder 实际消费的正整数 `build.buildVersion` 是 macOS 发行身份的唯一来源；0.53.0 使用构建号 `53`。
- Share Extension 与 Spotlight helper 仍从受控源码模板构建，但只在临时产物中盖印当前营销版本和构建号，不修改用户数据或系统中已经安装的 Reader。
- Electron Builder 使用同一 `build.buildVersion` 生成主 App 的 `CFBundleVersion`，三个 bundle 因此不再依赖互不关联的手工版本字段。

## 双重阻断验证

- 源码回归直接验证版本语法、正整数构建号、匹配与故意漂移的失败路径，并要求两个原生模板与当前发行元数据一致。
- Share Extension 和 Spotlight helper 在签名前回读各自生成的 `Info.plist`，盖印失败立即中止原生构建。
- x64/arm64 App 合并完成后，发行脚本再次读取主 App、Share Extension 与 Spotlight helper 的真实 `Info.plist`；任一 `CFBundleShortVersionString` 或 `CFBundleVersion` 不一致都会在签名、DMG、公证和发布之前 fail closed。

## 验证

- 146/146 项自动测试通过。新增覆盖版本语法、正整数构建号、故意构建号漂移拒绝，以及两个原生模板与当前 package 发行身份的真实 plist 回读。
- TypeScript 与 Vite 生产构建通过；生产依赖为 0 个已知漏洞，构建树只保留已评估且精确放行的 `GHSA-mh99-v99m-4gvg`。
- 100,003 篇资料库门禁中，各类查询 p95 最高 32.95 ms；10,003 个 RAG 片段的词法与语义查询 p95 分别为 24.17 ms 和 135.36 ms，均低于 250 ms 门槛。
- 首次 Universal 候选因主 App 仍为构建号 `0.53.0`、嵌入组件为 `53` 被新增门禁中止，证明漂移会 fail closed；把唯一构建号移到 Electron Builder 实际消费的 `build.buildVersion` 后，最终主 App、Share Extension 和 Spotlight helper 均回读为 `0.53.0 (53)`。
- Universal 最终包深度严格签名校验通过，三个 bundle 均为 x86_64 + arm64。AX 门禁暴露 318 个节点、14 个对话框、0 个未命名交互控件；Share 文本/文件/URL handoff 与确认前零写入门禁全部通过。
- 冻结的 Reader 0.43.0/schema v11 资料库升级到 0.53.0/schema v12 后，文章、资料夹、标签、高亮、版本、智能资料夹、待处理导入、设置和附件均保留，附件 SHA-256 不变，升级后写入、重启与 SQLite 完整性检查通过。

## 发行边界

- Universal DMG 为 253,815,867 bytes；SHA-256 为 `6e3c96393ec6c807a880e41a51499527cb4ec282d4acfd3375d32589ec44cb29`，`hdiutil verify` 通过。
- 当前本地发行仍使用 ad-hoc 签名且未公证，不会生成或使用自动更新 ZIP。
- Developer ID、Apple 公证、正式 GitHub Release、Intel/Apple Silicon 跨版本自动安装、Gatekeeper 和真实系统来源 Share/Spotlight/通知验收仍需发行凭据与真机条件。
