# desktop — Code-OSS shell for 灵动 Code

完整步骤请优先遵循仓库根目录：

**[docs/给大模型的构建与 DIY 指南.md](../docs/给大模型的构建与 DIY 指南.md)**

细节与踩坑见 [docs/code-oss-build.md](../docs/code-oss-build.md)。

```powershell
# 在仓库根目录执行
powershell -NoProfile -File desktop\scripts\setup-vscode.ps1
powershell -NoProfile -File desktop\scripts\sync-all.ps1
powershell -NoProfile -File ..\scripts\fetch-grok.ps1 -InstallOfficial -Force
powershell -NoProfile -File desktop\scripts\build-win32.ps1
powershell -ExecutionPolicy Bypass -File ..\packaging\build-portable.ps1
```

`desktop/vscode/` 由 `setup-vscode.ps1` 浅克隆，不要提交进 git。
