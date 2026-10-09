@echo off
setlocal
title Reiniciar Avali (PM2)

:: O PM2 do Avali sobe pelo Agendador de Tarefas com permissoes elevadas.
:: Um terminal comum recebe "connect EPERM \\.\pipe\rpc.sock". Este script pede
:: permissao de administrador sozinho (janela do Windows) e reinicia o app.

net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Solicitando permissao de administrador...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

cd /d "%~dp0"
echo.
echo === Instalando dependencias (necessario para o login por biometria) ===
if exist "%~dp0.runtime\node-v24.20.0-win-x64\npm.cmd" (
    call "%~dp0.runtime\node-v24.20.0-win-x64\npm.cmd" install --no-audit --no-fund
) else (
    call npm install --no-audit --no-fund
)

echo.
echo === Reiniciando o app "avali" ===
call "%~dp0pm2.cmd" restart avali --update-env
if %errorlevel% neq 0 (
    echo.
    echo O app nao estava registrado no PM2. Iniciando pelo ecosystem.config.js...
    call "%~dp0pm2.cmd" start ecosystem.config.js
    call "%~dp0pm2.cmd" save
)

echo.
call "%~dp0pm2.cmd" status

echo.
echo === Ultimas linhas do log ===
timeout /t 3 >nul
call "%~dp0pm2.cmd" logs avali --lines 15 --nostream

echo.
echo Pronto. Se aparecer erro acima, copie e me mande.
pause
