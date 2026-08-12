# Grok Build 源码构建（可选）

> 开源默认路径是 **官方预编译**：`scripts/fetch-grok.ps1`（见 `grok/README.md`）。  
> 仅当你要改 Agent 引擎内核、打补丁或离线自建时，才需要本文。

## 上游

- 公告：https://x.ai/news/grok-build-open-source
- 仓库：https://github.com/xai-org/grok-build （Apache-2.0）
- 官方安装（预编译）：`irm https://x.ai/cli/install.ps1 | iex`

本仓库**不** vendor 完整 `grok-src`。请自行克隆到仓库外或本地任意目录（建议不要提交进本 git）。

## 建议 pin

实测可工作的上游 commit（2026-08-09）：`75e73f3d6ac0350d211f12ae7d57c2c0aad72576`  
Rust 工具链以仓库内 `rust-toolchain.toml` 为准（曾钉 `1.94.0`）。  
入口 crate：`crates/codegen/xai-grok-pager-bin`（产物名 `xai-grok-pager`）。

## 构建步骤（Windows x64 摘要）

```powershell
# 安装 Rust（MSVC 链接器用本机 VS Build Tools）
Invoke-WebRequest https://win.rustup.rs/x86_64 -OutFile "$env:TEMP\rustup-init.exe"
& "$env:TEMP\rustup-init.exe" -y --default-toolchain stable --profile minimal

# 若 crates.io / static.rust-lang.org 很慢，自行配置 rustup / cargo 镜像

git clone --depth 1 https://github.com/xai-org/grok-build.git grok-src
cd grok-src
# 可选：git fetch / checkout 75e73f3d6ac0350d211f12ae7d57c2c0aad72576

# Windows 需要可用的 protoc（仓库自带的 bin/protoc 可能是 Linux 包装）
# 设置 $env:PROTOC = "<protoc.exe 完整路径>"

cargo build -p xai-grok-pager-bin --release
# 产物：target\release\xai-grok-pager.exe
```

装入本仓库：

```powershell
powershell -NoProfile -File scripts\fetch-grok.ps1 -FromPath <path-to>\xai-grok-pager.exe -Force
```

若版本号不是 `packages/agent-runtime` 里的 `TESTED_GROK_VERSION`，启动可能提示「未测试版本」——把常量改成你的版本即可。

## Windows 兼容提示

部分上游版本在 `xai-proto-build` 里把依赖清单写到 `/dev/stdout`，Windows 会失败。若遇到，需在 vendor 源码里改为临时文件 / `nul`（自行维护补丁；升级上游时检查是否已修复）。

## 与官方预编译的关系

| 通道 | 说明 |
|------|------|
| `fetch-grok.ps1` / install.ps1 | 稳定预编译，开源默认 |
| 本文自建 | 可打补丁、可钉 commit；体积与编译时间显著更大 |

出包脚本只认 `grok\bin\grok.exe`，不关心它来自官方还是自建。
