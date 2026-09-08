@echo off
chcp 65001 >nul

echo 正在停止本地服务...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

echo 本地服务已停止。Chrome 窗口请自行关闭（登录状态会保留）。
pause
