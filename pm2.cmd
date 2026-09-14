@echo off
setlocal
set "PM2_HOME=%~dp0.pm2"
set "PATH=%~dp0.runtime\node-v24.20.0-win-x64;%PATH%"
"%~dp0.runtime\node-v24.20.0-win-x64\node.exe" "%~dp0.runtime\pm2\node_modules\pm2\bin\pm2" %*
exit /b %errorlevel%
