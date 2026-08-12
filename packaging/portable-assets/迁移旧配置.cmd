@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
set "ROOT=%~dp0"
set "APP_DATA=%APPDATA%\Lingdong"
set "DEFAULT_OLD=%ROOT%data\user-data"
set "DESKTOP_OLD=%USERPROFILE%\Desktop\Lingdong\data\user-data"

echo.
echo 将把旧绿色包里的用户数据迁到：
echo   %APP_DATA%
echo.
echo 迁完后换新包不必再配模型、不必再加工作区。
echo.

set "SRC="
if exist "%DEFAULT_OLD%\User" set "SRC=%DEFAULT_OLD%"
if not defined SRC if exist "%DESKTOP_OLD%\User" set "SRC=%DESKTOP_OLD%"

if not defined SRC (
  echo 未自动找到旧 data。请把旧安装目录拖到本窗口后回车：
  set /p "CUSTOM="
  if exist "!CUSTOM!\data\user-data\User" set "SRC=!CUSTOM!\data\user-data"
  if exist "!CUSTOM!\user-data\User" set "SRC=!CUSTOM!\user-data"
  if exist "!CUSTOM!\User" set "SRC=!CUSTOM!"
)

if not defined SRC (
  echo 仍找不到可用的旧配置，已取消。
  pause
  exit /b 1
)

echo 来源: %SRC%
echo.

tasklist /FI "IMAGENAME eq Lingdong.exe" 2>nul | find /I "Lingdong.exe" >nul
if not errorlevel 1 (
  echo 请先完全退出灵动 Code，再重试。
  pause
  exit /b 1
)

if exist "%APP_DATA%\User\globalStorage\lingdong.lingdong-agent" (
  echo 目标目录里已有灵动配置。
  choice /C YN /M "要用旧 data 覆盖吗"
  if errorlevel 2 exit /b 0
)

mkdir "%APP_DATA%" >nul 2>&1
echo 正在复制…
xcopy /E /I /Y "%SRC%\*" "%APP_DATA%\" >nul
if errorlevel 1 (
  echo 复制失败。
  pause
  exit /b 1
)

if exist "%ROOT%defaults\argv.json" if not exist "%APP_DATA%\User\argv.json" (
  mkdir "%APP_DATA%\User" >nul 2>&1
  copy /Y "%ROOT%defaults\argv.json" "%APP_DATA%\User\argv.json" >nul
)

echo.
echo 迁移完成。请双击「启动灵动Code.cmd」或 Lingdong.exe。
echo 若包内还有 data 文件夹，可改名为 data.bak，以免继续走旧便携模式。
echo.
pause
endlocal
