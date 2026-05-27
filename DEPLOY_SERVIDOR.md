# 🚀 Guia Definitivo — Deploy do Projeto Avali com Cloudflare Tunnel no Windows

> **Projeto:** Sistema de Avaliação de Bolsistas (`avali`)
> **Domínio:** `https://ohbeggar.us.kg`
> **Stack:** Node.js + Express + EJS + SQLite
> **Infra:** Cloudflare Tunnel + PM2 + Windows Service

---

## 📋 Pré-requisitos

Antes de começar, garanta que o PC servidor tem:

- [ ] Windows 10/11 (64-bit)
- [ ] Node.js instalado → [nodejs.org](https://nodejs.org) (versão LTS)
- [ ] Git instalado → [git-scm.com](https://git-scm.com)
- [ ] Acesso à internet
- [ ] Conta no Cloudflare → [cloudflare.com](https://cloudflare.com)
- [ ] Domínio registrado (ex: `ohbeggar.us.kg`) já adicionado ao Cloudflare

---

## PARTE 1 — Preparar o Projeto

### 1.1 — Copiar o projeto para o servidor

Copie a pasta do projeto para o servidor. Recomenda-se colocar em:
```
E:\0IA\avali
```
ou qualquer caminho sem espaços.

### 1.2 — Instalar dependências do projeto

Abra o CMD na pasta do projeto:
```bash
cd E:\0IA\avali
npm install
```

### 1.3 — Configurar o arquivo `.env`

Copie o `.env.example` para `.env` e edite:
```bash
copy .env.example .env
```

Conteúdo do `.env`:
```env
PORT=5000
HOST=0.0.0.0
PUBLIC_BASE_URL=https://ohbeggar.us.kg
ADMIN_PASSWORD=sua-senha-aqui
ADMIN_COOKIE_SECRET=um-segredo-longo-e-aleatorio-aqui
EVALUATOR_ONLINE_WINDOW_MINUTES=30
```

> ⚠️ **Importante:** `PUBLIC_BASE_URL` deve ser o domínio final. Isso é exibido no QR Code ao iniciar o servidor.

### 1.4 — Testar o servidor localmente

```bash
cd E:\0IA\avali
node app.js
```

Acesse `http://localhost:5000` no navegador. Se aparecer a tela de login, está funcionando. Pressione `Ctrl+C` para parar.

---

## PARTE 2 — Instalar o Cloudflared

### 2.1 — Baixar o cloudflared

Acesse: [https://github.com/cloudflare/cloudflared/releases/latest](https://github.com/cloudflare/cloudflared/releases/latest)

Baixe o arquivo: `cloudflared-windows-amd64.exe`

Renomeie para `cloudflared.exe` e mova para:
```
C:\Windows\System32\cloudflared.exe
```

Verifique a instalação:
```bash
cloudflared --version
```

---

## PARTE 3 — Configurar o Cloudflare Tunnel

### 3.1 — Fazer login no Cloudflare

```bash
cloudflared tunnel login
```

> Vai abrir o navegador. Faça login e **selecione o domínio** `ohbeggar.us.kg`. Isso salva o certificado em `C:\Users\SeuUsuário\.cloudflared\cert.pem`.

### 3.2 — Criar o tunnel

```bash
cloudflared tunnel create avali
```

Anote o **UUID** gerado (ex: `560d6e00-118f-4912-80d6-f780d74abe22`). O arquivo de credenciais fica em:
```
C:\Users\SeuUsuário\.cloudflared\<UUID>.json
```

### 3.3 — Criar o arquivo de configuração

Crie o arquivo `C:\Users\SeuUsuário\.cloudflared\config.yml`:

```yaml
tunnel: 560d6e00-118f-4912-80d6-f780d74abe22
credentials-file: C:\Users\SeuUsuário\.cloudflared\560d6e00-118f-4912-80d6-f780d74abe22.json

ingress:
  - hostname: ohbeggar.us.kg
    service: http://localhost:5000
  - service: http_status:404
```

> ⚠️ Substitua `SeuUsuário` e o UUID pelos seus valores reais.

### 3.4 — Apontar o DNS

```bash
cloudflared tunnel route dns avali ohbeggar.us.kg
```

Saída esperada:
```
INF Added CNAME ohbeggar.us.kg which will route to this tunnel tunnelID=560d6e00-...
```

### 3.5 — Testar o tunnel manualmente

Em um terminal, suba o servidor:
```bash
cd E:\0IA\avali
node app.js
```

Em outro terminal, suba o tunnel:
```bash
cloudflared tunnel run avali
```

Acesse `https://ohbeggar.us.kg` no navegador. Se aparecer a tela do sistema, está funcionando!

---

## PARTE 4 — Instalar o Cloudflare Tunnel como Serviço do Windows

> Isso faz o tunnel subir automaticamente com o Windows, sem precisar de terminal aberto.

### 4.1 — Abrir PowerShell como Administrador

Pressione `Win + S` → digite `PowerShell` → clique com botão direito → **Executar como administrador**.

### 4.2 — Instalar o serviço

```powershell
cloudflared service install
Start-Service cloudflared
```

Saída esperada:
```
INF cloudflared agent service is installed windowsServiceName=Cloudflared
INF Agent service for cloudflared installed successfully windowsServiceName=Cloudflared
```

### 4.3 — Verificar se o serviço está rodando

```powershell
Get-Service cloudflared
```

O status deve ser `Running`.

---

## PARTE 5 — Instalar o PM2 para manter o Node.js sempre rodando

### 5.1 — Instalar o PM2 globalmente

```bash
npm install -g pm2
```

### 5.2 — Verificar o `ecosystem.config.js`

O arquivo `E:\0IA\avali\ecosystem.config.js` deve ter:

```javascript
module.exports = {
  apps: [{
    name: "avali",
    script: "app.js",
    cwd: "E:\\0IA\\avali",
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: "2G",
    env: {
      NODE_ENV: "production",
      PORT: 5000,
      HOST: "0.0.0.0"
    },
    error_file: "logs\\err.log",
    out_file: "logs\\out.log",
    log_date_format: "YYYY-MM-DD HH:mm:ss"
  }]
}
```

### 5.3 — Iniciar o app com PM2

```bash
cd E:\0IA\avali
pm2 start ecosystem.config.js
pm2 save
```

Saída esperada:
```
[PM2] App [avali] launched (1 instances)
status: online
```

---

## PARTE 6 — Configurar PM2 para subir automático no boot do Windows

> O `pm2 startup` não funciona no Windows. Use o Agendador de Tarefas via PowerShell.

### 6.1 — Abrir PowerShell como Administrador e registrar a tarefa

```powershell
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument '/c "pm2 resurrect"'
$trigger = New-ScheduledTaskTrigger -AtLogon
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0
Register-ScheduledTask -TaskName "PM2-avali" -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest -Force
```

Saída esperada:
```
TaskName  State
--------  -----
PM2-avali Ready
```

---

## PARTE 7 — Verificação Final

Reinicie o computador e verifique:

1. Aguarde 1-2 minutos após o boot
2. Acesse `https://ohbeggar.us.kg` no navegador de outro dispositivo
3. O sistema deve carregar normalmente

Para verificar o status dos processos:
```bash
# Ver status do app Node.js
pm2 status

# Ver status do tunnel Cloudflare
Get-Service cloudflared

# Ver logs do app
pm2 logs avali
```

---

## 🔄 Fluxo Completo Após o Boot

```
Windows inicia
    │
    ├──► Cloudflare Tunnel (Serviço do Windows) ──► automático
    │
    └──► Agendador de Tarefas (PM2-avali)
              │
              └──► pm2 resurrect ──► app avali online na porta 5000
                        │
                        └──► https://ohbeggar.us.kg ──► 🌐 Online!
```

---

## 🛠️ Comandos Úteis do Dia a Dia

```bash
# Ver status do app
pm2 status

# Ver logs em tempo real
pm2 logs avali

# Reiniciar o app
pm2 restart avali

# Parar o app
pm2 stop avali

# Atualizar após mudanças no código
pm2 restart avali

# Ver status do tunnel
Get-Service cloudflared

# Reiniciar o tunnel (PowerShell Admin)
Restart-Service cloudflared

# Parar o tunnel (PowerShell Admin)
Stop-Service cloudflared
```

---

## ⚠️ Problemas Comuns e Soluções

| Problema | Causa | Solução |
|---|---|---|
| Site abre `Error 1033` | Tunnel está parado | `Start-Service cloudflared` (Admin) |
| Site abre `502 Bad Gateway` | Node.js não está rodando | `pm2 resurrect` ou `pm2 start ecosystem.config.js` |
| `Authentication error` no route dns | Domínio não está no Cloudflare | Adicionar domínio em dash.cloudflare.com |
| `tunnel with name already exists` | Tunnel já foi criado antes | Use `cloudflared tunnel list` para ver e pular o `create` |
| `Acesso negado` no service install | Não é administrador | Abrir PowerShell como Administrador |
| `cert.pem` bloqueando login | Certificado antigo existe | `del C:\Users\SeuUsuário\.cloudflared\cert.pem` depois refaça o login |
| PM2 EPERM no Windows | Conflito de permissão | `pm2 kill` depois `pm2 start ecosystem.config.js` no CMD normal |

---

## 📁 Arquivos Importantes

| Arquivo | Localização | Função |
|---|---|---|
| `config.yml` | `C:\Users\SeuUsuário\.cloudflared\` | Configuração do tunnel |
| `<UUID>.json` | `C:\Users\SeuUsuário\.cloudflared\` | Credenciais do tunnel |
| `cert.pem` | `C:\Users\SeuUsuário\.cloudflared\` | Certificado de login |
| `.env` | `E:\0IA\avali\` | Variáveis de ambiente do app |
| `ecosystem.config.js` | `E:\0IA\avali\` | Configuração do PM2 |
| `dump.pm2` | `C:\Users\SeuUsuário\.pm2\` | Lista salva de processos PM2 |

---

*Guia gerado em 17/05/2026 — Sistema de Avaliação Fênix*
