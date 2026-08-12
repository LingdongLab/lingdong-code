# 灵动 Code · Code-OSS 源码构建说明

把桌面壳从「下载 VSCodium zip 再封装」切换为 **microsoft/vscode（Code-OSS）源码构建**。  
产物与安装包脚本约定见 `desktop/scripts/build-win32.ps1`、`packaging/build-installer.ps1`。

## 本机环境检查（清单）

| 依赖 | 要求 | 说明 |
|------|------|------|
| OS | Windows 10/11 x64 | — |
| 磁盘 | 建议 ≥40GB 空闲（E: 盘） | 源码 + node_modules + out |
| Git | 2.x+ | 克隆上游 |
| Node.js | **20+**（推荐 20 LTS） | 与上游 engines 对齐 |
| Python | **3.10+**（3.11/3.12 亦可） | **勿用 3.7**；node-gyp / 原生模块需要 |
| Visual Studio 2022/2026 | Build Tools 或完整版 | 工作负载：**使用 C++ 的桌面开发** + Windows SDK；并勾选 **Spectre 缓解库**（MSVC x64/x86 Spectre-mitigated libs，缺了会 MSB8040） |
| npm | 随 Node.js 自带 | **vscode 1.96+ 已弃用 yarn**，在 `desktop/vscode` 内用 `npm ci` |
| node-gyp | ≥12.1.0（脚本会装到 `desktop/.tools`） | 系统自带 npm 的 node-gyp 往往过旧，**认不出 VS 2026** |

### 包管理器说明

仓库根目录锁定 **pnpm**（`packageManager` 字段）。  
Code-OSS 源码在 `desktop/vscode`，请用 **npm**（勿用根目录 yarn/corepack，会被 pnpm 字段拦截）。

**Visual Studio 生成工具 2026** 可用；`build-win32.ps1` 会用本地 `npm@11.6+/node-gyp@12.1+` 探测，并导入 `vcvars64`。  
若仍报 MSB8040，在安装器「单个组件」中勾选 Spectre 缓解库，或依赖脚本自带的 `disable-spectre.props`。

### 类型隔离（必看）

仓库根目录若装了扩展用的 `@types/vscode`（例如 1.125），TypeScript 会沿 `node_modules` 向上解析，**盖住** Code-OSS 1.96 自带的 `src/vscode-dts`，全量 gulp 会出现几十个 ExtHost / `vscode.d.ts` 冲突。  
`ensure-local-vscode-types.ps1`（**必须在 npm install 之后**调用）会：
- 在 `desktop/vscode/node_modules/@types/vscode` 与 `extensions/node_modules/@types/vscode` 钉死到本树 `vscode.d.ts`
- 临时隔离仓库根的 `@types/vscode`（gulp 结束后 `restore-parent-vscode-types.ps1` 还原）

Electron 可预取：`node desktop/vscode/build/lib/electron.js x64`（目标版本见 `.npmrc` 的 `target`）。

### 安装 VS Build Tools（若 vswhere 找不到安装）

1. 下载 [Visual Studio Build Tools 2022](https://visualstudio.microsoft.com/zh-hans/downloads/#build-tools-for-visual-studio-2022)
2. 勾选「使用 C++ 的桌面开发」
3. 安装完成后重新打开终端，确认：

```powershell
& "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
```

## 目录结构

```
<repo>/                         # 开源仓库根（例如 E:\Ldcode）
  desktop/
    product/                 # 品牌与默认中文等覆盖（不直接改爆上游）
      product.lingdong.json
      locale.json
    patches/                 # 拷入 vscode 树的一等贡献 / 内置扩展同步
      lingdongPrompt/        # Workbench contrib 骨架源
    scripts/
      sync-product.ps1       # 合并品牌到 desktop/vscode/product.json
      sync-builtin-agent.ps1 # 同步 lingdong-agent → extensions/
      apply-prompt-contrib.ps1
      setup-vscode.ps1       # 浅克隆钉死 tag
      build-win32.ps1        # 完整 Windows 构建
      prepare-zh-cn.ps1      # 默认中文
    vscode/                  # microsoft/vscode 源码（浅克隆，勿手改品牌字段；gitignore）
    out/                     # 构建产物（gitignore）
  vscode-extension/lingdong-agent/   # Agent 开发源（同步为内置扩展）
  scripts/fetch-grok.ps1             # 获取 grok.exe（仓库不携带二进制）
  packaging/build-portable.ps1       # 绿色包
  packaging/build-installer.ps1      # 安装包（只吃 desktop/out）
```

开源用户请优先遵循 **`docs/给大模型的构建与 DIY 指南.md`**（可整份交给大模型执行）。

## 钉死的上游版本

默认 tag：`1.96.4`（可在 `desktop/scripts/setup-vscode.ps1` 的 `-VscodeTag` 修改）。

> 使用 **浅克隆目录** `desktop/vscode`，而不是 git submodule（体积与上游更新节奏更可控）。

## 一键流程

```powershell
# 0) 环境达标后（把路径换成你的仓库根）
cd <repo-root>

# 1) 克隆上游（仅首次或换 tag）
powershell -NoProfile -File desktop\scripts\setup-vscode.ps1

# 2) 同步品牌 / 内置 Agent / Prompt 贡献 / 默认中文
powershell -NoProfile -File desktop\scripts\sync-all.ps1

# 2b) 获取 grok.exe
powershell -NoProfile -File scripts\fetch-grok.ps1 -InstallOfficial -Force

# 3) 构建（约 1 小时级，需 VS C++）
powershell -NoProfile -File desktop\scripts\build-win32.ps1

# 4) 绿色包 / 安装包（需已构建出 desktop\out\win32-x64）
powershell -ExecutionPolicy Bypass -File packaging\build-portable.ps1
powershell -ExecutionPolicy Bypass -File packaging\build-installer.ps1
```

## 验收

1. `desktop\out\win32-x64\Lingdong.exe`（或经 rcedit 改名后的产物）可启动  
2. 菜单为中文（文件 / 编辑 /…）——注意首次启动是英文，见下方「首次启动菜单是英文」  
3. 扩展面板中「灵动 Agent」为内置、无需再装 VSIX  
4. 命令面板存在「灵动 Prompt」占位命令（Workbench 贡献骨架）

## 已知本机缺口（构建前请补齐）

脚本 `desktop/scripts/check-env.ps1` 会打印当前机器状态。常见缺口：

- 未安装 Visual Studio 2022 C++ 工具链（`vswhere` 找不到安装）  
- 默认 `python` 若指向 3.7，构建脚本会优先改用 `%LOCALAPPDATA%\Programs\Python\Python310\python.exe`  
- 未 `corepack enable`

补齐前 `build-win32.ps1` 应直接失败并给出提示，而不是编到一半才报错。

## 当前仓库已完成的接线（无需再手工搭目录）

| 项 | 状态 |
|----|------|
| `desktop/vscode` @ tag `1.96.4` | 已浅克隆 |
| `product.json` 灵动品牌合并 | `sync-product.ps1` |
| 内置 `extensions/lingdong-agent` | `sync-builtin-agent.ps1` |
| 中文语言包 + `locale.json` 模板 | `prepare-zh-cn.ps1` |
| Workbench `contrib/lingdongPrompt` | `apply-prompt-contrib.ps1` |
| 安装包主路径改源码产物 | `packaging/build-installer.ps1` |

**完整编译**仍需本机安装 VS 2022 C++ 后执行 `desktop/scripts/build-win32.ps1`（本机实测约 65 分钟）。

## 构建脚本里几个别再踩的坑

一次全量编译要一小时，所以踩坑的代价是按小时计的。以下三条都实测发生过，现已在脚本里堵住：

**localize 的参数必须写成字面量。** 构建末尾的 NLS 抽取会拿参数在源码里的原文直接 `eval`，
传变量会报 `xxx is not defined`。它排在流水线最后，编译一小时后才炸。
现在 `check-nls-literals.mjs` 会在 gulp 之前用 TypeScript AST 秒级判掉，写补丁前不必自己记着。

**别让原生命令的 stdout 混进 PowerShell 函数返回值。** `Invoke-LingdongNpm` 曾经写成
`& node ...` 后直接 `return $LASTEXITCODE`，于是返回的是"输出行 + 退出码"的数组；
调用方 `if ($code -ne 0)` 在数组上的语义是"筛出非零元素"，非空即真——
**成功的构建被判成失败，同时全部 gulp 日志被吞掉**，现场表现为"无声失败"，极难定位。
现在统一 `| Out-Host` 后再 return。给外部命令套壳时都要注意这一点。

**收尾步骤失败不必重编译。** `build-win32.ps1 -UseExistingBuild` 会跳过 gulp，
复用现有 `VSCode-win32-x64` 只跑拷贝和原生模块补齐。代价是不校验产物是否由当前源码编译，
自己负责。另外该脚本默认只接受本次构建新生成的输出，不会再像以前那样静默捡起上一次的旧目录去打包。

## 出包

两条命令，都不需要重编译（前提是 `desktop/out/win32-x64` 已就位）：

```powershell
powershell -ExecutionPolicy Bypass -File packaging\build-portable.ps1   # 绿色包 zip
powershell -ExecutionPolicy Bypass -File packaging\build-installer.ps1  # 安装包 exe
```

`build-portable.ps1` 出包前会自检：`grok.exe`、`@parcel/watcher` 原生模块、中文语言包、
内置扩展、以及产物里工作区信任的默认值，缺任何一项直接失败不出包。
这几样以前是手工补的，漏掉的表现都不像"打包出错"——而是用户装完发现 Agent 起不来、
或者编辑器感知不到文件变化。

**用户配置落点（2026-08-09）**：绿色包**不再预置**包内 `data/`。配置默认在
`%APPDATA%\Lingdong`，换包不解压丢 Key/工作区。包内带 `启动灵动Code.cmd`、
`迁移旧配置.cmd`、`使用说明.txt`。若目录里手动建了空 `data/`，仍可走旧便携模式。

## 待修缺陷：首次启动菜单是英文

**现象**：全新用户第一次打开，编辑器外壳（菜单、命令面板、设置页）是英文；关掉重开才变中文。
Agent 面板不受影响——那些文案是扩展里直接写的中文，不走 VS Code 的 NLS。

**实测**（2026-08-09，全新 `--user-data-dir`，产物 commit `cd4ee3b1`）：

| 场景 | 菜单栏 |
|------|--------|
| 全新用户数据，第 1 次启动 | `File Edit View Help` |
| 同一份数据，第 2 次启动 | `文件(F) 编辑(E) 查看(V) 帮助(H)` |
| 全新数据 + 预置 `languagepacks.json`，第 1 次启动 | `文件(F) 编辑(E) 查看(V) 帮助(H)` |

**成因**：语言解析在主进程启动早期就完成，读的是用户数据目录里的 `languagepacks.json`。
这个索引要等扩展扫描跑完才会生成，所以第一次必然读不到，回退英文；扫描随后把索引写好，
第二次启动就正常。`argv.json` 的 `locale` 和语言包文件本身都是好的，不是配置丢失。

**连带现象**：该索引里存的是**绝对路径**，指向 `resources\app\extensions\
ms-ceintl.vscode-language-pack-zh-hans\translations\*.i18n.json`。因此**重命名或移动安装目录
也会触发同样的一次英文**（索引失效 → 回退 → 修好 → 下次恢复）。开发时给产物目录改名会遇到。

**修法**（第 3 行已验证可行）：在知道安装位置之后生成 `languagepacks.json` 落到用户数据目录。
不能在构建时打进包里——路径是机器相关的。可选落点：安装包走 Inno Setup 装完后的步骤；
绿色包走一个按自身位置生成的首运行引导。捆绑的扩展集合是固定的，所以其中的 `hash` 字段
跨机器稳定，只有路径需要替换。

**状态**：未修，已知情。优先级由发布节奏决定——影响的是新用户第一印象，不影响功能。

**2026-08-09 补充**：已在 0.1.0 正式发行物（绿色包）上复现，不只是测试用户数据目录的现象。
另外菜单栏现在混着灵动自己的中文条目（`文件 > 首选项` 下那三条），首启时和英文原生条目并排，
观感比纯英文更差。绿色包这一侧尤其别指望"构建时预置索引"能解决：用户解压到哪个目录事先不可知，
预置的绝对路径必然失效，回落行为和现在完全一样。
