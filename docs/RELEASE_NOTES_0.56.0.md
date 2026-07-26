# Reader 0.56.0

本版本为无账号本地 HTTP 服务补齐统一的响应侧浏览器边界。0.54–0.55 已限制请求来源与监听地址；0.56 进一步让静态界面、API、错误、导出和私有媒体响应都显式拒绝跨源嵌入与资源复用，并关闭不需要的设备权限和 Referrer。Schema 保持 v12，产品功能、用户数据和现有备份格式不变。

## 统一响应策略

- 全部响应声明 CSP `frame-ancestors 'self'` 与 X-Frame-Options `SAMEORIGIN`，跨源页面不能把 Reader 页面、PDF 或私有资源嵌入 frame/object。
- Cross-Origin-Resource-Policy 与 Cross-Origin-Opener-Policy 固定为 `same-origin`，避免其他 origin 复用资源或共享顶层窗口上下文。
- Permissions Policy 禁止相机、地理位置和麦克风；Referrer Policy 为 `no-referrer`；所有响应均使用 `nosniff`。
- 安全头在 Host、Origin 与 Fetch Metadata 校验之前设置，因此 403/404/500 等错误响应也不会形成较弱的旁路。

## 功能兼容

- `frame-ancestors 'self'` 和 `SAMEORIGIN` 有意保留 Reader 内部同源 PDF `<object>`、图片、音视频、缩略图与 Range 请求，不使用会破坏 PDF 预览的全局 `DENY`。
- HTML 中现有完整 CSP 继续约束脚本、样式、图片、媒体、连接、frame、base 与表单；Electron 主进程的全权限拒绝和导航白名单继续叠加生效。
- API 契约、同机 Node/CLI 调用、Share/Spotlight handoff 均不改变。Schema 保持 v12，不新增迁移。

## 验证

- 148/148 项自动测试通过。回归直接覆盖 API JSON、恶意 Host 的 403 错误、静态 HTML 和附件 Range 响应的七项安全头；既有 PDF、缩略图、导出和媒体测试继续通过。
- TypeScript 与 Vite 生产构建通过；生产依赖为 0 个已知漏洞，构建树只保留已评估且精确放行的 `GHSA-mh99-v99m-4gvg`。
- 100,003 篇资料库门禁中，各类查询 p95 最高 32.94 ms；10,003 个 RAG 片段的词法与语义查询 p95 分别为 26.32 ms 和 132.25 ms，均低于 250 ms 门槛。
- Universal 最终包直接回读全部七项响应策略，并继续通过非回环环境覆盖、DNS rebinding、跨域写入、cross-site 读取、拒绝后零写入和精确同源写入门禁。
- 主 App、Share Extension 和 Spotlight helper 均回读为 `0.56.0 (56)` 且为 x86_64 + arm64；两套 Canvas 原生模块分别为正确切片，深度严格签名校验通过。
- 最终包 318 个 AX 节点/14 个对话框/0 个未命名交互控件、Share 文本/文件/URL handoff 与确认前零写入门禁全部通过。
- 冻结的 Reader 0.43.0/schema v11 资料库升级到 0.56.0/schema v12 后，文章、资料夹、标签、高亮、版本、智能资料夹、待处理导入、设置和附件均保留，附件 SHA-256 不变，升级后写入、重启与 SQLite 完整性检查通过。

## 发行边界

- Universal DMG 为 253,865,734 bytes；SHA-256 为 `019088761b9fd2ca74f22810f3a71189dbbb6ee633082737460d44e748e7fc11`，`hdiutil verify` 通过。
- 当前本地发行仍使用 ad-hoc 签名且未公证，不会生成或使用自动更新 ZIP。
- Developer ID、Apple 公证、正式 GitHub Release、Intel/Apple Silicon 跨版本自动安装、Gatekeeper 和真实系统来源 Share/Spotlight/通知验收仍需发行凭据与真机条件。
