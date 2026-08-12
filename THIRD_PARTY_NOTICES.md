# Third-Party Notices

灵动 Code 开源仓库自身代码使用 **MIT**（见根目录 `LICENSE`）。构建与运行还会拉取或捆绑下列第三方组件，请遵守各自许可证。

## Microsoft VS Code / Code-OSS

- 用途：桌面壳源码（由 `desktop/scripts/setup-vscode.ps1` 浅克隆到 `desktop/vscode/`，**不**随本仓库分发）
- 上游：https://github.com/microsoft/vscode
- 许可证：MIT License
- 钉死版本：见 `desktop/scripts/setup-vscode.ps1` 默认 tag（当前文档约定 `1.96.4`）

## xAI Grok Build

- 用途：Agent 运行时（`grok.exe`，由 `scripts/fetch-grok.ps1` 获取或自行从源码编译）
- 上游：https://github.com/xai-org/grok-build
- 公告：https://x.ai/news/grok-build-open-source
- 许可证：Apache License 2.0
- 官方安装脚本：https://x.ai/cli/install.ps1

本仓库**不**分发 `grok.exe` 二进制，也不 vendor 完整 `grok-src` 树。

## 其他

- Node.js 依赖：见各 `package.json` / `package-lock.json`，按包内声明的许可证执行
- `@parcel/watcher` 等原生模块：随 Code-OSS 构建产物一并打包，许可证以其 npm 包为准
- 中文语言包 `ms-ceintl.vscode-language-pack-zh-hans`：随构建脚本准备，许可证随上游扩展

若你分发编译产物（绿色包 / 安装包），请在发行说明中保留对本文件与上述上游许可证的引用。
