# 绿色包说明（给不想编译的用户）

「绿色包」就是一个 zip 压缩包：解压后双击就能用，**不用安装、不用编译**。

## 文件名

| 文件 | 大约大小 | 说明 |
|------|----------|------|
| `LingdongCode-0.1.0-oss-portable.zip` | ~192 MB | Windows 64 位预编译包 |

请到仓库的 **[Releases](https://github.com/LingdongLab/lingdong-code/releases)** 下载。  
本目录也可以由维护者在本机放一份同名 zip，方便上传；zip **不会**进 git（太大了）。

## 使用步骤（小白版）

1. **下载**上述 zip。  
2. **解压**到例如 `D:\LingdongCode`（避开 `C:\Program Files`）。  
3. 进入解压出的 `Lingdong` 文件夹。  
4. 双击 **`Lingdong.exe`**，或 **`启动灵动Code.cmd`**。  
5. 若系统拦截，选「仍要运行」。  
6. **打开一个文件夹**（你的项目）。  
7. 在设置里填写模型 **API Key**（如 DeepSeek）。  
8. 发一句「你好」试对话。

配置默认保存在：`%APPDATA%\Lingdong`（换包通常不用重配 Key）。

完整界面说明：[灵动Code 使用手册](../docs/灵动Code%20使用手册.md)。

## 维护者：如何发布到 GitHub

1. 先打出 zip（或从 `.build\out\` 复制到本目录）。  
2. 网页上传：仓库 → Releases → Draft a new release → 挂上 zip → Publish。  
3. 或命令行（需先 `gh auth login`）：

```powershell
powershell -NoProfile -File scripts\publish-github-release.ps1 -Tag v0.1.0
```
