@echo off
setlocal
cd /d "%~dp0"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NoExit -ExecutionPolicy Bypass -File "%~dp0tools\launch.ps1" -Mode admin
echo.
echo The launcher has ended. Review the message above before closing.
pause
