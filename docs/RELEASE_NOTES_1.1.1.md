# Reader 1.1.1 正式版

Reader 1.1.1（build 111，SQLite schema v13）是 1.1.0 抖音高质量导入的正式可靠性收口版本。平台能力边界不扩张；重点是让无平台字幕的作品能够真正完成本地 Whisper、持续显示进度，并用可复现的公开视频和图文素材阻断回归。本项目的正式版本允许使用 ad-hoc、未公证 DMG 分发；Apple 签名等级与 Reader 发行级别分别记录。

## 主要变化

- Transcription Helper 使用 version 1 有界 NDJSON 事件流，先输出单调进度，再输出唯一结果；主进程逐行校验版本、事件、范围、总字节数和重复结果。
- Helper 进度去重映射到导入任务的 78–93%，索引阶段为 94%；队列不再在长时间推理期间保持静止。
- 空分段不再生成空 Markdown 或 WebVTT，而是保留离线媒体和 `waiting-transcription` 状态，允许只重试转写或由用户明确跳过。
- whisper.cpp 固定使用 CPU/Accelerate 后端，避开 Intel/AMD Metal 可能触发的进程级断言；模型来源、revision、487,601,967 bytes 与 SHA-256 均保持固定。
- 增加可复现的真实 QA：公开 05:44 视频、离线 Range、公开 10 图与独立 M4A 背景音乐，以及固定模型的本地转写、WebVTT、全文搜索和 RAG 分块。
- README、平台矩阵、导入 SOP、路线图、架构和安全说明统一到 1.1.1（111）/schema v13；微信、CSDN、掘金、知乎等平台状态不变。

## 已验证结果

- 公开视频 `7644608213127646518`：作者、发布时间、344,026 ms、720p 带声 MP4、14,231,458 bytes、HTTP Range 206 与平台章节索引通过。
- 公开图文 `7601918621245662073`：10 张 WebP、独立 `audio/mp4` 背景音乐 473,529 bytes，离线状态 `complete`。
- 同一公开视频强制本地 Whisper：固定模型校验通过；CPU/Accelerate 推理约 95 秒，产生 108 个非空时间戳分段和 9,556 bytes WebVTT；Markdown、全文搜索与本地 RAG 分块均命中。
- 依赖审计：生产依赖 0 个已知漏洞；构建树仅保留发行脚本精确放行的既有 Electron 打包公告。

最终自动测试数量、生产构建、Universal DMG、清单哈希和打包门禁记录在 [HANDOFF_1.1.1.md](HANDOFF_1.1.1.md)。

## 发行边界

- 本版本不新增微信、CSDN、掘金、知乎或小红书解析能力，平台承诺以 [PLATFORM_SUPPORT.md](PLATFORM_SUPPORT.md) 为准。
- Apple Silicon 真机由产品决策移出本版门禁；arm64 只做官方依赖哈希、Mach-O Universal 架构和签名结构检查，不描述为真机运行验收。
- 当前机器没有有效 Developer ID Application 身份和公证 Keychain profile，因此本正式版以 ad-hoc、未公证 Universal DMG 分发，不生成可执行自动更新 ZIP，也不宣称经过 Apple 公证。
