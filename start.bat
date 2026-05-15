@echo off
cd /d %~dp0
echo Instalando dependencias...
call npm install
echo.
echo Dica: conecte os avaliadores na mesma rede Wi-Fi deste computador.
echo O servidor vai mostrar abaixo os enderecos de acesso na rede local.
echo.
echo Iniciando servidor...
call npm start
pause
