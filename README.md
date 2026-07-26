# Reader for Mac 0.62.0

Reader 是一款 local-first 阅读资料库。文章、目录、标签、收藏、阅读进度、RSS 源和 AI 结果都写入本机 SQLite；界面通过本机 HTTP API 访问这些数据，不依赖云端账号。

当前版本是可运行的 Mac App，而不是静态原型：它包含持久化数据库、可从系统分享菜单接收网页、短文本摘录或单个受支持文件的沙箱化 Share Extension、默认关闭且可彻底删除的 macOS Spotlight 本机索引、安全的 `reader-local://` 外部保存入口、按文章去重的专注阅读窗口、渲染界面崩溃恢复、可选的隐私安全导入与订阅通知、正文选区高亮与批注、树形资料夹、拖拽整理、规则驱动的智能资料夹、批量整理、归档、附件/PDF、全文搜索、Readability 正文抽取、正文图片本地化、媒体缩略图、RSS/YouTube/X/微博后台订阅、OPML、支持本地图片与自动保存的双栏 Markdown 编辑器、文章版本历史、可往返的选择性 Markdown ZIP 导入导出、可逆重复治理、口令加密完整备份、默认关闭的每日本机自动恢复点、资料库健康检查、可查看和清除的隐私安全本地日志，以及带运行时设置、Keychain 凭据、本地分块索引、可选 Ollama 向量混排和段落级引用的 AI 工作台。

## 快速开始

### Mac App

打开 `Reader-0.62.0-universal.dmg`，把其中的 `Reader.app` 拖到“应用程序”即可安装。通用产物同时适用于 Apple Silicon 与 Intel Mac，最低 macOS 12。本地交付仍使用 ad-hoc 签名且不会连接自动更新服务；跨机器分发时 Gatekeeper 可能要求在“系统设置 → 隐私与安全性”中确认打开。

Mac App 的资料库独立位于：

`~/Library/Application Support/Reader/ReaderData/data/`

升级或替换 `Reader.app` 不会覆盖这份资料。应用只监听随机的 `127.0.0.1` 端口；窗口启用 Chromium 沙箱、上下文隔离和严格 CSP，拒绝所有网页权限，外部链接交给系统浏览器。

### 源码运行

依赖：Node.js 20+、系统 `sqlite3` 命令。macOS 已自带 SQLite。

```bash
npm install
npm test
npm run build
npm start
```

然后访问 [http://127.0.0.1:4312](http://127.0.0.1:4312)。默认只监听回环地址，不暴露到局域网。首次启动会创建 `data/reader.sqlite3` 并写入三条示例内容。

开发模式需要两个终端：

```bash
npm run server
npm run dev
```

Vite 开发界面位于 `http://127.0.0.1:4311`，并把 `/api` 代理到 4312 端口。

### 构建 Mac 发行包

```bash
npm run desktop:pack
```

该命令固定使用当前 Electron 版本，分别获取并核对官方 SHA-256 的 x64/arm64 包，构建两套 App，合并通用 Mach-O，检查 Canvas 原生模块、嵌套 Spotlight helper 与 Share Extension 架构和 entitlement，并执行签名验证。最终 App 必须依次通过完整 Chromium AX 树与全部 14 个顶层模态框焦点闭环、第二实例驱动的 Share 文本/文件/URL 交接、文件确认/取消清理与资料库确认前零写入门禁，以及从 0.43 冻结资料库读取、继续写入、重启和完整性复核，才会生成并校验 DMG。输出位于 `release/mac-universal/Reader.app`、`release/Reader-<version>-universal.dmg`、同名 `.sha256` sidecar 与 `release/Reader-<version>-release.json`。机器可读清单记录版本、构建号、schema、Electron、签名等级、源码提交、是否包含已跟踪改动及产物字节数/SHA-256，不包含本机路径、用户名、证书名或凭据。未提供正式发行凭据时保留 ad-hoc 模式，并主动删除同版本残留的更新 ZIP。

在产物目录可独立复验 DMG：

```bash
cd release
shasum -a 256 -c Reader-<version>-universal.dmg.sha256
```

流水线已预留正式发行入口。先用 `xcrun notarytool store-credentials` 把公证凭据写入 Keychain，再提供证书名称和凭据配置名：

```bash
READER_MAC_SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
READER_NOTARY_KEYCHAIN_PROFILE="reader-notary" \
npm run desktop:pack
```

此模式使用 hardened runtime 逐项签名通用 App，先公证并验证 App，再生成 `Reader-<version>-darwin-universal.zip` 和 DMG，最后公证并验证 DMG。更新 ZIP 只会从已通过 Developer ID、App 公证票据和解压后签名复检的 App 生成；正式清单要求源码无已跟踪改动，同时记录并复验 DMG、更新 ZIP 及两份 sidecar。凭据不写入项目、命令参数或产物，`READER_NOTARY_KEYCHAIN` 可选指定非默认 Keychain。发布更新时需在公开 GitHub 仓库创建语义版本 Release，并同时上传该 universal ZIP。当前本地交付因没有 Developer ID 证书与公证配置，仍是 ad-hoc/未公证版本。

正式签名版本在 Reader 菜单提供“检查更新…”，启动一分钟后及此后每六小时自动检查公开 Release。发现更新后由 Electron 下载，只有用户确认“重启并安装”才会安全停止后台任务并安装。运行时会重新检查当前 App 的 Developer ID authority 与 Team Identifier；源码、开发、ad-hoc 或签名异常的包不会设置更新地址，也不会联系更新服务。

## 已实现能力

- URL 导入：先写入持久化任务队列，再在一次性权限受限解析进程中用 Mozilla Readability 抽取标题、作者、摘要和正文，转换为 GFM Markdown；代表图片和最多 16 张正文图片通过安全下载、文件签名检查与哈希去重后保存在本机。
- 外部保存入口：打包 App 接受互斥的网页 URL、最多 4 KiB Base64URL 文本或 Share Extension 生成的随机文件 token。浏览器、快捷指令或系统扩展唤起 Reader 时，主进程与 preload 都会重新检查动作、唯一参数、长度和内容边界；文件深链不携带真实路径、文件名、MIME、摘要或内容。冷启动和运行中第二次唤起均受支持，用户确认前不会创建任务、联网或写入资料库。
- 系统分享扩展：安装后可从 Safari、Finder 及其他提供网页 URL、选中文本、PDF、图片、视频、Markdown 或纯文本文件的 Mac App 选择“存入 Reader”。独立 Universal `.appex` 仍只有 App Sandbox entitlement，不联网、不访问资料库、Keychain、App Group 或用户任意路径；文件先复制到扩展私有缓存，以 0700/0600 权限、随机 token、100 MB 上限、SHA-256 和 24 小时 TTL 暂存，再由 Reader 显示名称与大小并要求选择资料夹确认。确认后复用既有附件队列，取消或成功后立即清理；失败时保留到重试或过期。若系统分享菜单未显示，可在分享菜单的“编辑扩展”中启用“存入 Reader”。
- 网络采集：每次请求和重定向都拒绝本机、局域网及云元数据地址；实际 TCP 连接固定到已验证的公网 IP，同时保留原域名进行 Host/TLS 校验，避免 DNS rebinding 绕过。
- 微信公众号：使用专用解析器识别账号、作者、标题、正文与延迟加载图片；微信验证页不会入库。旧版本误存的验证页会自动恢复原链接，重新导入时保留历史版本并原地修复。
- 离线完整度：阅读页明确显示离线完整、部分离线或仅正文离线；下载失败的图片降级为可点击在线链接，不会在阅读时静默发起远程图片请求。
- 附件：支持 PDF、图片、视频、Markdown 和文本；单文件最大 100 MB，使用 SHA-256 幂等入库。
- PDF：在一次性解析进程中使用本地 PDF.js 抽取文字并加入全文索引，原文件保留在本机。
- 媒体缩略图：图片和 PDF 首次展示时在权限受限解析进程中生成 640×360 WebP 缓存并按内容哈希复用；视频由本地媒体端点解码首帧。缩略图可随时重建，不进入备份。
- Markdown：任意文章都能进入双栏编辑器；可选择或拖入多张图片，图片经过签名校验、SHA-256 去重后挂在原文章并插入光标处。停笔 1.4 秒自动保存，实时预览不执行原始 HTML。
- 版本历史：内容字段发生变化时自动生成本地快照；可预览并恢复任意旧版本，恢复本身也会生成新版本，因此可逆。
- 高亮与批注：鼠标可直接选中任意文字；纯键盘可开启只读选取模式，用方向键移动、Shift+方向键选择、Option+方向键逐词移动，并按 Enter 创建高亮。四种颜色、原文锚点和批注写入 SQLite，刷新后自动重建正文着色；正文编辑后会按原文与最近位置重新定位。高亮进入完整备份，也会附在可迁移 Markdown 导出末尾及 manifest 中。
- 导入队列：等待、运行、完成、失败和重试状态全部落库；队列窗口可手动暂停或继续，暂停偏好保存在本机且重启后保持。手动继续只解除用户暂停，不会绕过资料恢复、睡眠或系统资源限制。
- 后台导入通知：Mac App 设置中可明确开启，默认关闭。只有 Reader 不在前台时才按 worker 批次显示成功/失败数量；通知不包含文章标题、正文、URL、文件名、错误文本、路径、任务 ID 或资料夹，点击后聚焦 Reader 并打开导入队列。
- 后台订阅通知：使用独立且默认关闭的开关；只有自动调度批次新增内容或出现失败且所有 Reader 窗口都不在前台时显示聚合数量。手动“立即同步”不会通知；点击后聚焦 Reader 并打开内容来源。
- Spotlight 搜索：Mac App 设置中可明确开启，默认关闭。开启后标题、摘要、作者、来源、标签和最多 20,000 字正文进入仅限本机、首次解锁后可用的受保护系统索引；文章编辑、标签、归档和删除通过持久化队列增量同步。系统结果点击后只允许打开一个已存在的本地文章 ID；关闭会先删除 Reader 的 Spotlight domain，再清理待处理队列。
- 界面故障恢复：Electron 渲染进程异常退出时，Reader 会用原生窗口说明已写入资料仍安全，并让用户选择重新载入界面或安全退出。重新载入不重启本地服务和导入队列，崩溃期间到达的合格外部 URL 会等待新界面就绪后再交付。
- 自动订阅：RSS/Atom、YouTube、X 公开账号和微博账号统一入库；X 使用官方 API 与 `since_id` 增量游标，微博调用开放平台官方 CLI。后台调度保存平台游标、配额和失败退避状态，并在 Mac 睡眠、离线、电量不高于 20% 或系统严重受限时安全暂停；可选语义索引同样服从睡眠、低电量、热限制和资料恢复锁。
- 订阅中心：开关、15 分钟到每周的同步频率、立即同步、错误/限流状态、删除来源，以及 OPML 2.0 导入导出。删除来源或断开连接器不会删除已经保存的文章。
- 资料管理：可创建、改名、嵌套和安全删除的树形资料夹；父资料夹可聚合子树内容。支持单篇和批量移动、添加/移除标签、收藏、已读、归档与恢复。
- 智能整理：可以把关键词、内容类型、标签、来源、原资料夹、阅读/收藏状态、高亮、附件和保存时间组合成“全部满足”或“任一满足”的动态资料夹；规则、结果计数和自定义顺序都保存在本地。文章卡片可直接拖到普通资料夹，同级资料夹与智能资料夹可拖动排序。
- 资料视图：网页、订阅、附件、笔记与媒体筛选；列表和双列画廊可切换，画廊直接使用本地图片、PDF 缩略图和视频首帧。列表使用稳定游标分页，明确显示已加载数和命中总数，不会在 100 条后静默截断；列表响应不携带正文，选中后才读取单篇详情，长文章不会放大整页传输。
- 键盘与读屏基础：文章卡片使用同级原生“打开”和“选择”按钮，并播报未读/收藏、来源、日期、类型、资料夹、标签和有限摘要；导航当前项、筛选、功能切换与批量选择均公开当前/按下状态。产品导航、内容区、阅读器和文章助手提供可区分的 landmark 名称，正文异步切换通过 persistent live status 播报且不会短暂暴露上一文章；macOS“减少动态效果”会停用界面动画和平滑滚动。全部 14 个顶层模态框管理初始焦点、Tab 回环、Escape 和关闭后恢复；复杂命名窗口先聚焦标题，打开期间主窗口及较低层窗口成为不可交互的 inert 子树，程序化菜单焦点也不能逃出当前窗口。发行流水线会从最终 App 直接核对主工作区及全部 14 个顶层模态框的 AX 树与焦点闭环，包括跨窗口进入社交连接器和本地日志。侧栏资料夹支持完整树键盘；Markdown 编辑器支持初始焦点、⌘S、可播报保存状态和可见上传焦点；附件、编辑器图片、Reader ZIP、OPML 与备份恢复均以可见键盘按钮打开系统文件选择器；静态正文具备不开放编辑面的原生 Range 键盘选区，光标、选区、颜色、定位与批注保存均提供焦点或 live status 反馈，并避让 VoiceOver 的 Control+Option 导航组合键。
- 选择性导出：多选任意内容，生成标准 Markdown ZIP；可选携带原始附件，正文中的本地资源改写为相对路径，manifest 保留来源、标签和附件 SHA-256。v3 包同时包含 Reader 专用 sidecar，使正文、摘要、阅读状态和扩展元数据可以无损往返而不影响 Markdown 的独立使用。
- 选择性导入：在“添加 → Reader ZIP”中先安全预检，再逐篇勾选并指定目标资料夹；已有 Reader ID 或原链接默认跳过，不隐式覆盖。支持 v3 无损包和既有 v2 Markdown 包的兼容恢复。
- 重复治理：按规范化原链接、完整正文或标题摘要检测重复组；用户明确选择保留版本后合并标签、收藏、摘要与阅读进度，副本仅归档且可恢复。
- 检索：拉丁文字使用 SQLite FTS5 词法索引；三个及以上字符的中文词组使用 FTS5 trigram 子串索引，短词保留兼容路径。
- 阅读器：三栏桌面布局、明暗主题、文章助手和键盘入口；Mac App 可把当前文章放入按 ID 去重的独立专注窗口，窗口复用正文、附件和高亮定位，但不写收藏、整理、阅读进度或批注，返回资料库后再继续编辑。
- AI：默认完全本地的提取式摘要、多资料结构化整理与 RAG 问答；可在当前文章或整个资料库中检索，回答附带可点击的原文片段。文章新增、编辑、导入完成和版本恢复会在同一事务中重建分块索引。用户还可明确启用固定回环 Ollama `/api/embed` 的本地语义索引；模型测试使用 9 句内置中英/跨语言探针报告语义分离度，查询以每 band 三个低置信位候选桶扩大近邻召回，再用精确余弦和全文结果混排。索引失败会退回词法检索，关闭后删除全部派生向量。远程生成可选择既有 Reader Gateway、OpenAI、回环 Ollama 或其他 OpenAI-compatible 服务，从服务读取受限模型目录或手填模型 ID；只有用户主动执行任务时才发送既有边界内的内容，密钥存入 macOS Keychain。
- 安全：无账号本地 API 固定只监听 `127.0.0.1`，要求精确随机端口 Host，拒绝跨站 Origin/Fetch Metadata，并用统一响应策略禁止跨源嵌入、资源复用、Referrer 与设备权限；网络导入阻止 localhost、私网 IP 与云元数据地址，限制跳转、超时和 4 MB 正文响应体。
- 媒体读取：同源私有文件端点，支持 HTTP Range，可流畅拖动本地视频。
- 数据安全：一键生成包含 SQLite、附件和 SHA-256 清单的完整备份；默认可使用口令创建 `.readerbackup.enc` 认证加密文件，也兼容明文 `.readerbackup.zip`。Reader 只有在重新流式读取归档、核对数据库/manifest/全部附件哈希，并对加密输出完成 GCM 认证回读后才报告创建成功；恢复前仍会独立执行完整校验，并在下次启动时原子替换。
- 自动恢复点：默认关闭；明确开启后每 24 小时最多创建一份本机明文完整备份，并只轮转 Reader 严格标记的最近 3 份自动恢复点。手动、加密、修复前和恢复前备份永不被这项轮转删除；任务服从导入占用、睡眠、低电量、系统资源限制和资料恢复锁。
- 资料库体检：在数据安全中心检查 SQLite 页结构、外键、迁移审计、本机文件权限、附件可用性和本地检索索引；结果只返回汇总，不包含正文、附件名、记录 ID 或磁盘路径。
- 受控修复：只有在核心完整性、关联、迁移与附件检查均通过时，才能收紧本地权限或从正文重建全文/RAG 索引。索引写入前自动创建完整备份；正文、状态和附件不会被修复流程改写。
- 本地运行日志：从数据安全中心查看启动、备份、恢复、受控修复、渲染界面退出原因和意外本地服务错误；只保存字段白名单内的事件代码与状态，不保存正文、标题、URL、文件名、路径、记录 ID、错误原文或凭据。日志可导出、可彻底清除、最多保留约 1.5 MB，且不会自动上传。

## 数据与备份

- Mac App 数据根目录：`~/Library/Application Support/Reader/ReaderData/`
- 源码模式数据根目录：项目目录
- 主数据库：`data/reader.sqlite3`
- 原始附件：`data/files/`
- 导入暂存：`data/imports/`
- 系统分享文件暂存：`~/Library/Containers/com.reader.localfirst.share-extension/Data/Library/Caches/ReaderShareStaging/`（目录 `0700`、文件 `0600`；取消/成功即清理，最长保留 24 小时，不进入资料库或备份）
- Markdown ZIP 预检暂存：`data/portable-imports/`（24 小时自动过期）
- 完整备份：`data/backups/`（0.52 起新建备份带权限为 `0600` 的本机创建时验证凭据；凭据不进入备份包）
- 升级前数据库快照：`data/migration-backups/`
- 可再生缩略图：`data/thumbnails/`
- 待恢复暂存：`data/restore/`
- 本地运行日志：`data/logs/`（目录 `0700`、文件 `0600`；有限轮转，不进入备份或导出）
- 非敏感运行时设置：`data/settings.json`（权限 `0600`；保存 AI 提供商、端点、模型、本地语义检索模型与 opt-in，以及导入队列暂停、通知、Spotlight 与自动恢复点 opt-in；不保存 API 密钥或备份口令，也不进入备份或导出）
- 敏感凭据：AI API Key 与 X Bearer Token 分别写入 macOS Keychain；微博 OAuth 令牌由官方 CLI 自行写入系统 Keychain，Reader 不读取令牌。
- 数据库采用 WAL 模式，运行时可能出现 `-wal` 和 `-shm` 文件。
- Reader 启动时把默认数据目录权限收紧为 `0700`，数据库及现有 WAL/SHM 文件收紧为 `0600`，避免其他本机用户读取资料库。
- 数据安全中心只自动修复可重建派生状态：本地文件权限、全文索引、RAG 分块索引和可选语义向量索引。数据库页损坏、失效外键、迁移历史异常、缺失/大小不符的附件及未引用文件不会被自动改写或删除；索引修复前的完整备份可在同一界面下载。
- Reader 检测到旧版 schema 时，会在任何结构变更前通过 SQLite `VACUUM INTO` 创建权限为 `0600` 的一致性数据库快照；文件名记录原 schema、目标 schema 和创建时间。“数据安全中心”可查看并导出这些数据库级恢复点。随后按版本顺序逐项事务迁移，并核对固定名称与 SHA-256 审计记录；若历史不匹配，或资料库来自比当前应用更新的 schema，Reader 会停止打开且不继续写入。
- 在左侧“数据安全”打开数据安全中心。Reader 使用 SQLite `VACUUM INTO` 创建一致快照，再打包附件和校验清单；加密备份使用 scrypt 派生密钥与 AES-256-GCM 整包认证加密，Reader 不保存口令。
- 恢复不会覆盖正在运行的数据库：上传包通过路径、大小、哈希和 SQLite 完整性校验后，Reader 先创建安全备份，再安排下次启动原子恢复。
- `schema.mjs` 保留不可变的 schema v8 bootstrap；v9 及后续升级只允许追加到 `migrations.mjs` 的顺序注册表。不要修改已经发布的迁移名称、签名或 SQL。

## AI 服务配置

默认摘要和结构化整理无需联网。翻译要求用户明确启用远程 AI；Reader 不会用词语替换伪装本地翻译。点击标题栏“设置”后可选择：

- `Reader Gateway`：保留原有 `{ action, ...payload }` 网关契约。
- `OpenAI`：固定使用 `https://api.openai.com/v1/` 的 OpenAI-compatible Chat Completions 与模型目录。
- `Ollama（本机）`：固定使用 `http://127.0.0.1:11434/v1/`，不开放局域网 HTTP。
- `其他 OpenAI-compatible 服务`：用户提供 HTTPS 基础地址，或提供 `localhost`/`127.0.0.1`/`::1` 回环 HTTP。

OpenAI-compatible 预设从 `<base>/models` 读取当前服务实际返回的模型 ID，并调用 `<base>/chat/completions` 的 JSON 模式；目录读取必须由用户点击触发，只请求模型元数据，不发送资料库内容。也可以手动填写模型 ID。切换提供商或服务地址时，Reader 不会把旧 Keychain 密钥用于候选连接或模型目录；若没有为新作用域输入新密钥，保存时会清除旧密钥。

推荐先执行隐私连接测试。测试只发送 Reader 内置英文，不读取资料库。macOS 上密钥写入系统 Keychain，`settings.json`、备份、导出、设置 API 和模型目录响应都不会返回它。

### 可选本地语义检索

设置中的“本地语义检索”与远程生成服务彼此独立，默认关闭。启用前需在本机 Ollama 安装嵌入模型，例如 `embeddinggemma`、`qwen3-embedding` 或 `all-minilm`。Reader 只访问固定的 `http://127.0.0.1:11434/api/embed`，不复用远程 AI 地址或 Keychain 密钥；模型测试只发送 9 句 Reader 内置的中文、英文和跨语言短句，显示三组语义正负样本的分离结果，不读取资料库。探针结果是选择模型的本机提示，不伪装成完整基准，也不会阻止用户使用特定模型。点击启用后才分批发送本地片段给本机 Ollama。

Schema v12 将单位化 Float32 向量和 16 组 LSH 桶作为可重建派生数据保存在 SQLite。正文编辑、版本恢复或删除会自动淘汰旧向量；模型 ID 或维度变化会触发重建。查询时使用相同模型生成问题向量，每个 band 查询精确桶和两个最低置信投影位的相邻桶，候选总数仍限制为 1,500，再以精确余弦与既有全文结果做 reciprocal-rank 混排；Ollama 超时、失败或索引未完成时仍返回词法结果。关闭功能会删除全部 `chunk_embeddings` 和 `chunk_embedding_buckets`，不影响文章、分块或 AI 生成设置。

也可在启动前用环境变量提供默认值；一旦保存 Reader 设置，运行时设置优先：

```bash
READER_AI_PROVIDER=reader-gateway \
READER_AI_ENDPOINT=https://your-gateway.example/v1/respond \
READER_AI_API_KEY=replace-me \
npm start
```

`READER_AI_PROVIDER` 可取 `reader-gateway`、`openai`、`ollama` 或 `openai-compatible`；OpenAI-compatible 预设启用时还需 `READER_AI_MODEL`。Reader Gateway 统一接收 `{ "action", ...payload }`：

- `summarize`：输入 `article`，返回 `{ "summary", "points", "model" }`。
- `chat`：输入 `prompt`、`scope`、`context`（本地命中的有限片段），返回 `{ "answer", "model", "citationIds" }`。未命中证据时 Reader 不调用远程服务。
- `translate`：输入 `article`、`targetLanguage`，返回 `{ "title", "excerpt", "content", "language", "model" }`。
- `compose`：输入 `articles`、`prompt`、`format`、`language`，返回 `{ "title", "excerpt", "content", "language", "model" }`。

请求超时为 60 秒，响应最大 2 MB，并拒绝 HTTP 重定向；单次创作最多 20 篇来源、约 24 万字符。非本机网关必须使用 HTTPS；HTTP 只允许 `localhost`、`127.0.0.1` 或 `::1`。连接测试只发送 Reader 内置文本，不读取资料库正文。

## 社交连接器

Reader 只使用官方数据通道，不抓取 X 或微博网页。打开“添加 → 自动订阅 → 配置社交连接器”：

- X：在 X Developer Console 获取应用 Bearer Token，先测试再保存。Token 只进入独立的 macOS Keychain 项；同步使用官方用户查询和用户动态端点，保存 `since_id` 与限流重置时间。
- 微博：安装开放平台官方 CLI：`npm install -g @weibo-ai/weibo-cli`，在终端运行 `weibo auth login --device`，再回到 Reader 检查连接。Reader 只调用 `weibo statuses user_timeline --output json`，不读取或复制 CLI 的 OAuth 令牌。
- 环境变量：源码运行时可用 `READER_X_BEARER_TOKEN` 提供 X 凭据，或用绝对路径 `READER_WEIBO_CLI` 指定官方 CLI。

断开连接器只会暂停后续同步，已经本地化的正文、图片、标签与目录不会被删除。平台 API 的可用权限、配额和费用由对应开发者账号决定。

## API 概览

- `GET /api/health`：运行版本、存储类型与脱敏后台暂停状态。
- `PUT /api/import-jobs/state`：持久化暂停或继续导入队列；响应返回合并后的后台状态。
- `GET /api/stats`：收件箱、未读、收藏等计数。
- `GET/POST /api/articles`：查询或创建内容；查询响应包含不带 `content` 的文章摘要、`total`、`hasMore` 和不透明的 `nextCursor`，后续页把游标原样传回 `cursor`。
- `GET/PATCH /api/articles/:id`：读取或更新文章。
- `POST /api/articles/batch`：原子批量移动、标签、收藏、已读、归档或恢复。
- `POST /api/articles/:id/attachments`：向既有文章安全上传并挂载本地图片。
- `POST /api/exports/markdown`：选择性导出普通 Markdown、附件和可校验 manifest。
- `POST /api/imports/markdown/preview`：安全暂存并预检 Reader Markdown ZIP，返回不含本机路径的选择清单。
- `POST /api/imports/markdown/:id`：把明确选择的文章导入指定资料夹，冲突默认跳过。
- `DELETE /api/imports/markdown/:id`：取消预览并清理暂存内容。
- `GET /api/duplicates`：检测活动资料中的高置信重复组。
- `POST /api/duplicates/resolve`：保留指定版本并非破坏性归档其余副本。
- `GET /api/articles/:id/revisions`：文章版本列表。
- `GET /api/articles/:id/revisions/:version`：读取版本快照。
- `POST /api/articles/:id/revisions/:version/restore`：恢复旧版本并生成新快照。
- `POST/PATCH /api/articles/:id/tags`：添加或移除标签。
- `GET /api/tags`：列出标签与有效内容计数。
- `POST /api/articles/:id/ai/summary`：生成并保存摘要。
- `POST /api/articles/:id/ai/chat`：在当前文章或整个资料库中检索后回答，并返回段落级引用。
- `GET /api/ai/status`：读取 AI 能力和远程服务配置状态，不返回密钥或端点。
- `GET /api/ai/index`：读取本地分块、全文和可选语义索引的数量、一致性与待处理状态。
- `POST /api/ai/search`：执行本地词法检索或词法/向量混排，返回检索模式和带原文偏移的候选引用。
- `GET/PUT/DELETE /api/settings/ai`：读取、更新或恢复 AI 提供商、端点、模型与凭据状态；响应不返回密钥。
- `POST /api/settings/ai/test`：使用内置测试文本验证候选网关，不发送资料库内容。
- `POST /api/settings/ai/models`：显式读取候选 OpenAI-compatible 服务的受限模型目录；不发送资料库内容或返回密钥。
- `GET/PUT /api/settings/semantic-search`：读取状态，或显式启用、切换模型、关闭并删除本地语义索引。
- `POST /api/settings/semantic-search/test`：只向固定回环 Ollama 发送 9 句内置中英/跨语言探针，验证嵌入模型、向量维度并返回三组聚合分离结果。
- `POST /api/ai/translate`：翻译一篇文章，并保存带来源记录的本地 Markdown 草稿。
- `POST /api/ai/compose`：基于最多 20 篇来源生成可编辑、可回链的创作草稿。
- `GET/POST /api/import-jobs`：查看队列或创建 URL 导入任务。
- `POST /api/import-jobs/upload`：流式上传附件并创建任务。
- `GET /api/import-jobs/:id`：读取任务状态。
- `POST /api/import-jobs/:id/retry`：重试失败任务。
- `GET /api/attachments/:id/content`：读取附件，支持字节范围请求。
- `GET/POST /api/collections`：列出树形资料夹或创建资料夹。
- `PATCH/DELETE /api/collections/:id`：改名、移动或安全删除资料夹子树。
- `GET/POST /api/sources`：列出或创建 RSS/YouTube/X/微博来源。
- `PATCH/DELETE /api/sources/:id`：更新频率/开关或删除来源。
- `POST /api/sources/:id/sync`：立即同步来源。
- `GET/POST /api/sources/opml`：导出或导入 OPML。
- `GET /api/settings/connectors`：读取 X 与微博连接状态，不返回令牌。
- `PUT/DELETE /api/settings/connectors/x`：保存或移除 Keychain 中的 X Bearer Token。
- `POST /api/settings/connectors/x/test`：用候选或已保存凭据测试 X 官方 API。
- `POST /api/settings/connectors/weibo/test`：检查微博官方 CLI 登录态。
- `DELETE /api/settings/connectors/weibo`：调用官方 CLI 撤销本机登录。
- `GET/POST /api/backups`：列出或创建完整备份。
- `PUT /api/settings/automatic-backups`：明确开启或关闭每日本机自动恢复点。
- `GET /api/backups/:id/download`：下载本地备份包。
- `GET /api/migration-snapshots`：列出 schema 升级前自动创建的数据库快照，不返回磁盘路径。
- `GET /api/migration-snapshots/:id/download`：导出指定升级快照。
- `POST /api/migration-snapshots/:id/restore`：校验本机升级快照、创建当前完整安全备份，并安排下次启动回退后重新迁移。
- `POST /api/data-health`：只读检查数据库、迁移、权限、附件和检索索引，仅返回脱敏汇总。
- `POST /api/data-health/repair`：在核心检查通过后修复权限或重建本地索引；响应不含磁盘路径、正文或备份 manifest。
- `GET /api/diagnostics/logs`：读取最多 250 条脱敏本地运行事件和轮转统计。
- `GET /api/diagnostics/logs/download`：导出经过二次白名单清洗的 JSONL。
- `DELETE /api/diagnostics/logs`：清除全部本地运行日志，不影响资料库或备份。
- `GET/PUT /api/settings/notifications`：读取或分别保存默认关闭的后台导入、后台订阅通知开关。
- `GET/PUT /api/settings/spotlight`：读取本机索引状态，或明确启用/停用并删除 Reader 的系统索引。
- `POST /api/backups/restore`：校验备份并安排下次启动恢复。
- `DELETE /api/backups/restore`：取消尚未执行的恢复。

0.62.0 变更见 [docs/RELEASE_NOTES_0.62.0.md](docs/RELEASE_NOTES_0.62.0.md)，详细设计见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，安全边界见 [docs/SECURITY.md](docs/SECURITY.md)，后续里程碑见 [docs/PRODUCT_ROADMAP.md](docs/PRODUCT_ROADMAP.md)。
