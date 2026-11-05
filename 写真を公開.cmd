@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set "NODE=node"
where node >nul 2>&1
if errorlevel 1 set "NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
echo 管理画面で追加した写真をGitHubの公開サイトへ反映します。
echo 写真の掲載許可と、写り込んだ人物・個人情報を確認してください。
choice /C YN /M "公開を開始しますか"
if errorlevel 2 exit /b 0
"%NODE%" tools\publish.mjs
set "RESULT=%ERRORLEVEL%"
echo.
pause
exit /b %RESULT%
