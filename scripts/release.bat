@echo off
echo 正在运行发布脚本...

:: 尝试终止可能正在运行的Git进程
echo 检查并终止可能正在运行的Git进程...
taskkill /f /im git.exe /t 2>nul
if %ERRORLEVEL% EQU 0 (
  echo Git进程已终止
  ping -n 3 127.0.0.1 > nul
) else (
  echo 未发现正在运行的Git进程
)

:: 运行发布脚本
node "%~dp0release.js"
if %ERRORLEVEL% NEQ 0 (
  echo 发布脚本执行失败，错误代码: %ERRORLEVEL%
  pause
  exit /b %ERRORLEVEL%
)
echo 发布脚本执行成功
pause 
