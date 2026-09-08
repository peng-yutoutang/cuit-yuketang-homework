@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================
echo   雨课堂作业面板 - 启动
echo ============================================

REM 1. 启动本地服务（隐藏窗口，端口占用时跳过）。
REM    浏览器统一由服务端启动/复用，避免重复拉起多个 Chrome 窗口。
netstat -ano | findstr ":8500 " | findstr "LISTENING" >nul
if errorlevel 1 (
  start "ykt-dashboard-server" /min /D "%~dp0" cmd /c "node server.js"
) else (
  REM 2. 服务已在运行：让它复用同一个 Chrome 窗口并补齐两个标签页
  powershell -NoProfile -Command "try { Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:8500/api/browser/open' -TimeoutSec 45 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
  if errorlevel 1 (
    echo [提示] 检测到旧服务异常，正在重启本地服务...
    powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
    timeout /t 2 /nobreak >nul
    start "ykt-dashboard-server" /min /D "%~dp0" cmd /c "node server.js"
  )
)

echo.
echo 已启动。Chrome 会以一个窗口打开两个标签页：
echo   1. 雨课堂登录页
echo   2. 作业面板
echo 若未登录，请在雨课堂标签页用手机微信扫码，
echo 然后回到作业面板标签页点击"刷新"。
pause
