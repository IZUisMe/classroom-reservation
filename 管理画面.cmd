@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set "NODE=node"
where node >nul 2>&1
if errorlevel 1 set "NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
echo 教室写真の管理画面を起動します。
echo http://127.0.0.1:4174 をブラウザで開いてください。
echo このPC専用です。停止は Ctrl+C です。
"%NODE%" tools\admin-server.mjs
pause
