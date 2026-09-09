@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================
echo   雨课堂作业面板 - 打包发布版
echo ============================================
echo 正在生成发布包（不含登录缓存、本地数据与日志）...
echo.

set "ZIP=%~dp0雨课堂作业面板-发布.zip"
if exist "%ZIP%" del /q "%ZIP%"
tar.exe -a -c -f "%ZIP%" -C "%CD%" server.js package.json start.bat stop.bat clean-cache.bat README.md public lib

if errorlevel 1 (
  echo.
  echo [错误] 打包失败，请确认当前目录可写、且未占用发布包文件。
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -Command "$mb=[math]::Round((Get-Item -LiteralPath '%~dp0雨课堂作业面板-发布.zip').Length/1MB,2); Write-Output ('打包完成，大小约 ' + $mb + ' MB')"

echo.
echo 发布包：雨课堂作业面板-发布.zip
echo 发给对方后，请提醒对方：
echo   1. 先完整解压整个文件夹，再双击 start.bat；
echo   2. 电脑需要安装 Node.js 22 或更高版本。
pause
