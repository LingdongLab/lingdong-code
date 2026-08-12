@echo off
chcp 65001 >nul
setlocal
set "ROOT=%~dp0"
set "APP_DATA=%APPDATA%\Lingdong"
set "EXE=%ROOT%Lingdong.exe"

if not exist "%EXE%" (
  echo 找不到 Lingdong.exe，请把本脚本放在绿色包根目录。
  pause
  exit /b 1
)

REM 包内若仍有 data\（旧便携布局），优先沿用，避免误开空的 AppData。
if exist "%ROOT%data\user-data" (
  start "" "%EXE%"
  exit /b 0
)

REM 默认：稳定用户目录，换包不丢模型/工作区。
if not exist "%APP_DATA%\User" mkdir "%APP_DATA%\User" >nul 2>&1
if not exist "%APP_DATA%\User\argv.json" if exist "%ROOT%defaults\argv.json" (
  copy /Y "%ROOT%defaults\argv.json" "%APP_DATA%\User\argv.json" >nul
)
if not exist "%APP_DATA%\locale.json" if exist "%ROOT%defaults\locale.json" (
  copy /Y "%ROOT%defaults\locale.json" "%APP_DATA%\locale.json" >nul
)

start "" "%EXE%"
endlocal
