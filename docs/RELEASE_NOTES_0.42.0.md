# Reader 0.42.0

本版本把 Reader 接入 macOS 系统分享菜单。安装后，Safari、浏览器及其他提供网页 URL 的 Mac App 可以通过“存入 Reader”把单个链接交给现有添加窗口；扩展不会自动抓取、创建任务或写入资料库。SQLite schema 保持 v11，文章、附件、备份、设置与 Markdown 导入导出格式均与 0.41.0 兼容。

## 系统分享

- 新增嵌入 `Reader.app/Contents/PlugIns` 的原生 macOS Share Extension，bundle ID 为 `com.reader.localfirst.share-extension`，显示名为“存入 Reader”。
- 激活规则使用 strict matching，只接受一个网页 URL，不声明任意文本、文件、图片、视频或附件。系统未自动显示时，可从分享菜单的“编辑扩展”启用。
- 用户选择扩展后只把链接交给 `reader-local://add`；Reader 聚焦或冷启动后预填既有添加窗口，仍需选择资料夹并点击“加入导入队列”。取消不会联网、创建任务或改变资料库。

## 最小权限与签名

- Share Extension 运行于 App Sandbox，签名只包含 `com.apple.security.app-sandbox`。它不联网、不读写文件、不访问 Reader SQLite、Keychain、UserDefaults 或 App Group，也不保存分享历史或失败载荷。
- Swift 输入校验只接受最长 2,048 字符、带有效 host、无控制字符/用户名/密码的 HTTP(S) URL；深链由 `URLComponents` 生成。Electron 主进程仍执行第二次固定 scheme/action/唯一参数校验，提交后服务端继续执行权威 SSRF 校验。
- 扩展和主 App 都构建为 x86_64 + arm64。最终签名流程会在父 App 重签后回读扩展 sandbox entitlement，避免 `codesign --deep` 静默剥离。
- 正式签名关闭 entitlement 自动补全；主程序、Share Extension 与 Spotlight helper 的产物权限必须分别精确等于 V8 JIT、App Sandbox 和空集合，额外 App Group 或硬件权限都会使构建失败。

## 验证

- `npm test`：123/123 通过；`npm run build`：生产构建通过；`npm run audit:dependencies`：生产依赖 0 个已知漏洞。
- Swift 自测覆盖 String/URL/Data 输入、Unicode、query/fragment 往返、凭据、控制字符、危险协议、缺失 host 和超长链接；Node 测试核对激活规则、App Sandbox、构建/嵌入/重签及主程序最小权限。
- Universal 候选 App 的主程序、Spotlight helper 和 Share Extension 均同时包含 `x86_64` 与 `arm64`；App 深度严格签名与 `hdiutil verify` 通过。
- 当前 x64 Mac 上，`pluginkit` 识别并启用候选扩展，`NSSharingService` 枚举出“存入 Reader”；原生分享测试 URL 返回 `SHARE_COMPLETED`。隔离候选 App 准确预填 URL，数据库仍为 3 篇种子文章、0 个导入任务，证明没有绕过确认。

## Universal 包

- `release/Reader-0.42.0-universal.dmg`：253,754,370 bytes。
- SHA-256：`9d23e7b50429d5178e008dcbefd4d83edef0085338af735ed44b375ad6e07f46`。
- 当前仍为 ad-hoc 签名，不生成自动更新 ZIP。

## 已知边界

- 当前扩展只接收网页 URL，不接收文件、图片、选中文本或多条载荷；这些类型需要独立的权限、暂存和恢复协议，不能复用 URL 深链强行承载。
- 系统分享扩展可能需要用户从分享菜单的“编辑扩展”手动启用。Reader 不调用 `pluginkit` 改写用户偏好。
- 仍缺少真实 Apple Developer ID、公证、正式 GitHub Release、Apple Silicon Gatekeeper/跨版本升级验收，以及正式签名包的系统通知、Spotlight 点击与 Share Extension 最终复验。
