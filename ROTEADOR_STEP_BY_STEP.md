# Configuração do roteador para a avaliação

Este guia serve para configurar o roteador dedicado da avaliação em qualquer PC ou notebook que vá hospedar o sistema.

## Dados atuais do roteador

- Endereço do roteador: `http://192.168.1.7`
- Usuário do roteador: `admin`
- Senha do roteador: `Fenix@Router2026`
- Nome da rede Wi-Fi: `Fenix-Avaliacao`
- Senha da rede Wi-Fi: `Fenix@Avaliacao2026`
- Porta do sistema: `5000`

## Como funciona

O roteador guarda a configuração da rede Wi-Fi e da senha. Então, mesmo usando outro PC ou notebook, a rede `Fenix-Avaliacao` continua existindo.

O que muda de um computador para outro é o IP do servidor da avaliação. Por isso, quando trocar o PC/notebook que vai rodar o sistema, é preciso confirmar o IP e, se possível, criar uma reserva DHCP para esse novo computador.

## 1. Conectar o PC ao roteador

1. Ligue o roteador.
2. Conecte o PC/notebook ao roteador por cabo de rede ou pela rede Wi-Fi `Fenix-Avaliacao`.
3. Se possível, prefira cabo de rede no computador que vai hospedar o sistema. É mais estável.

## 2. Descobrir o IP e o MAC do PC servidor

No PC que vai hospedar o sistema, abra o PowerShell e rode:

```powershell
Get-NetIPConfiguration | Select-Object InterfaceAlias,IPv4Address,IPv4DefaultGateway | Format-List
```

Procure o `IPv4Address`. Exemplo:

```text
IPv4Address: 192.168.1.16
```

Depois rode:

```powershell
Get-NetAdapter | Where-Object {$_.Status -eq 'Up'} | Select-Object Name,MacAddress,LinkSpeed | Format-List
```

Procure o `MacAddress`. Exemplo:

```text
MacAddress: C8-7F-54-D0-A6-DA
```

Guarde esses dois valores:

- IP do servidor: `192.168.1.x`
- MAC do servidor: `XX-XX-XX-XX-XX-XX`

## 3. Criar reserva DHCP no roteador

A reserva DHCP faz o roteador entregar sempre o mesmo IP para aquele PC/notebook.

1. Acesse `http://192.168.1.7`.
2. Faça login:
   - Usuário: `admin`
   - Senha: `Fenix@Router2026`
3. Vá em `SETUP`.
4. Entre em `Local Network`.
5. Procure a seção `Static DHCP`.
6. Em `IP Address`, coloque o IP do PC servidor. Exemplo:
   - `192.168.1.16`
7. Em `MAC Address`, coloque o MAC do PC servidor separado em blocos. Exemplo:
   - `C8`
   - `7F`
   - `54`
   - `D0`
   - `A6`
   - `DA`
8. Clique em `Add`.

Depois disso, reinicie a conexão de rede do PC ou reinicie o roteador se o IP não atualizar.

## 4. Configurar o arquivo `.env`

No arquivo `.env`, confirme estes valores:

```env
PORT=5000
HOST=0.0.0.0
PUBLIC_BASE_URL=http://IP_DO_SERVIDOR:5000
ADMIN_PASSWORD=audi1234
EVALUATOR_ONLINE_WINDOW_MINUTES=15
```

Exemplo se o PC servidor for `192.168.1.16`:

```env
PUBLIC_BASE_URL=http://192.168.1.16:5000
```

## 5. Liberar o Firewall do Windows

Se outros celulares/notebooks não conseguirem abrir o sistema, provavelmente o Windows está bloqueando a porta `5000`.

Abra o PowerShell como Administrador e rode:

```powershell
New-NetFirewallRule -DisplayName "Avaliacao Fenix Server TCP 5000" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 5000 -Profile Private
```

Se a regra já existir, não precisa criar outra.

## 6. Iniciar o sistema

Na pasta do projeto, rode:

```powershell
npm start
```

Ou use o arquivo:

```text
start.bat
```

O servidor deve mostrar endereços parecidos com:

```text
Servidor rodando. Acesse por:
- http://localhost:5000
- http://192.168.1.16:5000
```

O link para os avaliadores será:

```text
http://IP_DO_SERVIDOR:5000
```

## 7. Testar com outro aparelho

1. Conecte um celular ou notebook na rede `Fenix-Avaliacao`.
2. Abra o navegador.
3. Acesse o link do sistema. Exemplo:

```text
http://192.168.1.16:5000
```

Se abrir a tela inicial do sistema, a rede está pronta.

## 8. Encerrar a sessão da avaliação

No final da avaliação:

1. Acesse `/admin`.
2. Entre com a senha administrativa do sistema.
3. Clique em `Encerrar sessão atual`.

Isso zera os avaliadores online, mas não apaga notas nem candidatos.

## Checklist rápido no dia da avaliação

- Roteador ligado.
- PC servidor conectado ao roteador.
- PC servidor com IP reservado.
- `.env` apontando para o IP correto.
- Firewall liberado na porta `5000`.
- Sistema iniciado com `npm start` ou `start.bat`.
- Celular de teste abre `http://IP_DO_SERVIDOR:5000`.
- Avaliadores conectados na rede `Fenix-Avaliacao`.

## Observações importantes

- O roteador não precisa ter internet para o sistema funcionar.
- A rede Wi-Fi continua configurada no roteador mesmo se trocar de PC.
- Se trocar o PC servidor, refaça a reserva DHCP para o MAC do novo PC.
- O nome `avaliacao.fenix.com` não é criado automaticamente por esse roteador. O acesso mais confiável é pelo IP local, como `http://192.168.1.16:5000`.
- Não use `admin/admin` no roteador. Essa senha já foi substituída por segurança.
