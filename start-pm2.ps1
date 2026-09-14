$ErrorActionPreference = 'Stop'
$runtimeRoot = Join-Path $PSScriptRoot '.runtime'
$nodeRoot = Join-Path $runtimeRoot 'node-v24.20.0-win-x64'
$env:PM2_HOME = Join-Path $PSScriptRoot '.pm2'
$env:PATH = $nodeRoot + ';' + $env:PATH
Set-Location -LiteralPath $PSScriptRoot
try {
    & (Join-Path $nodeRoot 'node.exe') (Join-Path $runtimeRoot 'pm2\node_modules\pm2\bin\pm2') resurrect --no-daemon
    exit $LASTEXITCODE
} catch {
    $_ | Out-String | Add-Content -LiteralPath (Join-Path $PSScriptRoot 'logs\pm2-startup-error.log')
    exit 1
}
