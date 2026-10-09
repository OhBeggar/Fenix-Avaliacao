$ErrorActionPreference = 'Stop'
$runtimeRoot = Join-Path $PSScriptRoot '.runtime'
$nodeRoot = Join-Path $runtimeRoot 'node-v24.20.0-win-x64'
$nodeExe = Join-Path $nodeRoot 'node.exe'
$pm2Cli = Join-Path $runtimeRoot 'pm2\node_modules\pm2\bin\pm2'
$ecosystem = Join-Path $PSScriptRoot 'ecosystem.config.js'
$env:PM2_HOME = Join-Path $PSScriptRoot '.pm2'
$env:PATH = $nodeRoot + ';' + $env:PATH
Set-Location -LiteralPath $PSScriptRoot
try {
    if (!(Test-Path -LiteralPath $nodeExe) -or !(Test-Path -LiteralPath $pm2Cli) -or !(Test-Path -LiteralPath $ecosystem)) {
        throw 'Runtime Node, PM2 ou ecosystem.config.js não encontrado.'
    }

    & $nodeExe $pm2Cli startOrRestart $ecosystem --only avali --update-env
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    & $nodeExe $pm2Cli save
    exit $LASTEXITCODE
} catch {
    $_ | Out-String | Add-Content -LiteralPath (Join-Path $PSScriptRoot 'logs\pm2-startup-error.log')
    exit 1
}
