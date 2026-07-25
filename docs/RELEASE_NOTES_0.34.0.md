# Reader 0.34.0

本版本继续收口 macOS 辅助技术边界：三栏桌面提供可区分的 landmark 名称，文章异步切换有稳定播报并避免短暂暴露上一正文，同时遵循系统“减少动态效果”。SQLite schema 保持 v10，API、设置、文章、附件、备份和导入导出格式均不变。

## VoiceOver 导航结构

- 产品侧栏和文章助手成为分别命名的 complementary landmark；内容区由当前一级标题命名为 region；阅读器 main 的名称包含真正完成加载的文章标题。
- 内容列表在初次读取、筛选和加载更多时公开 `aria-busy`，可见数量文案同时作为 polite status；视觉标题、计数与操作布局不变。
- App 根部保留 persistent polite live status。文章切换时先表达正在载入，详情与当前 ID 一致后再播报实际标题。
- 阅读器和文章助手只接收与当前选中 ID 匹配的详情对象；快速切换期间显示本地载入态，不会把上一文章的正文或 AI 面板误标为当前内容。

## 减少动态效果

- `prefers-reduced-motion: reduce` 下，面板、模态框、任务状态和 toast 动画以及全部 CSS 过渡缩短为单次近零时长。
- 定位高亮与跳到批注改为即时滚动；默认系统设置下仍保留原有平滑滚动。
- 任务运行、加载和完成始终有文字状态，减少动画后不会丢失唯一提示。

## 依赖安全

- 发行期间新披露的 [`brace-expansion` CVE-2026-14257](https://github.com/advisories/GHSA-mh99-v99m-4gvg) 会让恶意 brace pattern 耗尽 Node 内存。Reader 将运行时 Archiver 升级到 8.0.0，生产依赖树使用已修复的 `brace-expansion` 5.0.8，`npm audit --omit=dev --audit-level=low` 为 0 漏洞。
- Electron Builder 26.15.3 与 `@electron/universal` 2.0.3 的构建树仍固定旧版 minimatch/brace API，上游当前没有兼容 Node 20 的修复版本。它们只处理仓库内固定 globs 与受控源码文件名，不进入最终 App，也不接触用户导入内容。
- 新的 `npm run audit:dependencies` 门禁要求生产树始终为 0 漏洞，并只在 devDependency 树放行这一条精确公告；任何新公告、生产路径回归或其他直接构建工具漏洞都会失败。上游发布兼容修复后应删除例外。

## 验证

- 新增静态契约测试，覆盖命名 pane、内容区 busy 状态、文章详情 ID 门禁、live status、动态阅读器名称、系统媒体查询和两处 JS 滚动路径。
- 真实 Chromium 可访问树识别出“产品导航”“收件箱”“阅读器：文章标题”“AI 文章助手”；切换文章后 live status 和 main 名称同步到新标题。
- 视觉截图确认暖白三栏、内容卡片、阅读正文和文章助手没有布局回归。
- `npm test`：101/101 通过；`npm run build`：生产构建通过；`npm run audit:dependencies`：生产依赖 0 漏洞，完整树仅保留上文已评估的构建工具公告。

## Universal 包

- `Reader-0.34.0-universal.dmg`：254,613,145 字节；SHA-256 `eb4e4ac127f9a6bb26ed9b77139e786677742d3d23db1c3eb2f4b7d0e339fed2`。
- DMG 校验通过；App 主程序同时包含 `x86_64` 与 `arm64`，短版本与 build 均为 `0.34.0`，深度严格签名校验通过。
- 最终包仍为 ad-hoc 签名（`com.reader.localfirst`，无 Team Identifier），因此没有生成可用于正式自动更新的 ZIP。
- 使用隔离数据目录启动最终精确 App，`/api/health` 返回 0.34.0；包内 CSS 包含 reduce 媒体查询、近零动画与过渡规则。对同一服务的最终可访问树再次确认四个命名 pane，切换文章后 persistent status 与阅读器名称同步更新；最终截图未发现视觉回归。

## 已知边界

- 自动化验证的是 Chromium 可访问树与最终包运行状态，不等同于启用 VoiceOver 后对语速、转子顺序、冗余播报和长时间导航的完整人工听读。
- 当前包仍缺少真实 Apple Developer ID、公证、正式 GitHub Release、Apple Silicon Gatekeeper/跨版本升级验收，以及最终包原生 AX 复验。
