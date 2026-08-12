; 灵动 Code 的 Windows 安装脚本（用户级安装，不需要管理员）。
; 由 build-installer.ps1 传入 AppVersion / StageDir / OutputDir / BrandIcon 后用 ISCC 编译。
;
; 有意从简：不注册文件关联、不加资源管理器右键菜单、不写 PATH。
; 这一版要回答的问题只有一个——干净机器上装完能不能跑起来完成一次对话。

#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif

#define AppName "灵动 Code"
#define AppNameAscii "Lingdong Code"
#define AppExe "Lingdong.exe"
#define AppPublisher "灵动 Code"

[Setup]
AppId={{1779EE80-562B-47AD-A2EC-805119E7DAD0}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={localappdata}\Programs\{#AppNameAscii}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
; 用户级安装：不弹 UAC，装到 %LOCALAPPDATA% 下。
PrivilegesRequired=lowest
OutputDir={#OutputDir}
OutputBaseFilename=LingdongCodeSetup-{#AppVersion}
SetupIconFile={#BrandIcon}
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={#AppName}
Compression=lzma2/max
SolidCompression=yes
; 基座是 x64 的，32 位系统上直接拦住而不是装完再崩。
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
WizardStyle=modern
; 包体 700 MB 上下，磁盘检查按实际来。
DirExistsWarning=no

[Languages]
Name: "chinese"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加任务:"

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{userdesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; Description: "立即启动 {#AppName}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; 卸载时清掉运行期生成的内容，否则会留下空目录。
Type: filesandordirs; Name: "{app}"
