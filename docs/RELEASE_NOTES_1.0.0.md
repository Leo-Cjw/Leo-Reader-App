# Reader 1.0.0 Candidate

Reader 1.0.0 把既有 local-first 功能、数据兼容门禁和 macOS 打包验证整理为首个发行候选基线。它不是正式公开发行：当前产物仍为 ad-hoc 签名，尚未公证、创建 GitHub Release 或启用自动更新。

## 可重复质量门禁

- GitHub Actions 会在 `main` 的每次推送和面向 `main` 的每个 pull request 上，在 macOS 15 运行 `npm ci`、生产依赖审计、自动测试和 TypeScript/Vite 生产构建。
- 工作流固定使用 Node.js 24、只授予仓库内容读取权限，不接触密钥、签名、公证、打包或发布。
- `CI / verify` 是唯一建议合并门禁；工作流自身有回归测试，防止校验步骤或最小权限边界被意外移除。

## 兼容与版本身份

- 主 App、Share Extension 和 Spotlight helper 统一为营销版本 `1.0.0`、递增构建号 `100`。
- SQLite schema 继续为 v12，`settings.json` 继续为 version 1；用户资料库、附件、备份、导入导出和 0.43 冻结升级样本保持兼容。
- 1.0 候选不改变本地 HTTP、AI、导入或数据模型行为；0.64 的 AI 跨存储一致读取保障继续有效。

## 发行边界

- 此候选只验证源码质量和本地可重建性，不声明已完成 Developer ID 签名、公证、Gatekeeper、跨版本自动安装或真实系统来源的人工验收。
- 正式发行前仍需使用发行凭据构建 Universal DMG 与更新 ZIP，独立校验清单/哈希，并在 Intel 和 Apple Silicon 真机完成安装与升级演练。
