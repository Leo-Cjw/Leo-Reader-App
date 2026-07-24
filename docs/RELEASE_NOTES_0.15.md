# Reader 0.15.0

本版本把 Reader 从 Intel 测试包推进为可安装的 Intel/Apple Silicon 通用 Mac 发行包，并把构建、架构和升级数据门禁固化为可重复流程。

## 通用 Mac 发行

- 分别使用 Electron 41.7.1 的 x64 与 arm64 官方压缩包构建独立应用；下载内容必须匹配 Electron 依赖内置的官方 SHA-256。
- 合并为包含 `x86_64` 与 `arm64` 的通用 App；Canvas 的两套原生模块保留独立架构，并在产物中逐一检查。
- 在没有 Xcode Command Line Tools 的构建机上使用项目内流式 Mach-O 合并工具；它支持 thin/fat 输入、16 KiB 对齐、原子替换和权限保留。
- 通用 App 完成 ad-hoc 深度签名和严格验证；DMG 带 `Applications` 快捷方式，并通过 `hdiutil verify`。
- `npm run desktop:pack` 可重复执行完整的构建、合并、签名与 DMG 流程。
- 流水线支持通过环境变量启用 Developer ID、hardened runtime、Keychain 公证 profile、DMG 票据装订与验证；当前交付因没有真实证书与凭据而保持 ad-hoc 模式。

## 升级与首次启动验收

- 使用 0.14 在隔离资料库创建文章，再用 0.15 通用版连续启动两次。
- 文章 ID、标题、正文唯一标记、收藏状态和 75% 阅读进度在升级和重启后保持一致。
- 直接启动 DMG 挂载目录中的 App，以全新数据目录验证首次启动；本地服务报告 0.15.0、SQLite 存储和三条初始内容。
- 构建宿主为 Intel Mac，因此 x86_64 切片已实际运行；arm64 切片已完成官方哈希、Mach-O 架构、原生模块和签名结构验证，仍需 Apple Silicon 真机运行门禁。

## 质量门禁

- 51 项自动测试通过；新增通用 Mach-O 合并、架构读取、对齐、权限、无尾部填充和重复架构拒绝测试。
- `npm run build` 通过。
- `npm audit --audit-level=moderate` 为 0 已知漏洞。
- 通用 App 通过 `codesign --verify --deep --strict`，DMG 通过完整校验。

## 已知边界

- 当前为 ad-hoc 签名，尚未使用 Apple Developer ID，也尚未提交 Apple 公证。
- 跨机器首次打开可能需要在“系统设置 → 隐私与安全性”中确认。
- 正式公开分发前仍需 Developer ID、公证、Apple Silicon 真机 Gatekeeper 验收与自动更新。
