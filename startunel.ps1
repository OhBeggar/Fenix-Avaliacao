# Mostra notificação do Windows
[reflection.assembly]::loadwithpartialname('System.Windows.Forms') | Out-Null
[reflection.assembly]::loadwithpartialname('System.Drawing') | Out-Null
$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = [System.Drawing.SystemIcons]::Information
$notify.Visible = $true
$notify.ShowBalloonTip(3000, 'StartUnel', "Tunnel 'avali' iniciando...", [System.Windows.Forms.ToolTipIcon]::Info)

# Espera 3s pra você ver a notificação
Start-Sleep -Seconds 3

# Fecha a notificação
$notify.Dispose()

# Sobe o cloudflared escondido em segundo plano
Start-Process -FilePath "cloudflared.exe" `
    -ArgumentList "tunnel", "run", "avali" `
    -WindowStyle Hidden