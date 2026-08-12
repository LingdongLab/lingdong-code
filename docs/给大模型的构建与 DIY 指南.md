# 灵动 Code · 给大模型的构建与 DIY 指南

> **使用方式**：把本文件全文发给大模型，并说明仓库根目录路径（例如 `E:\Ldcode`）。  
> 模型应**按顺序执行**命令，遇到失败先查本文「常见失败」，再改命令；不要跳过自检。  
> 不要提交 API Key、`grok/data/`、或任何本机密钥文件。

---

## 0. 角色与目标

你是在 **Windows 10/11 x64** 上操作的编程助手。目标：

1. 在用户给出的**本仓库根目录**（下文称 `$ROOT`）把依赖与上游源码准备好；
2. 可选：按用户要求修改 Agent 界面 / 品牌；
3. 编译桌面壳并打出**绿色包 zip**；
4. 给出产物路径与验收步骤。

成功标准：

- 存在 `$ROOT\.build\out\LingdongCode-0.1.0-oss-portable.zip`
- zip 内含 `Lingdong\Lingdong.exe` 与 `Lingdong\resources\grok\bin\grok.exe`
- 用户能启动并配置模型后发送一条消息（完整对话依赖用户自己的 API Key）

若用户只要试用、不编译：引导其从 **GitHub Releases** 下载绿色包，或使用维护者放在 `$ROOT\releases\` 的同名 zip（该 zip **不要** `git add`，约 192MB 超 GitHub 普通文件限制；发布用 `scripts\publish-github-release.ps1`）。
约束：

- 路径一律相对于 `$ROOT`，禁止写死其他机器上的盘符路径进将要提交的文件。
- `desktop/vscode/`、`desktop/out/`、`node_modules/`、`grok/bin/*.exe` **不要** `git add`。
- 全量 `build-win32.ps1` 可能需要 **约 1 小时**；仅改 Agent UI 时优先 `sync-builtin-agent.ps1` + `-UseExistingBuild`，避免无谓重编译。

---

## 1. 仓库地图（改哪里）

| 目标 | 目录 / 文件 | 生效方式 |
|------|-------------|----------|
| Agent 对话面板 UI/交互 | `vscode-extension/lingdong-agent/src/webview/`、`*.css` | `sync-builtin-agent.ps1` 后重新出包或 `-UseExistingBuild` |
| Agent 业务逻辑 | `vscode-extension/lingdong-agent/src/` | 同上 |
| Runtime / ACP | `packages/agent-runtime/` | 先 `npm run build:runtime`，再同步扩展 |
| 产品名、协议、默认配置 | `desktop/product/product.lingdong.json`、`desktop/product/user-data-template/` | `sync-product.ps1` + 重建或刷新产物 |
| 图标 / 品牌图 | `packaging/brand/`、`vscode-extension/lingdong-agent/media/` | 同步脚本 / 打包脚本 |
| Workbench 一等贡献骨架 | `desktop/patches/lingdongPrompt/` | `apply-prompt-contrib.ps1` + 全量构建 |
| 深改菜单/布局/欢迎页 | `desktop/vscode/src/vs/workbench/...`（克隆后） | 全量 `build-win32.ps1`；详见 `Code-OSS 源码改造指南.md` |
| 绿色包 / 安装包脚本 | `packaging/` | `build-portable.ps1` / `build-installer.ps1` |
| Grok 二进制落点 | `grok/bin/grok.exe`（gitignore） | `scripts/fetch-grok.ps1` |

架构关系：

```text
用户界面 (lingdong-agent webview)
        │  ACP
        ▼
   grok.exe (Grok Build)
        │
   模型 API（DeepSeek / 自定义等，经本地 model-proxy）

桌面壳 = Code-OSS (desktop/vscode 构建产物) + 内置 lingdong-agent
```

---

## 2. 环境清单（先验收再构建）

| 依赖 | 要求 | 验收命令 |
|------|------|----------|
| OS | Windows 10/11 x64 | — |
| 磁盘 | 建议 ≥40GB 空闲 | — |
| Git | 2.x+ | `git --version` |
| Node.js | **20+**（推荐 20 LTS） | `node -v` |
| npm | 随 Node | `npm -v` |
| Python | **3.10+**（不要 3.7） | `python --version` |
| VS Build Tools | 2022/2026，「使用 C++ 的桌面开发」+ Windows SDK | 见下 |
| 网络 | 可访问 GitHub、npm；拉 Grok 需访问 `x.ai` | — |

查找 VS：

```powershell
& "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
```

仓库自检：

```powershell
cd $ROOT
powershell -NoProfile -File desktop\scripts\check-env.ps1
```

若缺 C++ 工具链：安装 [VS Build Tools](https://visualstudio.microsoft.com/zh-hans/downloads/#build-tools-for-visual-studio-2022)，勾选「使用 C++ 的桌面开发」。若报 MSB8040（Spectre），可装 Spectre 缓解库，或依赖构建脚本自带的 `disable-spectre.props`。

---

## 3. 标准流水线（从零到绿色包）

以下命令在 **`$ROOT`** 执行。把 `$ROOT` 换成用户的实际路径。

### 3.1 安装 JS 依赖

```powershell
cd $ROOT
npm install
```

工作区包：`packages/agent-runtime`、`vscode-extension/lingdong-agent`。

可选验证：

```powershell
npm run build
npm test
```

### 3.2 浅克隆 Code-OSS

```powershell
powershell -NoProfile -File desktop\scripts\setup-vscode.ps1
```

默认 tag：`1.96.4`（可在脚本参数 `-VscodeTag` 修改）。  
结果：`$ROOT\desktop\vscode\`（已 gitignore）。

### 3.3 同步品牌、内置扩展、中文、Prompt 贡献

```powershell
powershell -NoProfile -File desktop\scripts\sync-all.ps1
```

等价于依次：`sync-product` → `sync-builtin-agent` → `apply-prompt-contrib` → `prepare-zh-cn`。

**仅改了 Agent 源码时**，可只跑：

```powershell
powershell -NoProfile -File desktop\scripts\sync-builtin-agent.ps1
```

### 3.4 获取 grok.exe

本仓库不携带二进制：

```powershell
powershell -NoProfile -File scripts\fetch-grok.ps1 -InstallOfficial -Force
```

或用户已官方安装：

```powershell
powershell -NoProfile -File scripts\fetch-grok.ps1 -Force
```

或指定已有文件：

```powershell
powershell -NoProfile -File scripts\fetch-grok.ps1 -FromPath C:\path\to\grok.exe -Force
```

验收：

```powershell
& "$ROOT\grok\bin\grok.exe" --version
```

说明见 `grok/README.md`。自建引擎见 `docs/grok-源码构建.md`。

### 3.5 全量构建桌面壳

```powershell
powershell -NoProfile -File desktop\scripts\build-win32.ps1
```

产物目录：`$ROOT\desktop\out\win32-x64\`，其中应有 `Lingdong.exe`。

若 gulp 已成功、仅收尾失败，可复用：

```powershell
powershell -NoProfile -File desktop\scripts\build-win32.ps1 -UseExistingBuild
```

（会刷新内置 `lingdong-agent`，适合「只改扩展再出包」。）

### 3.6 打绿色包

```powershell
powershell -ExecutionPolicy Bypass -File packaging\build-portable.ps1
```

产物：`$ROOT\.build\out\LingdongCode-0.1.0-oss-portable.zip`  
暂存目录：`$ROOT\.build\stage\portable\Lingdong\`

安装包（可选，需 Inno 等环境，见 `packaging/build-installer.ps1`）：

```powershell
powershell -ExecutionPolicy Bypass -File packaging\build-installer.ps1
```

---

## 4. DIY 界面路线（按成本从低到高）

### 4.1 改 Agent 面板（推荐，秒级～分钟级同步）

1. 编辑 `vscode-extension/lingdong-agent/src/webview/` 下 TS/CSS（对话、设置、时间线等）。
2. 构建扩展：`npm run build:extension`（或 `sync-builtin-agent.ps1` 内会 build）。
3. 若已有 `desktop\out\win32-x64`：

```powershell
powershell -NoProfile -File desktop\scripts\sync-builtin-agent.ps1
powershell -NoProfile -File desktop\scripts\build-win32.ps1 -UseExistingBuild -SkipEnvCheck
powershell -ExecutionPolicy Bypass -File packaging\build-portable.ps1
```

4. 用新 zip 覆盖运行，或直接跑 `desktop\out\win32-x64\Lingdong.exe` 调试。

### 4.2 改品牌文案 / 默认行为

1. 编辑 `desktop/product/product.lingdong.json`（名称、协议、数据目录名等）。
2. `powershell -NoProfile -File desktop\scripts\sync-product.ps1`
3. 需要进壳的改动 → 全量构建；仅默认用户数据模板则视脚本是否拷贝进产物。

### 4.3 改 Workbench 贡献（lingdongPrompt）

1. 改 `desktop/patches/lingdongPrompt/`
2. `apply-prompt-contrib.ps1`（`sync-all` 已含）
3. 全量 `build-win32.ps1`

### 4.4 深改 Code-OSS 壳

1. 确保 `desktop/vscode` 已克隆。
2. 阅读 `docs/Code-OSS 源码改造指南.md`（品牌 / parts / contrib / 主进程对照表）。
3. 源码改动加注释标记便于日后合并上游。
4. 全量重建。小逻辑可对照 `desktop/scripts/patch-*.mjs` 做「源码 + 产物」成对补丁。

---

## 5. 常见失败与处理

| 现象 | 处理 |
|------|------|
| `check-env` / vswhere 找不到 VS | 安装 VS Build Tools C++ 工作负载，重开终端 |
| MSB8040 Spectre | 安装 Spectre 缓解库，或确认脚本已打 `disable-spectre.props` |
| `@types/vscode` 冲突、ExtHost 类型爆炸 | 构建脚本应调用 `ensure-local-vscode-types.ps1`；勿在仓库根污染错误版本的 `@types/vscode` |
| `Missing grok.exe` 出包失败 | 先跑 `scripts\fetch-grok.ps1` |
| 打开文件夹后 Agent 图标消失 | 工作区信任默认须为关闭；由 `apply-workspace-trust-default.ps1` 保证，出包自检会查 |
| 首次启动菜单英文 | 已知问题：关开一次后变中文；Agent 面板本身是中文 |
| 构建被判失败但 gulp 其实成功 | 已修复于脚本；若改脚本勿把外部命令 stdout 混进 PowerShell 返回值 |
| localize / NLS 最后阶段炸 | 勿给 `localize` 传变量，须字面量；有 `check-nls-literals` 预检 |
| 切模型后 DeepSeek 400 `empty call_id` | 扩展内 model-proxy 出站消毒已处理；确保用的是本仓库当前扩展源码 |
| `npm` 被 pnpm packageManager 字段拦截 | 本开源 `package.json` 已去掉 pnpm 强制；在 `$ROOT` 用 npm；在 `desktop/vscode` 内也用 npm（勿用 yarn） |

更细的构建说明：`docs/code-oss-build.md`。

---

## 6. 验收清单

- [ ] `desktop\out\win32-x64\Lingdong.exe` 可启动  
- [ ] `grok\bin\grok.exe --version` 有输出  
- [ ] `.build\out\LingdongCode-0.1.0-oss-portable.zip` 存在  
- [ ] 解压后 `resources\grok\bin\grok.exe` 存在  
- [ ] 扩展「灵动 Agent / 灵动 Code」为内置，无需另装 VSIX  
- [ ] 配置模型 API Key 后能完成一轮对话（用户操作）  

用户配置默认落在 `%APPDATA%\Lingdong`（绿色包不再预置包内 `data/`，换包不丢 Key）。

---

## 7. 你应向用户汇报的格式

完成后用简短中文说明：

1. 执行了哪些关键步骤（是否全量编译）；  
2. 绿色包完整路径与大约体积；  
3. 若做了 DIY：改了哪些文件、如何生效；  
4. 未解决的错误（原文 + 已尝试的修复）。

---

## 8. 相关文档（需要细节时再打开）

- `docs/code-oss-build.md` — 构建环境与脚本坑  
- `docs/Code-OSS 源码改造指南.md` — 壳改造地图  
- `docs/grok-源码构建.md` — 可选自建 Grok  
- `docs/灵动Code 使用手册.md` — 终端用户手册  
- `docs/功能能力清单.md` — 功能列表  
- `grok/README.md` — 二进制获取  
- `THIRD_PARTY_NOTICES.md` — 第三方许可  

---

## 9. 一键命令块（复制用）

```powershell
# 将下一行改成实际仓库根目录
$ROOT = "E:\Ldcode"
cd $ROOT

npm install
powershell -NoProfile -File desktop\scripts\setup-vscode.ps1
powershell -NoProfile -File desktop\scripts\sync-all.ps1
powershell -NoProfile -File scripts\fetch-grok.ps1 -InstallOfficial -Force
powershell -NoProfile -File desktop\scripts\build-win32.ps1
powershell -ExecutionPolicy Bypass -File packaging\build-portable.ps1

Get-Item "$ROOT\.build\out\LingdongCode-0.1.0-oss-portable.zip"
```
