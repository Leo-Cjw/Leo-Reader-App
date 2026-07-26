# Reader 0.45.0

本版本把 macOS Share Extension 从单网页 URL 扩展为“网页 URL 或短文本摘录”，并把最终打包 App 的真实第二实例交接加入发行阻断门禁。SQLite schema 保持 v11；文章、附件、设置、备份和 Markdown 导入导出格式均与 0.44.0 兼容。

## 选中文本分享

- macOS 分享菜单现在可接收单个网页 URL 或单段文本；URL 行为保持不变。
- 文本限 4,096 UTF-8 bytes，保留换行、回车和 Tab，拒绝空白、其他控制字符及无效 UTF-8。
- Share Extension 使用无 padding 的规范 Base64URL 构造 `reader-local://add?text=...`。Electron 主进程执行严格解码、fatal UTF-8 和规范重编码检查，preload 再次验证请求形状、字节数与控制字符。
- 合格文本只会以标题“分享的文本摘录”和原文预填 Markdown 添加页；用户选择资料夹并点击保存前，不创建文章、不联网、不写入 SQLite。
- 扩展继续只持有 App Sandbox entitlement，不申请网络、文件、App Group、Keychain 或硬件权限。文件、图片和视频分享仍未开放。

## 最终包 Share 门禁

- Universal App 合并、签名并通过既有可访问性门禁后，自动化启动隔离候选，再以同一可执行文件的第二实例传入文本深链。
- 门禁核对 Markdown 页标题、逐字内容、默认资料夹与保存按钮，并通过统计 API 证明确认前文章数不变；点击保存后必须精确读回正文、内容类型与资料夹。
- 同一候选随后接收 URL 深链，必须显示 URL 添加页和原始地址，关闭前仍不写入。
- Share、跨版本升级与可访问性门禁均只使用临时 Chromium profile 和 Reader 数据根目录，不注册系统 scheme，不读取或改变用户资料。
- Universal 合并后会显式重签并单独严格验证位于 `Resources` 的 Spotlight Helper，避免只依赖宿主资源封印而漏过已合并 Mach-O 的失效内签名。

## 验证

- `npm test`：125/125 通过；`npm run build`：生产构建通过；`npm run audit:dependencies`：生产依赖 0 个已知漏洞。
- 最终 0.45 Universal 候选 Share 门禁通过：文本字节受限、确认前写入为 0、Markdown 精确持久化、URL 回归通过。
- 最终候选从 0.43.0 schema v11 基准完成读取、写入、退出、重启与完整性闭环；附件 SHA-256 保持不变。
- 最终候选暴露 317 个 AX 节点，八个核心模态框闭环全部通过，无无名交互控件。
- 主程序、Spotlight Helper 与 Share Extension 均包含 x86_64/arm64，App 深度严格签名和 `hdiutil verify` 通过。

## Universal 包

- `release/Reader-0.45.0-universal.dmg`：254,053,437 bytes。
- SHA-256：`a1ee9a3c93b0afe6fdb4e0959ab2949f6ec5bb4b40cf807e2c8bc3f0dd204a8c`。
- 当前仍为 ad-hoc 签名，不生成自动更新 ZIP。

## 已知边界

- 当前自动门禁验证的是最终 App 的深链和第二实例交接，不等同于从真实系统分享菜单、不同来源 App、Developer ID 签名和公证环境完成的端到端验收。
- 文件、图片和视频分享需要安全作用域或共享容器生命周期设计，不能通过传递临时文件路径绕过。
- 仍需真实 Developer ID、公证、正式 GitHub Release、`autoUpdater` 跨版本安装、Apple Silicon Gatekeeper、正式签名包系统通知/Spotlight/Share Extension、AppKit 原生 AX 与启用 VoiceOver 的完整人工验收。
