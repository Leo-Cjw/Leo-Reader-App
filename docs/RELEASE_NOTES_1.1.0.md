# Reader 1.1.0 Candidate

Reader 1.1.0（build 110，SQLite schema v13）聚焦抖音作品的高质量离线导入与通用音频能力。用户可以在桌面版粘贴抖音链接或分享口令，任务会规范为稳定作品 ID，通过隔离 Chromium 会话读取作品详情，并把可播放媒体、完整图文信息和可全文搜索的转写保存在本机。

## 主要变化

- 新增抖音视频、最多 30 图、图文背景音乐、作品元数据和重复短链去重。
- 视频优先选择不超过 100 MB 的 1080p H.264 MP4，候选不可用时降至 720p；所有视频失败或所有图片失败时不创建空壳文章。
- 新增 `persist:reader-douyin` 隔离会话。匿名访问优先，登录必须由用户点击并在可见窗口完成；不读取密码、不逆向签名、不自动处理验证码。
- 新增可恢复导入阶段、`awaiting_user`、进度、警告和明确操作；支持继续、跳过转写和取消。
- 新增 MP3、M4A、AAC、WAV 上传、播放、筛选、导出、备份与恢复。
- 新增本地 Whisper small 多语言模型管理和 Universal `Reader Transcription Helper`。模型只在用户点击后从固定版本下载并校验 SHA-256，不进入应用包、备份或导出；固定官方 whisper.cpp v1.9.1 XCFramework 要求 macOS 13.3+。
- 转写写回 Markdown、生成 WebVTT，并重建分块、全文索引和已启用的语义索引。
- Share Extension 中包含抖音链接的短文本进入 URL 导入确认页；其他文本仍作为 Markdown，确认前保持零写入。

平台边界以 [PLATFORM_SUPPORT.md](PLATFORM_SUPPORT.md) 为准。

## 数据与兼容性

- SQLite 从 schema v12 迁移到 v13；迁移前继续创建 `0600` 数据库快照。
- `settings.json` 继续为 version 1，新字段使用兼容默认值。
- Reader Markdown ZIP 继续为 v3；完整备份格式不变。
- 模型、抖音 Cookie、签名 URL、私有磁盘路径和临时文件不进入任务公开对象、诊断、备份或导出。

## Candidate 边界

用户提供的公开作品已在 Intel 主机上通过最终 Universal App 回归：分享口令规范到稳定作品 ID，保存 05:44 的 720p 带声 MP4，Range 离线播放可用，平台章节进入 Markdown 和全文索引。当前仍只能称为 ad-hoc Candidate；Developer ID 签名、公证、正式 GitHub Release、Apple Silicon 真机、真实登录/验证码/无章节本地模型转写和跨机器 Gatekeeper 验收仍是正式公开发行条件。
