# Reader 0.13.0

0.13 把产品内核变成了真正可启动的 Intel Mac App，同时保持 local-first 数据边界。

## Mac App

- 新增 Electron 桌面壳：单实例、Dock 生命周期、原生菜单、系统另存为和隐藏式 macOS 标题栏。
- `Reader.app` 内的静态资源保持只读；数据库、附件、缩略图、设置和备份写入 `Application Support/Reader/ReaderData`。
- 应用升级与用户资料物理分离；开发/验收可用绝对路径覆盖数据根目录。
- 新增 Reader 应用图标、Bundle ID `com.reader.localfirst`、macOS 12 最低版本和 x86_64 构建。

## 桌面安全

- 渲染器启用 Chromium sandbox 与 context isolation，关闭 Node integration、远程内容和不安全混合内容。
- 网页权限请求统一拒绝；导航仅信任启动时生成的精确 `127.0.0.1` origin。
- HTTP/HTTPS 外链交给系统浏览器，`file:`、`data:`、`javascript:` 等协议被拒绝。
- 新增严格 CSP；移除 Electron 模板自带但产品不需要的相机、麦克风、蓝牙权限声明。
- ATS 关闭任意网络加载，只保留本地回环 HTTP 例外。

## 验证

- 43/43 自动测试通过。
- TypeScript 与 Vite 生产构建通过。
- `npm audit --audit-level=moderate` 为 0 已知漏洞。
- 真实 `Reader.app` 启动通过：1440×900 窗口、0.13.0 健康检查、preload 桥、本地 SQLite 写入/重载和 `⌘N` 均已验收。
- 应用包通过 `codesign --verify --deep --strict` 的 ad-hoc 签名校验。

## 已知边界

- 当前只提供 Intel Mac x86_64 构建。
- ad-hoc 签名不是 Apple Developer ID 签名；尚未公证，跨机器分发可能触发 Gatekeeper 确认。
- DMG、自动更新、Share Extension、Spotlight 和 Apple Silicon 通用构建仍在后续发行里程碑。
