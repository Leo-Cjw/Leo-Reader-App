# Reader 0.60.0

本版本收紧正式自动更新的运行时信任边界。Reader 不再仅凭当前 App 中可读取的 Developer ID 元数据启用更新，而是先验证整个 App 的代码签名仍完整有效。Schema 保持 v12，用户数据、备份与导入格式不变。

## 完整签名验证

- 更新控制器先调用固定的 `/usr/bin/codesign --verify --deep --strict --verbose=4`，验证主 App 及其嵌套代码当前仍有效。
- 只有完整验证成功后才调用 `codesign --display`，并同时要求 Developer ID Application authority 与有效 Team Identifier。
- 验证或元数据读取任一步失败都不会设置更新 feed、创建检查定时器或联系更新服务。
- 两次本机检查均保留 10 秒超时和 256 KiB 输出上限；有效 ad-hoc 包仍因身份不符保持离线。

## 验证

- 157/157 项自动测试通过。新增确定性回归固定完整验证→身份读取的调用顺序、命令参数与资源边界，并证明无效签名会在读取元数据前 fail closed。
- TypeScript 与 Vite 生产构建通过；生产依赖为 0 个已知漏洞，构建树只保留已评估且精确放行的 `GHSA-mh99-v99m-4gvg`。
- 100,003 篇资料库门禁中，各类查询 p95 最高 37.60 ms；10,003 个 RAG 片段的词法与语义查询 p95 分别为 28.63 ms 和 165.91 ms，均低于 250 ms 门槛。
- Universal 最终包继续通过非回环监听、DNS rebinding、跨域来源、七项统一响应头、拒绝后零写入与精确同源请求门禁。
- 主 App、Share Extension 和 Spotlight helper 均回读为 `0.60.0 (60)` 且为 x86_64 + arm64；Canvas 原生模块切片、entitlement 与深度严格签名验证通过。
- 最终包 317 个 AX 节点/14 个对话框/0 个未命名交互控件、Share 文本/文件/URL handoff 与确认前零写入门禁全部通过。
- 冻结的 Reader 0.43.0/schema v11 资料库升级到 0.60.0/schema v12 后，文章、资料夹、标签、高亮、版本、智能资料夹、待处理导入、设置和附件均保留，附件 SHA-256 不变，升级后写入、重启与 SQLite 完整性检查通过。
- 对实际 0.60 ad-hoc Universal App 执行新的运行时资格检查返回 `eligible=false`，未启用更新服务。

## 发行边界

- Universal DMG 为 254,425,415 bytes；SHA-256 为 `73f066246b31921bf39c91ff424fdfb3e44160c3640a4ab29828f992d5e39496`，`hdiutil verify` 与 `.sha256` sidecar 独立校验均通过。
- 当前本地发行仍使用 ad-hoc 签名且未公证，因此清单只包含 DMG，不生成或使用自动更新 ZIP。
- Developer ID、Apple 公证、正式 GitHub Release、Intel/Apple Silicon 跨版本自动安装、Gatekeeper 和真实系统来源 Share/Spotlight/通知验收仍需发行凭据与真机条件。
