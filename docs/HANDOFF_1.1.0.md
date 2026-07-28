# Reader 1.1.0 开发交接

> 本文档属于 1.1.0 独立交接，不修改历史 `HANDOFF_1.0.1.md`。完成日期、最终提交、测试总数、构建物哈希和真实平台回归只记录已实际验证的结果。

## 版本身份

- 营销版本：1.1.0
- build：110
- SQLite schema：v13
- settings：v1
- Reader Markdown ZIP：v3
- 分支：`codex/1.1.0-douyin-import`
- 1.0.1 基线：`e4b7cf137a06bb576330a1569e31cea952b2719c`
- 1.1.0 实现提交：`a737a20c5ece402105c2ac7cf6e5b8687fee8aea`
- 完成日期：2026-07-28

## 已实现范围

- 抖音分享口令/链接规范化、独立桌面适配器、隔离会话和显式登录。
- 视频/图片/背景音乐安全下载、通用音频附件与播放器。
- 可恢复任务阶段、等待用户、继续/跳过转写/取消。
- 固定供应链的 Whisper small 模型管理、AVFoundation + whisper.cpp Helper 接口、Markdown/WebVTT 转写与索引更新。
- 主应用仍支持 macOS 12；固定官方 whisper.cpp v1.9.1 XCFramework 的本地转写边界为 macOS 13.3+，旧系统不会下载模型或启动 Helper。
- 平台矩阵、平台导入 SOP、架构、安全、路线图、发行说明和一致性门禁。

## 验证记录

- 1.0.1 基线：169/169 自动测试通过；生产构建通过。
- 1.1.0 自动测试：181/181 通过；TypeScript/Vite 生产构建通过。
- schema v11（冻结 0.43）→ v13：最终打包 App 直接升级、继续写入、重启、SQLite 完整性和附件 SHA-256 门禁通过。
- Universal 架构：主 App、Share Extension、Spotlight helper、Transcription helper 与嵌套 `whisper.framework` 均验证 `arm64,x86_64`；四个 bundle 均回读为 `1.1.0 (110)`。
- 签名：ad-hoc 深度严格验证通过；Transcription helper 与 `whisper.framework` 单独严格验证通过。
- 最终包门禁：loopback/DNS rebinding/跨源拒绝、14 个模态框 Chromium AX、Share 文本/文件/URL 零预写入与清理、升级门禁全部通过。
- DMG：`release/Reader-1.1.0-universal.dmg`，257,931,915 bytes，SHA-256 `884c58787cb0e5ef042f25fdd7a971b2fd67007806719219995224e3f4d8f3eb`；`hdiutil verify` 通过。
- 发行清单：`release/Reader-1.1.0-release.json`，声明 version 1.1.0、build 110、schema v13、Electron 41.7.1、Universal、ad-hoc、源码提交 `a737a20c5ece402105c2ac7cf6e5b8687fee8aea` 且 `trackedChanges: false`。
- 依赖审计：未执行。当前策略不允许把私有仓库的依赖元数据发送给 npm audit 服务；没有把这一项记为通过，也没有绕过策略。

## 真实抖音回归

用户提供的分享口令已在最终 Universal App、隔离临时资料库和 Intel 真机上完成回归：

- 规范作品：`7644608213127646518` / `https://www.douyin.com/video/7644608213127646518`。
- 作者：`Kiven大汉堡`。
- 发布时间：`2026-05-27T16:24:27.000Z`，即北京时间 2026-05-28 00:24:27。
- 时长：344,026 ms（05:44）；实际画质：720p。
- 离线视频：带声 H.264 MP4，14,231,458 bytes；本地附件 Range 请求返回 206。
- 转写来源：`platform-chapters`；页面公开章节写入 Markdown，搜索“笔记系统”能命中文章，任务终态为 `completed`。
- 详情来源：隔离 Chromium 实际请求由同一 Session 回读，页面公开章节从同一渲染文档补采；Cookie、详情签名和媒体 URL 未进入公开任务、输出或资料库。

本样例已有平台章节，因此按既定优先级没有下载或运行 Whisper 模型。无平台章节作品的真实本地模型转写仍需用户明确安装约 466 MiB 模型后验收；自动测试只验证了固定供应链、SHA-256、Helper 输入输出、失败清理与索引写入。

30 图长图文、背景音乐、登录失效、私密/删除、验证码、过期签名和 1080p→720p 回退有自动化覆盖或明确错误边界，但没有全部取得真实平台样本，不记录为真实平台通过。

## 未完成的正式发行条件

- Developer ID Application 签名与 Apple 公证。
- 正式 GitHub Release 和自动更新资产。
- Apple Silicon 真机上的 Gatekeeper、登录、离线播放、音频、Share Extension、Spotlight、升级和转写验收；Intel 已完成本轮自动化与公开作品回归，但仍未替代正式签名系统集成验收。
- 真实验证码、私密/删除/地区限制、过期签名和 1080p → 720p 回退样本。

这些条件未全部满足时，所有文档和构建物只能称为 ad-hoc Candidate。
