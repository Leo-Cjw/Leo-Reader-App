# Reader 0.28.0

本版本完成 macOS 正式发行所需的应用内自动更新代码与更新产物门禁。当前本地 DMG 仍为 ad-hoc 签名，因此明确保持自动更新离线；取得真实 Apple Developer ID 和公证凭据后，同一流水线才会生成可发布的 universal 更新 ZIP。

## 安全更新生命周期

- Reader 菜单新增“检查更新…”。正式签名版本启动一分钟后检查一次，此后每六小时检查；手动与自动检查共享单一进行中状态，不会重复下载。
- 更新源固定为公开 `Leo-Cjw/Leo-Reader-App` GitHub Release 的 `update.electronjs.org` `darwin-universal` 路由，不接受自定义服务器、凭据或私有 token。
- 启动时在设置 feed 前检查当前 App 的真实代码签名。只有 `Developer ID Application` authority 与有效 Team Identifier 同时存在才启用；开发、ad-hoc、Apple Development 或异常签名包均不连接更新服务。
- Electron 下载完成后由用户选择“重启并安装”或“稍后”。确认安装后先停止后台调度、导入/订阅 worker、诊断缓冲和本地 HTTP 服务，再交给系统更新器。
- 资料库继续独立保存在 `~/Library/Application Support/Reader/ReaderData/`，不进入 App 更新包。

## 正式发行流水线

- 配置 Developer ID 与 Keychain 公证 profile 后，流水线先签名、公证、装订并验证 universal `Reader.app`。
- 只有 App 公证成功才生成 `Reader-0.28.0-darwin-universal.zip`；解压副本必须再次通过深度严格签名和公证票据验证。
- DMG 从已装订的 App 创建，并另行提交公证和验证。未配置完整凭据时不生成更新 ZIP，并删除可能残留的同版本 ZIP。
- 发布自动更新仍需创建公开 GitHub Release 并上传该 ZIP；本轮没有真实证书和凭据，因此没有伪造正式更新产物。

## 自动验证

- 91/91 项自动测试通过，新增覆盖 Developer ID/Team Identifier 解析、固定 universal feed、ad-hoc 零连接、更新初始化故障闭锁、单一调度、下载后确认、安装前安全关闭与事件清理。
- 生产构建通过；`npm audit --audit-level=moderate` 为 0 漏洞。
- 10,003 个检索片段、30 轮本地 RAG 基准：p50 32.58 ms，p95 40.86 ms，低于 250 ms 门槛。
- 100,003 篇资料库、12 轮基准：整体 p50 198.82 ms、p95 204.14 ms；首屏、第二页和中间页 p95 分别为 67.98 ms、24.32 ms 与 22.70 ms。
- 100 篇列表摘要载荷为 57,074 B；若携带完整正文则为 10,298,374 B，继续满足 512 KiB 摘要载荷门槛。
- Universal App 的主程序和 Electron Framework 均包含 `x86_64 arm64`，包内版本与构建号均为 0.28.0，且包含新的主进程更新模块。
- 当前 App 通过 ad-hoc 深度严格签名验证，实测 `Signature=adhoc`、`TeamIdentifier=not set`，运行时门禁返回 `updateEligible=false`；同版本自动更新 ZIP 不存在。
- Universal DMG 通过 `hdiutil verify`，大小为 254,439,855 B，SHA-256 为 `0cefff2658370657044f3bccad853ab20a35e85b00d6484a2f8f2bf79183123a`。

## 已知边界

- 本机没有 Apple Developer ID 证书与公证凭据，无法执行 Apple 服务端公证，也无法端到端验证正式 ZIP 下载和 Squirrel.Mac 替换。
- 当前构建宿主为 Intel Mac；仍需在 Intel 与 Apple Silicon 真机完成 Gatekeeper 首装、0.28→后续正式版本自动升级及资料库不丢失验收。
