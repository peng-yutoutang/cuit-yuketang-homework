@echo off
chcp 65001 >nul

echo 正在清理登录浏览器的缓存（登录状态会保留）...
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'chrome.exe' -or $_.Name -eq 'msedge.exe') -and $_.CommandLine -like '*chrome-profile*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
timeout /t 2 /nobreak >nul
powershell -NoProfile -Command "$r='%~dp0chrome-profile'; 'Variations','Safe Browsing','component_crx_cache','WasmTtsEngine','extensions_crx_cache','GrShaderCache','ShaderCache','GPUPersistentCache','Crashpad','BrowserMetrics','optimization_guide_model_store' | ForEach-Object { Remove-Item (Join-Path $r $_) -Recurse -Force -ErrorAction SilentlyContinue }; 'Cache','Code Cache','GPUCache' | ForEach-Object { Remove-Item (Join-Path $r ('Default\'+$_)) -Recurse -Force -ErrorAction SilentlyContinue }"

echo 完成。下次打开面板时会自动重新启动登录窗口。
pause

