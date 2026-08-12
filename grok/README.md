# grok/

本目录只放 **Agent 运行时二进制的落点**，不把 exe 和会话数据推进 git。

| 路径 | 说明 |
|------|------|
| `bin/grok.exe` | 打包与扩展启动时查找的可执行文件（gitignore） |
| `bin/.gitkeep` | 保证空目录可被克隆下来 |
| `data/` | **不要创建进仓库**。运行时由 Grok 自己写本机数据；若你在开发机上生成了 `data/`，切勿提交 |

## 获取二进制（推荐）

在仓库根目录执行：

```powershell
powershell -NoProfile -File scripts\fetch-grok.ps1 -InstallOfficial -Force
```

或先官方安装，再复制进仓库：

```powershell
irm https://x.ai/cli/install.ps1 | iex
powershell -NoProfile -File scripts\fetch-grok.ps1 -Force
```

已有文件时：

```powershell
powershell -NoProfile -File scripts\fetch-grok.ps1 -FromPath C:\path\to\grok.exe -Force
```

验收：

```powershell
.\grok\bin\grok.exe --version
```

## 从源码自建（可选）

上游开源仓库：[xai-org/grok-build](https://github.com/xai-org/grok-build)（Apache-2.0）。  
步骤摘要见 [`docs/grok-源码构建.md`](../docs/grok-源码构建.md)。把产物复制为 `grok\bin\grok.exe` 即可被 `packaging/build-portable.ps1` 捆绑。

## 许可证

Grok Build 为 **Apache-2.0**，与本仓库 MIT 代码相互独立。详见根目录 `THIRD_PARTY_NOTICES.md`。
