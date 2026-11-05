@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set "NODE=node"
where node >nul 2>&1
if errorlevel 1 set "NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not exist "dist\index.html" (
  echo アプリのビルドがありません。READMEの手順を確認してください。
  pause
  exit /b 1
)
echo 教室予約アプリを起動します。
echo 表示されたURLをブラウザで開いてください。停止は Ctrl+C です。
"%NODE%" tools\serve.mjs
pause
