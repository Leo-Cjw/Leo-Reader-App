# Reader 0.55.0

本版本关闭无账号本地 HTTP 服务的可变监听边界。Reader 现在固定只接受精确 IPv4 回环地址 `127.0.0.1`；非回环环境配置会在任何用户数据或后台服务初始化之前失败，不能再把 API 暴露到局域网或公网。Schema 保持 v12，产品功能、用户数据和现有备份格式不变。

## 固定回环监听

- 服务构造只接受 `127.0.0.1`。`0.0.0.0`、`localhost`、`::1` 和其他地址都会立即返回明确错误。
- 拒绝发生在创建数据目录、打开 SQLite、应用待恢复备份、启动导入/订阅/语义索引后台任务和创建监听 socket 之前，不会因无效网络配置触碰用户资料。
- 正式 Mac App 继续使用随机 IPv4 回环端口；源码服务入口中的 `READER_HOST` 也不能覆盖这项边界。

## 既有来源保护

- 0.54 的精确 `Host`、`Origin` 与 `Sec-Fetch-Site` 校验继续位于 URL 解析、路由、请求体和数据库访问之前。
- 最终包门禁主动给候选 App 注入 `READER_HOST=0.0.0.0`，只有实际页面 origin 仍为 `127.0.0.1` 才会继续验证 DNS rebinding、跨域写入、cross-site 读取、拒绝后零写入和精确同源写入。
- 不带浏览器来源头的同机 Node/CLI 请求继续可用；这不是针对已取得当前用户权限进程的身份认证。

## 兼容

- 桌面应用、Share Extension、Spotlight、现有随机端口启动和同机 API 客户端不变。
- 有意使用非 `127.0.0.1` 的源码服务配置不再受支持；Reader 的无账号 API 不提供远程服务模式。
- Schema 保持 v12，不新增迁移，不改变文章、附件、设置、备份或派生向量。

## 验证

- 148/148 项自动测试通过。新增回归验证 `0.0.0.0`、`localhost` 与 `::1` 都在数据根不存在时失败，且默认回环 API 全链路继续可用。
- TypeScript 与 Vite 生产构建通过；生产依赖为 0 个已知漏洞，构建树只保留已评估且精确放行的 `GHSA-mh99-v99m-4gvg`。
- 100,003 篇资料库门禁中，各类查询 p95 最高 42.04 ms；10,003 个 RAG 片段的词法与语义查询 p95 分别为 30.36 ms 和 161.32 ms，均低于 250 ms 门槛。
- Universal 最终包深度严格签名校验通过，主 App、Share Extension 和 Spotlight helper 均回读为 `0.55.0 (55)` 且为 x86_64 + arm64；两套 Canvas 原生模块分别为正确的 x64/arm64 切片。
- 最终包回环来源门禁、318 个 AX 节点/14 个对话框/0 个未命名交互控件、Share 文本/文件/URL handoff 与确认前零写入门禁全部通过。
- 冻结的 Reader 0.43.0/schema v11 资料库升级到 0.55.0/schema v12 后，文章、资料夹、标签、高亮、版本、智能资料夹、待处理导入、设置和附件均保留，附件 SHA-256 不变，升级后写入、重启与 SQLite 完整性检查通过。

## 发行边界

- Universal DMG 为 254,454,179 bytes；SHA-256 为 `efe6c11649d41bfa4bfb83935b6638e8fa87dbc07e4eb0e415d21d26c962cfcf`，`hdiutil verify` 通过。
- 当前本地发行仍使用 ad-hoc 签名且未公证，不会生成或使用自动更新 ZIP。
- Developer ID、Apple 公证、正式 GitHub Release、Intel/Apple Silicon 跨版本自动安装、Gatekeeper 和真实系统来源 Share/Spotlight/通知验收仍需发行凭据与真机条件。
