$logDir = Join-Path $PSScriptRoot 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'pm2-startup.log'
function Log($m) {
    try { Add-Content -LiteralPath $log -Value ("{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) } catch {}
}

$runtimeRoot = Join-Path $PSScriptRoot '.runtime'
$nodeRoot = Join-Path $runtimeRoot 'node-v24.20.0-win-x64'
$nodeExe = Join-Path $nodeRoot 'node.exe'
$pm2Cli = Join-Path $runtimeRoot 'pm2\node_modules\pm2\bin\pm2'
$ecosystem = Join-Path $PSScriptRoot 'ecosystem.config.js'
$env:PM2_HOME = Join-Path $PSScriptRoot '.pm2'
$env:PATH = $nodeRoot + ';' + $env:PATH
Set-Location -LiteralPath $PSScriptRoot

Log "Tarefa iniciada (usuario: $env:USERNAME)"

# Espera o sistema (disco D:, rede, servicos) terminar de subir
Start-Sleep -Seconds 20

for ($i = 1; $i -le 3; $i++) {
    try {
        if (!(Test-Path -LiteralPath $nodeExe) -or !(Test-Path -LiteralPath $pm2Cli) -or !(Test-Path -LiteralPath $ecosystem)) {
            throw 'Runtime Node, PM2 ou ecosystem.config.js nao encontrado.'
        }

        $out = & $nodeExe $pm2Cli startOrRestart $ecosystem --only avali --update-env 2>&1 | Out-String
        $code = $LASTEXITCODE
        Log "Tentativa $i - startOrRestart (codigo $code): $out"

        if ($code -eq 0) {
            $out = & $nodeExe $pm2Cli save 2>&1 | Out-String
            Log "pm2 save (codigo $LASTEXITCODE): $out"
            Log 'Concluido com sucesso.'
            exit 0
        }
    } catch {
        Log "Tentativa $i falhou: $($_ | Out-String)"
    }
    Start-Sleep -Seconds 15
}

Log 'Todas as tentativas falharam.'
exit 1
