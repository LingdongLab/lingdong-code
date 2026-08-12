# Code-OSS 源码改造指南

> 我们手里是**一整份 VS Code（Code-OSS）源码**（`desktop/vscode/`），不是套壳。
> 理论上界面上看得见的每一个像素、每一条菜单、每一个快捷键、每一个默认行为都能改。
> 本文回答三个问题：源码长什么样、我们已经改了哪些、还能改哪些（改哪个文件）。

---

## 一、三条改法（先选路线再动手）

| 路线 | 做法 | 生效成本 | 适用 |
|---|---|---|---|
| **A. 配置层** | 改 `product.json`、默认设置注入 | 秒级，重启即生效 | 品牌、开关、端点地址 |
| **B. 产物就地补丁** | 写 `desktop/scripts/patch-*.mjs` 直接改打好的 `workbench.desktop.main.js` | 秒级，不用重建 | 小逻辑翻转（几行代码的改动） |
| **C. 源码修改 + 全量重建** | 改 `desktop/vscode/src/`，跑 `desktop/scripts/build-win32.ps1` | 全量重建（约 1 小时级） | 新功能、结构性改动 |

**规矩**：凡是走 B 路线的改动，必须同时把 C 路线的源码补丁也打上（两边行为一致），
否则下次全量重建就把补丁冲掉了。已有先例：拖放两个补丁都是"源码 + 产物脚本"成对交付的。

### 已有的产物补丁脚本（`desktop/scripts/`）

| 脚本 | 干什么 |
|---|---|
| `patch-webview-drag.mjs` | 反转拖放策略：拖文件默认交给对话面板，按住 Shift 才让编辑器打开 |
| `patch-editor-drop-overlay.mjs` | webview 编辑器上不再压"按住 Shift 以放入编辑器"覆盖层 |
| `patch-cursor-menubar.mjs` | 菜单栏定制 |
| `apply-workspace-trust-default.ps1` | 工作区信任默认关闭（否则打开文件夹后 Agent 会消失） |
| `apply-prompt-contrib.ps1` | 把 lingdongPrompt 一等贡献接进 workbench |
| `sync-product.mjs` / `.ps1` | 同步 product.json 品牌信息 |
| `sync-builtin-agent.ps1` | 把 lingdong-agent 扩展编进内置扩展目录 |

---

## 二、源码地图

```
desktop/vscode/
├── product.json                 ← 产品定义（品牌/端点/内置扩展清单）
├── src/vs/
│   ├── base/                    ← 基础库：DOM、事件、异步、数据结构（尽量别动）
│   ├── platform/                ← 平台服务：配置、文件、窗口、菜单、遥测…（谨慎动）
│   ├── editor/                  ← Monaco 编辑器内核 + 编辑器级 contrib
│   ├── workbench/               ← 工作台（我们主要的改造区）
│   │   ├── browser/parts/       ← 标题栏/活动栏/侧边栏/状态栏/编辑器区/面板
│   │   ├── contrib/             ← 90+ 个功能模块，一目录一功能（见下表）
│   │   │   └── lingdongPrompt/  ← 我们自己的一等贡献（原生服务+命令骨架）
│   │   └── services/            ← 工作台级服务
│   ├── code/                    ← Electron 主进程：窗口创建、系统菜单、托盘、协议
│   └── server/                  ← 远程/服务器形态（我们暂不用）
├── extensions/                  ← 内置扩展（git、markdown、语言支持…、lingdong-agent）
└── build/                       ← gulp 构建管线、打包配置
```

### 已改过的源码文件（先例，照着抄）

| 文件 | 改了什么 |
|---|---|
| `workbench/contrib/webview/browser/webviewWindowDragMonitor.ts` | 拖放默认给 webview |
| `workbench/browser/parts/editor/editorDropTarget.ts` | webview 上不压拖放覆盖层 |
| `workbench/browser/parts/titlebar/menubarControl.ts` | 菜单栏定制 |
| `workbench/contrib/debug/browser/debug.contribution.ts` | 调试相关定制 |
| `workbench/workbench.common.main.ts` | 挂载 lingdongPrompt 贡献 |
| `workbench/contrib/lingdongPrompt/` | 全新目录：我们的原生贡献模块 |

---

## 三、能改什么（按功能域）

### 1. 品牌与产品定义 —— `product.json`（路线 A）

现有键：`nameShort/nameLong/applicationName`（名称）、`urlProtocol`（`lingdong://` 协议）、
`dataFolderName`（数据目录）、`extensionsGallery`（扩展市场端点）、`updateUrl`（更新服务器）、
`checksums`（产物校验和，打补丁后必须同步）、`builtInExtensions`、`win32*`（安装器标识）。

能做：换扩展市场源（如 OpenVSX）、指自己的更新服务器、改协议名、改许可与反馈链接。

### 2. 窗口外壳 —— `workbench/browser/parts/`（路线 B/C）

| 部件 | 目录 | 典型改造 |
|---|---|---|
| 标题栏/菜单栏 | `parts/titlebar/` | 精简菜单项、加"灵动"菜单、改窗口按钮（已有先例） |
| 活动栏 | `parts/activitybar/` | 增删图标、默认顺序、加 Agent 入口 |
| 侧边栏 | `parts/sidebar/` | 默认视图、宽度策略 |
| 状态栏 | `parts/statusbar/` | 加常驻 Agent 状态项（模型名/任务进度） |
| 编辑器区 | `parts/editor/` | 拖放行为（已改）、标签页策略、分屏规则 |
| 底部面板 | `parts/panel/` | 默认布局、终端位置 |
| 全局布局 | `browser/layout.ts` | 各区域默认可见性、启动布局 |

### 3. 工作台功能模块 —— `workbench/contrib/`（路线 C 为主）

一目录一功能，删繁就简都在这里。与我们最相关的：

| 模块 | 能做什么 |
|---|---|
| `welcomeGettingStarted/`、`welcomeViews/` | **欢迎页整个换掉**：首屏直接进对话、放自己的引导 |
| `webview/`、`webviewPanel/` | webview 策略（拖放已改）、CSP、外链打开规则 |
| `files/` | 资源管理器右键菜单——可加"**加入对话上下文**"一类命令 |
| `scm/` | Git 源码管理界面；可接 Agent 生成提交信息按钮 |
| `terminal/` | 终端右键"发给 Agent 解释/修复" |
| `search/` | 搜索结果右键"作为上下文发给 Agent" |
| `extensions/` | 扩展商店界面；可隐藏、可换源、可预装 |
| `update/` | 更新提示与通道 |
| `telemetry/`、`surveys/`、`emergencyAlert/` | **微软遥测/问卷/实验全部拔掉** |
| `workspace/` | 工作区信任（默认已关，脚本兜底） |
| `chat/`、`inlineChat/` | 上游 Copilot Chat 的壳：可拆掉避免混淆，或**借它的编辑器内联 UI 接我们的 Agent（行内 diff、Ctrl+K 式改写）** |
| `preferences/`、`keybindings/` | 设置界面与键位编辑器；可预置灵动分组 |
| `themes/` | 主题机制；可内置灵动配色为默认 |
| `lingdongPrompt/` | **我们自己的地盘**：原生服务、命令、之后的原生面板都从这儿长 |

### 4. 编辑器内核 —— `src/vs/editor/`（路线 C，谨慎）

- `editor/common/config/editorOptions.ts`：编辑器所有默认值（字号、minimap、内联提示…）
- `editor/contrib/`：右键菜单、悬浮提示、代码镜头、内联补全（`inlineCompletions` 可接我们自己的补全服务，做"Tab 补全"）
- diff 编辑器（`editor/browser/widget/diffEditor/`）：Agent 改动预览的呈现就依赖它

### 5. Electron 主进程 —— `src/vs/code/`（路线 C）

窗口创建参数（尺寸/无边框/背景色）、系统级菜单、`lingdong://` 协议处理（外部唤起并
携带指令直达 Agent）、单实例策略、托盘图标。

### 6. 内置扩展 —— `extensions/`（独立构建，成本低）

- `lingdong-agent`：我们的主体，日常迭代走 `sync-builtin-agent.ps1`，**不用重建工作台**
- `git`/`github`：可定制克隆、认证流程
- 各语言基础支持：按需增删（省体积）
- 主题包：预置灵动主题并设为默认

### 7. 默认设置与键位（路线 B/C 皆可）

任何 `registerConfiguration` 注册的设置都能改默认值（工作区信任就是这么关的）。
键位在各 contrib 的 `registerAction2`/`KeybindingsRegistry` 里注册，可加全局快捷键
（例如 `Ctrl+L` 唤起对话面板，对标 Cursor）。

---

## 四、典型场景菜谱

| 想做的事 | 动哪里 | 路线 |
|---|---|---|
| 启动直接进对话界面 | `welcomeGettingStarted` 或 `browser/layout.ts` 启动逻辑 | C |
| `Ctrl+L` 全局唤起 Agent | `lingdongPrompt` 里 `registerAction2` + keybinding | C |
| 编辑器右键"加入对话上下文" | `files/`、`codeEditor/` 的菜单注册（`MenuId.EditorContext`） | C |
| 状态栏显示当前模型/任务 | `parts/statusbar/` 或 lingdong-agent 扩展 API | C / 扩展 |
| 行内 Ctrl+K 改写（对标 Cursor Cmd+K） | 借 `inlineChat/` 的 UI，后端接我们的 ACP | C（大活） |
| Tab 智能补全 | `editor/contrib/inlineCompletions` 接自建服务 | C（大活） |
| 去掉不要的菜单/命令 | `menubarControl.ts`（已有先例）、各 contrib 的 action 注册 | B/C |
| 换扩展市场 / 更新源 | `product.json` | A |
| 拔遥测 | `telemetry/` contrib + `product.json` 去端点 | A/C |
| 小的行为翻转（几行 if） | 照 `patch-editor-drop-overlay.mjs` 写产物补丁 + 源码同步改 | B+C |

---

## 五、不建议动的区域

- `src/vs/base/`、`src/vs/platform/` 核心服务：牵一发动全身，升级合并冲突最大
- 编辑器文本模型（`editor/common/model/`）：正确性敏感，性能敏感
- 构建管线 `build/`：能不动就不动，我们已有的 spectre/node-gyp 补丁是被迫的

**升级策略**：所有源码改动尽量集中、加 `灵动 Code：` 注释标记（现有补丁都这么做了，
`grep 灵动` 能列全改动点）；将来合并上游新版本时按这份清单逐个重放。

---

## 六、构建与验证速查

```powershell
# 全量重建（源码改动后）
desktop/scripts/build-win32.ps1

# 只更新内置 Agent 扩展（日常迭代，秒级）
desktop/scripts/sync-builtin-agent.ps1

# 产物就地补丁（重建后如未从源码带上，可幂等重放）
node desktop/scripts/patch-webview-drag.mjs desktop/out/win32-x64/resources/app
node desktop/scripts/patch-editor-drop-overlay.mjs desktop/out/win32-x64/resources/app

# 出绿色包 / 安装包
packaging/build-portable.ps1
packaging/build-installer.ps1
```

注意：动过 `workbench.desktop.main.js` 必须同步 `product.json` 的 `checksums`
（补丁脚本已自动处理），否则启动弹"安装似乎损坏"。
