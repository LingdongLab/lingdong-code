<p align="center">
  <img src="docs/assets/logo.png" alt="灵动 Code" width="168" />
</p>

<h1 align="center">灵动 Code</h1>

<p align="center">
  <strong>开源的 Windows AI 编程软件</strong><br/>
  装好就能用中文跟 AI 一起写代码、改项目、跑命令
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT" /></a>
  <img src="https://img.shields.io/badge/平台-Windows%20x64-111111.svg" alt="Windows" />
  <img src="https://img.shields.io/badge/版本-0.1.0-lightgrey.svg" alt="0.1.0" />
</p>

---

## 这是什么？

**灵动 Code** 是一个桌面软件（类似 VS Code 的样子），右边（或侧边）有一个 **AI 对话面板**。你打开自己的代码文件夹，用中文说「帮我修这个 bug」「加一个登录页」，它会去读文件、改代码、必要时跑终端命令，并把改动列给你看，可以审阅或回退。

它主要由三块组成（知道概念即可，不用先学会编译）：

| 部分 | 通俗理解 |
|------|----------|
| 桌面壳 | 窗口、编辑器、菜单——基于微软开源的 VS Code（Code-OSS）编出来 |
| 灵动 Agent 扩展 | 你看到的对话界面、设置、计划、权限卡片等 |
| Grok 引擎 | 后台真正干活的 AI Agent 程序（`grok.exe`） |

许可证：本仓库代码为 **MIT**（见 [LICENSE](LICENSE)）。第三方说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

---

## 我该看哪一段？

按你的目标选一条路就行：

| 你想做什么 | 看哪里 |
|------------|--------|
| **只想先用起来**（不编译） | ↓ [一、下载绿色包试用](#一下载绿色包试用推荐小白) |
| **想改界面 / 改名字 / 自己打包** | ↓ [二、想改软件或自己编译](#二想改软件或自己编译) |
| **把整份构建说明丢给 AI 代劳** | [docs/给大模型的构建与 DIY 指南.md](docs/给大模型的构建与%20DIY%20指南.md) |
| **日常怎么点界面、配模型** | [docs/灵动Code 使用手册.md](docs/灵动Code%20使用手册.md) |

---

## 一、下载绿色包试用（推荐小白）

「绿色包」= 解压就能用的压缩包，**不用安装 Visual Studio，也不用会编程**。

### 1. 下载

1. 打开本仓库的 **[Releases（发行版）](https://github.com/LingdongLab/lingdong-code/releases)** 页面。  
2. 找到最新版本（例如 `v0.1.0`）。  
3. 下载文件：`LingdongCode-0.1.0-oss-portable.zip`（大约 190～200 MB）。

> 如果 Releases 里暂时还没有附件：请等维护者上传，或向维护者索取该 zip。  
> 说明：这个文件太大，不能直接放进 git 仓库（GitHub 限制 100 MB），所以走 Releases 下载。

### 2. 解压

1. 把 zip 解压到你有写权限的目录，例如：`D:\LingdongCode`。  
2. **不建议**解压到 `C:\Program Files`（可能要管理员权限，也容易踩权限问题）。  
3. 解压后应能看到类似结构：

```text
Lingdong\
  Lingdong.exe          ← 主程序
  启动灵动Code.cmd      ← 也可以点这个启动
  使用说明.txt
  resources\...
```

### 3. 第一次启动

1. 双击 `Lingdong.exe`，或双击 `启动灵动Code.cmd`。  
2. 若 Windows 智能筛查拦截：点「更多信息」→「仍要运行」（当前发行包可能尚未代码签名）。  
3. 用菜单或欢迎流程 **打开一个文件夹**（你的项目目录）。  
4. 打开 **灵动 Agent / 设置**，配置至少一个模型的 **API Key**（例如 DeepSeek）。  
   - Key 是你在模型官网申请的密钥，**不要发给别人，也不要提交到 git**。  
5. 在对话框输入「你好」，能收到回复就说明跑通了。

更细的界面操作、快捷键、权限卡片等，见：

- [使用手册](docs/灵动Code%20使用手册.md)  
- [绿色包说明](releases/README.md)

### 4. 换包会不会丢配置？

默认配置在本机：`%APPDATA%\Lingdong`。  
换一个新的绿色包解压覆盖/另放，一般 **不用重新填 Key**（除非你删过 AppData）。

---

## 二、想改软件或自己编译

适合：想换 Logo/名字、改对话面板样子、或从源码打出自己的绿色包。

### 2.1 你需要先具备什么

| 环境 | 要求 | 备注 |
|------|------|------|
| 系统 | Windows 10/11 **64 位** | — |
| 磁盘 | 建议空闲 **40GB+** | 源码 + 依赖 + 编译产物很大 |
| Git | 已安装 | [git-scm.com](https://git-scm.com/) |
| Node.js | **20 或以上** | [nodejs.org](https://nodejs.org/) LTS 即可 |
| Python | **3.10 或以上** | 不要用很老的 3.7 |
| VS 生成工具 | 「使用 C++ 的桌面开发」 | [Build Tools](https://visualstudio.microsoft.com/zh-hans/downloads/) |
| 网络 | 能访问 GitHub、npm；拉 Grok 时需访问 x.ai | — |

完整检查清单与踩坑见 [docs/code-oss-build.md](docs/code-oss-build.md)。  
若你更想让 AI 助手一步步做：把 [给大模型的构建与 DIY 指南](docs/给大模型的构建与%20DIY%20指南.md) **全文**发给它，并告诉它仓库在哪个盘符路径。

### 2.2 拿到源码

```powershell
git clone git@github.com:LingdongLab/lingdong-code.git
cd lingdong-code
```

（若你还没配 SSH，也可用 HTTPS：`https://github.com/LingdongLab/lingdong-code.git`。）

### 2.3 常见「想改什么 → 改哪个文件夹」

| 想改的内容 | 去这里改 | 改完怎么生效 |
|------------|----------|--------------|
| 对话面板外观、按钮、布局 | `vscode-extension/lingdong-agent/` 里的界面代码（多为 `src/webview/`） | 重新同步扩展并打包（见下） |
| 软件显示名、默认设置 | `desktop/product/` | 跑同步脚本后再编译/出包 |
| Logo、图标素材 | `packaging/brand/`、`docs/assets/` | 按打包脚本/产品配置引用 |
| 编辑器菜单、窗口壳深层改造 | `desktop/vscode/`（需先按脚本克隆出来） | 全量编译，约 1 小时；见 [源码改造指南](docs/Code-OSS%20源码改造指南.md) |

### 2.4 从源码打出绿色包（标准流程）

在仓库根目录打开 PowerShell，**按顺序**执行（中间某步失败先停，不要跳步）：

```powershell
# 1) 安装本仓库的 Node 依赖
npm install

# 2) 下载 VS Code 开源源码到 desktop\vscode（体积大，首次较久）
powershell -NoProfile -File desktop\scripts\setup-vscode.ps1

# 3) 同步品牌、内置 Agent、中文等
powershell -NoProfile -File desktop\scripts\sync-all.ps1

# 4) 下载 Grok 引擎到 grok\bin\grok.exe（仓库里不自带这个大文件）
powershell -NoProfile -File scripts\fetch-grok.ps1 -InstallOfficial -Force

# 5) 编译桌面程序（第一次往往要很久，请耐心等）
powershell -NoProfile -File desktop\scripts\build-win32.ps1

# 6) 打成绿色包 zip
powershell -ExecutionPolicy Bypass -File packaging\build-portable.ps1
```

成功后，绿色包一般在：

` .build\out\LingdongCode-0.1.0-oss-portable.zip `

只改了 Agent 界面、以前已经完整编译过时，可以用「刷新扩展 + 复用旧编译」加快出包，细节写在 [给大模型的构建与 DIY 指南](docs/给大模型的构建与%20DIY%20指南.md)。

### 2.5 让 AI 帮你编译 / 改界面

1. 打开文档：[docs/给大模型的构建与 DIY 指南.md](docs/给大模型的构建与%20DIY%20指南.md)  
2. **全文复制**发给 Cursor / ChatGPT 等助手  
3. 告诉它：仓库路径是多少（例如 `E:\lingdong-code`），你想改什么  
4. 让它按文档逐步执行，不要跳过环境检查  

---

## 三、仓库里都有什么（浏览用）

```text
lingdong-code/
  docs/assets/                 Logo 等图片
  docs/                        使用手册、构建说明
  vscode-extension/
    lingdong-agent/            对话面板（改 UI 最常来这里）
  packages/agent-runtime/      与 Agent 引擎通信的库
  desktop/product/             产品名、默认配置
  desktop/patches/             接到编辑器壳上的小模块
  desktop/scripts/             克隆 / 同步 / 编译脚本
  packaging/                   打绿色包、安装包的脚本和品牌资源
  grok/                        只放 grok.exe 的位置（exe 不进 git）
  scripts/fetch-grok.ps1       帮你下载 grok.exe
  releases/                    本机可放绿色包；zip 被 git 忽略
```

克隆下来之后，这些需要你在本机再生成，**不会**出现在干净仓库里：

- `desktop/vscode/`（上游编辑器源码）  
- `desktop/out/`、`.build/`（编译产物）  
- `node_modules/`  
- `grok/bin/grok.exe`  
- `releases/*.zip`  

---

## 四、更多文档

| 文档 | 什么时候看 |
|------|------------|
| [给大模型的构建与 DIY 指南.md](docs/给大模型的构建与%20DIY%20指南.md) | 要编译、要 DIY，或丢给 AI 执行 |
| [灵动Code 使用手册.md](docs/灵动Code%20使用手册.md) | 已经能打开软件，想学怎么用 |
| [功能能力清单.md](docs/功能能力清单.md) | 想了解目前支持哪些能力 |
| [code-oss-build.md](docs/code-oss-build.md) | 编译报错、环境问题 |
| [Code-OSS 源码改造指南.md](docs/Code-OSS%20源码改造指南.md) | 要改菜单/布局/欢迎页等壳层 |
| [grok-源码构建.md](docs/grok-源码构建.md) | 进阶：自己编译 Grok 引擎 |
| [releases/README.md](releases/README.md) | 绿色包上传与分发说明 |

---

## 五、安全提醒（很重要）

- **API Key、账号密码不要发到 Issues，也不要提交进 git。**  
- 不要把 `grok/data/`（里面可能有会话）提交上网。  
- 本仓库 `.gitignore` 已忽略常见密钥与本地数据；若你新增配置文件，请再检查一遍。

---

## 六、参与改进

欢迎提 Issue / PR：修文档、改界面、改进打包脚本都可以。

提交代码前请尽量做到：

1. 不引入密钥、本机绝对路径、巨型二进制；  
2. 改了 Agent 相关逻辑时，在装好依赖后跑一下 `npm test`；  
3. 若改变了构建步骤，同步改 [给大模型的构建与 DIY 指南](docs/给大模型的构建与%20DIY%20指南.md)。
