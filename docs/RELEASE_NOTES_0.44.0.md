# Reader 0.44.0

本版本把“新包能无损打开旧资料库”从人工经验变成每次 macOS 发行的阻断门禁。SQLite schema 保持 v11；文章、附件、设置、备份和 Markdown 导入导出格式均与 0.43.0 兼容。

## 冻结的 0.43 基准

- 使用 0.43.0 Universal 最终候选 App 和产品 HTTP API 创建合成资料库，记录来源提交、schema 与全部预期关系；不是通过测试代码直接拼装数据库。
- 代表数据覆盖已编辑 Markdown 文章、收藏/已读/阅读进度、父子资料夹、两个标签、高亮与批注、两版历史、动态智能资料夹、用户暂停的 pending URL 导入任务、通知偏好和 PNG 原始附件。
- 仓库只保留 303,104-byte SQLite、419-byte 无凭据设置和 68-byte 合成附件。manifest 固定每个文件的大小和 SHA-256；自动测试同时检查迁移历史、SQLite 完整性、外键和关键记录。

## 最终包升级门禁

- Universal App 合并、签名并通过既有可访问性门禁后，流水线把冻结基准复制到独立临时 Reader 根目录，由当前候选 App 直接打开。
- 第一次启动必须逐项读回文章、资料夹、标签、高亮锚点、批注、版本详情、智能资料夹计数、暂停任务、通知设置和附件 API 字节，并通过资料库健康检查。
- 候选随后增加一个标签、更新阅读进度并完全退出；第二次启动必须同时保留 0.43 原始数据和 0.44 新写入。
- App 退出后额外执行 SQLite `integrity_check`、`foreign_key_check` 和附件 SHA-256 复核。任何字段、关系、状态或字节变化都会阻止 DMG 生成。
- 可访问性与升级门禁复用同一个随机回环 CDP 启动器；始终使用独立 Chromium profile、跳过协议注册并清理临时数据，不会打开或修改用户资料库。

## 验证

- `npm test`：125/125 通过；`npm run build`：生产构建通过；`npm run audit:dependencies`：生产依赖 0 个已知漏洞。
- 最终 0.44 Universal 候选实测从 0.43.0 schema v11 基准完成读取、写入、退出、重启与完整性闭环；附件 SHA-256 保持不变。
- 最终候选继续暴露 318 个 AX 节点，八个核心模态框闭环全部通过，无无名交互控件。
- 主程序、Spotlight Helper 与 Share Extension 均包含 x86_64/arm64，App 深度严格签名和 `hdiutil verify` 通过。

## Universal 包

- `release/Reader-0.44.0-universal.dmg`：253,616,677 bytes。
- SHA-256：`e342ed284c0e2cc1be123ea6eb244a035e8239d3520939b5b76aed30a00cf706`。
- 当前仍为 ad-hoc 签名，不生成自动更新 ZIP。

## 已知边界

- 当前门禁证明 0.44 最终 App 直接打开 0.43 资料库并继续工作，不等同于 Developer ID 签名、公证、GitHub Release 和 `autoUpdater` 下载/替换/重启的端到端升级。
- 当前 schema 与 0.43 同为 v11；未来增加 schema 时仍必须使用冻结旧包基准验证真实迁移。
- 仍需 Apple Silicon 真机 Gatekeeper、正式签名包系统通知/Spotlight/Share Extension、AppKit 原生 AX 与启用 VoiceOver 的完整人工验收。
