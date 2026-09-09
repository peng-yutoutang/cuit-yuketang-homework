@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================
echo   雨课堂作业面板 - 启动
echo ============================================

REM ---------- 1. 检查 Node.js 环境 ----------
where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo [错误] 未检测到 Node.js。本工具需要 Node.js 22 或更高版本。
  echo 请打开 https://nodejs.org/zh-cn 下载并安装最新 LTS 版本，
  echo 安装完成后重新双击 start.bat。
  echo.
  pause
  exit /b 1
)

set "NODE_RAW="
for /f "tokens=1 delims=." %%a in ('node -v 2^>nul') do set "NODE_RAW=%%a"
set "NODE_MAJOR=%NODE_RAW:v=%"
if not defined NODE_MAJOR set "NODE_MAJOR=0"
if %NODE_MAJOR% LSS 22 (
  echo.
  echo [错误] 当前 Node.js 版本为 %NODE_RAW%，本工具需要 22 或更高版本。
  echo 请打开 https://nodejs.org/zh-cn 下载并安装最新 LTS 版本，
  echo 安装完成后重新双击 start.bat。
  echo.
  pause
  exit /b 1
)

REM ---------- 2. 启动本地服务（隐藏窗口，日志写入 server.log） ----------
netstat -ano | findstr ":8500 " | findstr "LISTENING" >nul
if errorlevel 1 (
  if exist "server.log" del /q "server.log"
  start "ykt-dashboard-server" /min /D "%~dp0" cmd /c "node server.js >> server.log 2>&1"
) else (
  REM 服务已在运行：让它复用同一个浏览器窗口并补齐两个标签页
  powershell -NoProfile -Command "try { Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:8500/api/browser/open' -TimeoutSec 45 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
  if errorlevel 1 (
    echo [提示] 检测到旧服务异常，正在重启本地服务...
    powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
    timeout /t 2 /nobreak >nul
    if exist "server.log" del /q "server.log"
    start "ykt-dashboard-server" /min /D "%~dp0" cmd /c "node server.js >> server.log 2>&1"
  )
)

REM ---------- 3. 等待面板服务就绪 ----------
powershell -NoProfile -Command "$ok=$false; for($i=0;$i -lt 15;$i++){ try { Invoke-RestMethod -Uri 'http://127.0.0.1:8500/api/status' -TimeoutSec 3 | Out-Null; $ok=$true; break } catch { Start-Sleep -Seconds 1 } }; if($ok){ exit 0 } else { exit 1 }" >nul 2>&1
if errorlevel 1 (
  echo.
  echo [错误] 本地服务未能正常启动，以下是最新的启动日志：
  echo ----------------------------------------
  if exist "server.log" (
    powershell -NoProfile -Command "Get-Content -LiteralPath '%~dp0server.log' -Tail 25"
  ) else (
    echo 没有生成 server.log，可能 node 被杀毒软件拦截。
  )
  echo ----------------------------------------
  echo 常见原因：端口 8500 被占用、目录无写入权限、Node 版本过低。
  echo 可将上述日志发给开发者排查。
  echo.
  pause
  exit /b 1
)

REM ---------- 4. 等待浏览器窗口就绪 ----------
powershell -NoProfile -Command "$ok=$false; for($i=0;$i -lt 40;$i++){ try { $s=Invoke-RestMethod -Uri 'http://127.0.0.1:8500/api/status' -TimeoutSec 5; if($s.browserConnected){ $ok=$true; break } } catch {}; Start-Sleep -Seconds 1 }; if($ok){ exit 0 } else { exit 1 }" >nul 2>&1
if errorlevel 1 (
  echo.
  echo [提示] 面板已启动，但浏览器窗口未能自动打开。
  echo 可手动在浏览器访问 http://127.0.0.1:8500 使用面板。
  echo 最新日志（server.log）：
  echo ----------------------------------------
  if exist "server.log" powershell -NoProfile -Command "Get-Content -LiteralPath '%~dp0server.log' -Tail 10"
  echo ----------------------------------------
)

echo.
echo 已启动。浏览器会以一个窗口打开两个标签页（优先系统默认浏览器）：
echo   1. 雨课堂登录页
echo   2. 作业面板
echo 若未登录，请在雨课堂标签页用手机微信扫码，
echo 然后回到作业面板标签页点击“刷新”。
echo 提示：启动日志保存在 server.log，遇到问题时请提供该文件。
pause
