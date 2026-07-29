# Reader 1.1.1 开发交接

> 本文档属于 1.1.1 独立交接。历史 `HANDOFF_1.0.1.md` 与 `HANDOFF_1.1.0.md` 不改写；这里只记录 2026-07-29 实际执行并取得证据的结果。

## 版本与源码

- 营销版本：1.1.1
- 构建号：111
- SQLite schema：v13
- settings：v1
- Reader Markdown ZIP：v3
- 分支：`codex/1.1.1-1.1.0-completion`
- 实现与发行源码提交：`2e944fa8f6ba683a398822bd5e40775820307716`
- 发行清单确认 `trackedChanges: false`；用户的 `.agents/`、旧交接和 logo 草案未加入提交或构建输入。

## 本版完成内容

- Transcription Helper 从单次 JSON 改为有界 NDJSON 事件流，实时报告单调进度并只允许一个最终结果；主进程验证版本、事件类型、范围、总输出和重复结果。
- Helper 进度去重映射到导入任务 78–93%，索引阶段推进到 94%。空分段失败关闭，不写空 Markdown/WebVTT，已下载媒体保持可重试。
- 固定 whisper.cpp v1.9.1 采用 CPU/Accelerate 推理。真实回归曾在 Intel/AMD Metal 约 50% 触发底层断言，CPU 路径修复后连续完成源码 helper 与最终包内嵌 helper 的实际推理。
- 新增可复现 QA 命令：
  - `npm run qa:douyin`
  - `npm run qa:douyin:note`
  - `npm run qa:transcription`
- README、平台矩阵、导入 SOP、路线图、架构、安全与发行说明统一为 1.1.1（111）/schema v13。平台能力边界不扩张。

## 自动测试、构建与依赖

- `npm test`：189/189 通过。
- `npm run build`：TypeScript 与 Vite 生产构建通过。
- `npm run audit:dependencies`：生产依赖 0 个已知漏洞；构建依赖只保留脚本精确允许的 `GHSA-mh99-v99m-4gvg`，直接受影响工具为 `@electron/universal` 与 `electron-builder`。
- `npm run desktop:pack`：在 Intel 主机完成。由于当前完整 Xcode 尚未接受 license，使用 `SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk` 选择兼容 SDK；这不改变产物最低系统版本或签名等级。
- 计划项精确回归：
  - 两条不同短链规范为同一作品 ID，只捕获和保存一次；
  - 31 图详情只保存前 30 图，独立背景音乐保存为音频附件；
  - 单图与背景音乐失败允许完成，但明确记录缺失数量和“部分离线”；
  - 登录/验证码要求进入 `awaiting_user / waiting_login`，私密/删除/不可用进入失败，均不创建空壳文章；
  - schema v12→v13 单独迁移通过，旧任务 payload 与 pending 状态保留，并产生 v12 安全快照。

## Universal Candidate

- 主 App、Share Extension、Spotlight helper、Transcription helper 与嵌套 `whisper.framework` 均为 `arm64,x86_64`。
- 主 App、Share Extension、Spotlight helper 与 Transcription helper 全部回读为 `1.1.1 (111)`。
- ad-hoc 签名结构及 designated requirement 验证通过。
- 最终包门禁通过：
  - 精确随机 loopback Host、DNS rebinding、跨 Origin/跨站请求与零拒绝写入；
  - Chromium AX 树、14 个顶层模态框、316 个公开节点、0 个未命名交互控件；
  - Share 文本/文件/URL 第二实例交接、确认前零资料库写入、确认/取消暂存清理；
  - 冻结 Reader 0.43.0 schema v11 → Reader 1.1.1 schema v13，文章、资料夹、标签、高亮、版本、智能资料夹、待处理任务、设置和附件保持，升级后继续写入、重启与 SQLite integrity 通过。

Apple Silicon 真机由产品决策移出本版门禁。arm64 结果只代表固定依赖哈希、Universal Mach-O 和签名结构验证，不代表真机启动或交互验收。

## 真实抖音回归

最终 `release/mac-universal/Reader.app` 已实际执行：

- 公开视频 `7644608213127646518`：
  - 作者 `Kiven大汉堡`，发布时间已保存；
  - 时长 344,026 ms；
  - 720p 带声 MP4，14,231,458 bytes；
  - 本地附件 Range 返回 206；
  - 平台章节进入 Markdown 与全文索引。
- 公开图文 `7601918621245662073`：
  - 10 张 WebP 全部离线；
  - 独立 `audio/mp4` 背景音乐 473,529 bytes；
  - `backgroundMusicSaved: true`，离线状态 `complete`。
- 最终包内嵌 Transcription helper：
  - 使用固定并已校验的 487,601,967 bytes Whisper small；
  - 对最终包下载的 05:44 MP4 完成 CPU/Accelerate 推理；
  - 产生 107 个非空时间戳分段、9,512 bytes WebVTT，耗时约 177 秒；
  - 进度 78→93 单调更新，索引阶段 94；
  - Markdown、全文搜索词“还需要”和本地 RAG 分块均命中。

真实 QA 目录位于 `/tmp` 的隔离路径，不属于用户 Reader 资料库，不进入仓库、备份或发行包。

## 构建物

- App：`release/mac-universal/Reader.app`
- DMG：`release/Reader-1.1.1-universal.dmg`
  - 字节数：258,919,278
  - SHA-256：`a3a8ed8bd86f4efe1059e9fc0210b0d0a9cf3eb09d0994c39cbd67eea2926ee8`
  - `hdiutil verify`：通过
- Sidecar：`release/Reader-1.1.1-universal.dmg.sha256`
- 发行清单：`release/Reader-1.1.1-release.json`
  - version 1.1.1、build 111、schema v13、Electron 41.7.1、Universal、ad-hoc；
  - 源码提交 `2e944fa8f6ba683a398822bd5e40775820307716`；
  - `trackedChanges: false`；
  - DMG 字节数与 SHA-256 复验一致。

## 外部发行条件

本机 `security find-identity -v -p codesigning` 返回 0 个有效身份，且没有可用的公证 Keychain profile。因此流水线按设计：

- 不生成 `Reader-1.1.1-darwin-universal.zip`；
- 不配置或联系自动更新服务；
- 不执行 App/DMG 公证与 stapling；
- 只生成 ad-hoc Candidate。

要成为正式公开发行，仍需由外部提供 Developer ID Application 身份和公证 profile，然后从干净提交重跑 `npm run desktop:pack`，确认清单为 `signature: developer-id-notarized`、同时包含 DMG 与 universal 更新 ZIP，再完成一次真实跨版本 `autoUpdater` 下载、用户确认和重启安装。没有这些凭据时不得把本候选称为已公证正式版本。
