# Reader 0.48.0

本版本完成 AI 提供商预设与模型目录，在保留既有 Reader Gateway 的同时，加入 OpenAI、回环 Ollama 和自定义 OpenAI-compatible 服务。SQLite schema 继续保持 v11；文章、附件、迁移、备份和 Markdown 导入导出格式均与 0.47.0 兼容，旧 `settings.json` 会自动按 Reader Gateway 读取。

## 提供商与模型

- 设置窗口新增 Reader Gateway、OpenAI、Ollama（本机）和其他 OpenAI-compatible 服务四种明确预设。
- OpenAI 与 Ollama 地址分别锁定为官方 HTTPS 基础地址和 `127.0.0.1` 回环地址；自定义服务继续只允许 HTTPS 或回环 HTTP。
- OpenAI-compatible 服务使用 `/chat/completions` JSON 模式完成摘要、RAG 问答、翻译和多资料创作，结果继续经过既有字段、长度与引用白名单校验。
- 用户可以显式读取当前服务 `/models` 返回的模型目录，也可以手动填写模型 ID。目录请求不发送文章、标题、检索片段或其他资料库数据。
- 提供商、规范化端点和模型作为非敏感设置写入权限为 `0600` 的 `settings.json`；API 密钥仍不进入该文件、SQLite、备份、导出或任何设置响应。

## 凭据与网络边界

- Keychain 密钥只会在候选配置的提供商和规范化端点与已保存作用域完全一致时复用。
- 切换提供商或服务地址后，连接测试和模型目录不会携带旧密钥；若没有输入新密钥，保存新作用域时会删除旧 Keychain 项。
- OpenAI-compatible 基础地址拒绝查询字符串、用户信息、片段和疑似密钥参数；模型 ID 最长 200 个字符且只允许受控字符。
- 所有 AI 请求拒绝 HTTP 重定向，避免凭据作用域依赖 Fetch 对跨端点认证头的隐式处理。
- 模型目录与生成响应共用 60 秒超时和 2 MB 响应边界；目录最多保留 500 个合法、去重并排序的模型条目。
- 连接测试仍只发送 Reader 内置英文，不读取资料库；远程 RAG 仍只发送本地命中的最多 8 个有限片段，零命中不会调用远程服务。

## 最终包门禁

- 设置窗口 AX 门禁会在最终 Universal App 中实际切换到 Ollama，核对固定回环地址、模型输入和“读取模型”按钮，并重新拒绝无可访问名称的控件。
- 既有全部 14 个顶层模态框焦点闭环、Share 文本/文件/取消/URL 和 0.43.0 schema v11 冻结资料库升级门禁继续执行。

## 验证

- `npm test`：134/134 通过。
- `npm run build`：生产构建通过。
- `npm run audit:dependencies`：生产依赖不得存在已知漏洞；构建树只允许发行脚本中精确列出的已评估公告。
- OpenAI-compatible 测试覆盖模型目录、Chat Completions JSON 契约、连接测试、实际模型来源、正文边界和重定向拒绝。
- 设置测试覆盖旧配置兼容、固定预设地址、模型 ID、HTTPS/回环规则、Keychain 不落盘、服务切换清密钥，以及候选目录不得跨作用域复用凭据。

## Universal 包

- `release/Reader-0.48.0-universal.dmg`：253,836,108 bytes。
- SHA-256：`a58c94df2e1a3a4398d261fcef4c3f8a78858e3d6ce0ef3bcef1cf27f9d17a60`。
- 主程序、Spotlight Helper 与 Share Extension 均包含 x86_64/arm64，严格签名检查与 `hdiutil verify` 通过；当前仍为 ad-hoc 签名，因此不生成自动更新 ZIP。

## 已知边界

- `/models` 返回的是服务账号可见目录；通用响应不提供可靠的文本能力标记，Reader 不把目录出现等同于模型必然支持 Chat Completions，用户仍应执行隐私连接测试。
- OpenAI-compatible 适配器选择 Chat Completions 是为了覆盖 OpenAI 与 Ollama 的共同接口；Reader Gateway 继续适用于自定义服务端编排。
- 当前仍缺真实 Developer ID、公证、正式 GitHub Release、`autoUpdater` 跨版本安装及 Apple Silicon Gatekeeper/升级真机验收。
