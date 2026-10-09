# Sistema de Avaliação Fênix

Aplicação web para gestão de turmas, presença, avaliações de bolsistas e consolidação oficial de resultados da **Fênix Dança de Salão** (Rio Branco – Acre).

Os professores lançam notas em tempo real pelo celular, tablet ou computador. A secretaria gerencia turmas, PINs de audição, histórico e exportações (PDF/Excel) pelo painel administrativo.

---

## Funcionalidades

### Professores
- Landing page institucional
- Login com nome + senha
- Login por biometria (digital, rosto ou PIN do celular) depois de ativar no aparelho
- Redefinição de senha por código de 5 dígitos, gerado pela secretaria (validade de 30 min, uso único)
- Seleção de turma e acesso à avaliação mediante PIN de sessão
- Lançamento de notas inteiras de 1 a 10 (ou `X` para item não avaliado), com salvamento sem recarregar a página
- Indicador de avaliadores online (atividade nos últimos 30 min, configurável)
- Professor responsável pela turma: edita presença (total de aulas x aulas presentes) e ritmos avaliados

### Administração (secretaria)
- Dashboard com KPIs (turmas, alunos, professores, sessões ativas)
- Cadastro de professores, turmas e alunos (individual e em lote)
- Geração de PIN de audição e encerramento de sessão
- Página da turma: presença, status (Bolsista/Auxiliar), renomear turma, desvincular aluno
- Resultados ao vivo durante a audição
- Fechamento de semestre com histórico oficial (snapshot congelado)
- Exportação em PDF e Excel (resultados ao vivo e histórico)
- Redefinição de senha de professor (código temporário)
- Tema claro/escuro (preto puro OLED) e interface responsiva

---

## Stack

| Tecnologia | Uso |
|------------|-----|
| Node.js + Express 5 | Backend |
| EJS | Templates |
| SQLite (`node:sqlite`) | Banco de dados |
| pdf-lib | Geração de PDF |
| ExcelJS | Geração de Excel |
| qrcode | QR Code de acesso no terminal ao iniciar |
| CSS moderno | UI (variáveis, claro/escuro, responsivo) |

---

## Requisitos

- Node.js com suporte nativo a `node:sqlite` (recomendado 22.13 ou superior)
- npm

---

## Configuração

1. Instale as dependências:

```bash
npm install
```

2. Crie um arquivo `.env` na raiz (use `.env.example` como base):

```env
PORT=5000
HOST=0.0.0.0
ADMIN_PASSWORD=troque-esta-senha
ADMIN_COOKIE_SECRET=troque-este-segredo
EVALUATOR_ONLINE_WINDOW_MINUTES=30
```

Opcionais:

```env
# URL pública exibida no terminal e no QR Code (ex.: domínio do túnel)
PUBLIC_BASE_URL=
# Caminho do banco (padrão: ./evaluations.db na raiz)
EVALUATIONS_DB_PATH=./evaluations.db

# Login por biometria (WebAuthn). O domínio sai do PUBLIC_BASE_URL (precisa ser https).
# WEBAUTHN_RP_ID=ohbeggar.us.kg
# WEBAUTHN_ORIGINS=https://ohbeggar.us.kg,https://outro-endereco.exemplo
# WEBAUTHN_DISABLED=1
```

Com `NODE_ENV=production`, o servidor **não inicia** se `ADMIN_PASSWORD` tiver menos de 6 caracteres, `ADMIN_COOKIE_SECRET` tiver menos de 32, ou se qualquer um estiver vazio ou com o valor de exemplo.

3. Inicie:

```bash
npm start
```

Acesse `http://localhost:5000`.

---

## Comandos

```bash
npm install    # instala dependências
npm start      # sobe o servidor
npm test       # testes automatizados (node --test)
npm run check  # verificação de sintaxe do app.js
```

O projeto inclui `ecosystem.config.js` para rodar com PM2.

---

## Deploy e acesso público

O ambiente de produção usa **Cloudflare Tunnel** com domínio **DigitalPlat** (`.us.kg`).

Exemplo de URL pública:

```text
https://ohbeggar.us.kg
```

### Como funciona

1. O Node escuta em `HOST=0.0.0.0` e `PORT=5000` (ou a porta definida no `.env`).
2. O `cloudflared` cria o túnel e publica a aplicação na internet com HTTPS.
3. Secretaria e professores acessam pelo domínio, sem precisar de IP local nem arquivo `hosts`.

Se quiser que a URL pública apareça no terminal e no QR Code ao iniciar, defina `PUBLIC_BASE_URL` no `.env`.

### Boas práticas

- Manter o tunnel rodando como serviço (Windows) ou script estável, para não cair ao fechar o terminal.
- Não versionar credenciais do tunnel nem o `.env`.
- Usar senha de admin forte e repositório privado.

### Acesso local (opcional)

Em rede isolada, ainda é possível usar `http://IP-DA-MAQUINA:5000`.
Nome tipo `fenix.local` é opcional e só necessário se não houver internet/túnel.

---

## Rotas principais

| Rota | Acesso | Descrição |
|------|--------|-----------|
| `/` | Público | Landing page |
| `/avaliacao` | Público | Login dos professores |
| `/professor/redefinir-senha` | Público | Redefinição de senha com código |
| `/webauthn/login/options`, `/webauthn/login/verify` | Público | Login por biometria |
| `/webauthn/register/*`, `/webauthn/credentials*` | Professor | Ativar, listar e remover aparelhos |
| `/admin/teacher/webauthn/revoke` | Admin | Revogar a biometria de um professor |
| `/admin/webauthn/register/*`, `/admin/webauthn/credentials*` | Admin | Ativar, listar e remover aparelhos do admin |
| `/admin/webauthn/login/*` | Público | Login do admin por biometria |
| `/turmas/:nome` | Professor | Seleção de turmas |
| `/turmas/:nome/:turmaId` | Professor | Sala da turma (presença, ritmos, PIN) |
| `/evaluate/:nome?turmaId=` | Professor + PIN | Lançamento de notas |
| `/admin/login` | Público | Login da secretaria |
| `/admin` | Admin | Painel administrativo |
| `/admin/turma/:id` | Admin ou professor responsável | Detalhes da turma |
| `/results?turmaId=` | Admin | Resultados ao vivo (sem sessão ativa, redireciona ao histórico) |
| `/results/history` | Admin | Lista do histórico oficial |
| `/results/history/:id` | Admin | Detalhe de uma audição arquivada |
| `/export_pdf`, `/export_excel` | Admin | Exportação dos resultados ao vivo |
| `/export_pdf/history/:id`, `/export_excel/history/:id` | Admin | Exportação do histórico |

---

## Regras de avaliação

### Gate eliminatório
- **Presença nas aulas ≥ 80%.** Quem não atinge é automaticamente reprovado; a porcentagem não entra na nota.
- A presença é calculada por `aulas presentes / total de aulas` da turma. Sem total de aulas definido, usa a presença manual do aluno.

### Critérios e pesos

| Peso | % da nota final | Critérios |
|------|-----------------|-----------|
| **1** | 10% | Presença e comportamento nos auxílios · Comprometimento e participação em eventos |
| **2** | 30% | Deslocamento (cavalheiro) ou Floreio (dama) · Abraço e postura · Equilíbrio |
| **3** | 60% | Passos · Ritmo · Corpo do ritmo · Condução · Musicalidade |

- Notas inteiras de **1 a 10**, ou **X** para item não avaliado (não entra na média; não conta como zero).
- **Nota final** = `(média do peso 1 × 0,1) + (média do peso 2 × 0,3) + (média do peso 3 × 0,6)`, na escala de 0 a 10.
- **Aprovação:** nota final **≥ 7,0** **e** maioria simples dos avaliadores ativos aprovando (mais da metade; empate reprova).
- Aprovados sobem uma patente no fechamento oficial (Bolsista → Auxiliar → Assistente → Monitor → Professor).

---

## Fluxo típico de uma audição

1. A secretaria cria ou seleciona a turma e cadastra os alunos.
2. Gera o **PIN** (4 dígitos) na aba Audição. Ele vale para o dia e expira em 6 horas.
3. Os professores entram com nome + senha, escolhem a turma e informam o PIN.
4. Lançam as notas (salvamento sem recarregar a página).
5. A secretaria acompanha ao vivo em `/results`.
6. **Fecha o semestre**: o resultado vai para o histórico, aprovados são promovidos e notas/presença da turma são zeradas para o próximo ciclo.
7. Exporta PDF/Excel para arquivo oficial.

---

## Login por biometria (WebAuthn)

Depois de entrar com nome e senha, o professor recebe um aviso único "Entrar mais rápido?" e pode **Ativar biometria** (ou "Agora não", que adia 7 dias, ou "Não perguntar mais neste aparelho"). Nos próximos acessos, ao digitar o nome, se aquele aparelho já tem a biometria desse professor a tela oferece **Entrar com biometria** no lugar do campo de senha (com o atalho "Usar a senha"); senão, o login segue normalmente com a senha. Aparelhos são gerenciados no link discreto **Gerenciar biometria** no rodapé da tela de turmas. O PIN da audição continua exigido para avaliar.

- O celular guarda a chave privada; o servidor guarda só a chave pública (tabela `webauthn_credentials`).
- Funciona no Chrome/Android, Safari/iPhone e computadores com Windows Hello ou Touch ID, **somente em HTTPS** no domínio do `PUBLIC_BASE_URL` (a chave fica presa a ele; se o domínio mudar, cada professor ativa de novo). Pelo IP da rede local o botão não aparece.
- Até 5 aparelhos por professor. O professor remove aparelhos em **Gerenciar biometria**; o admin pode **Revogar biometria** (celular perdido) na aba Professores.
- Dependência: `@simplewebauthn/server` (rode `npm install`). Sem ela o sistema funciona normalmente e a biometria fica desligada.
- **Admin:** o painel também aceita biometria. Depois de entrar com a senha, o admin recebe o mesmo aviso único e, em aparelho ativado, a tela de login do painel oferece **Entrar com biometria** (com "Usar a senha"). O gerenciamento fica em **Biometria deste aparelho**, na barra lateral. As chaves do admin ficam em tabela separada, não valem para professores (e vice-versa) e **são invalidadas automaticamente quando `ADMIN_PASSWORD` ou `ADMIN_COOKIE_SECRET` mudam**. A senha continua sendo a chave-mestra de reserva.

---

## Painel admin

| Aba | Função |
|-----|--------|
| **Home** | KPIs e atalhos |
| **Audição** | PIN, sessão ativa, fechar semestre |
| **Alunos** | Cadastro individual/em lote, lista, exclusão do sistema |
| **Professores** | Cadastro, código de reset de senha, remoção |
| **Turmas** | Criar turma, vincular alunos, página da turma |
| **Histórico** | Avaliações fechadas com links de PDF/Excel |

- **Remover do sistema** (aba Alunos): exclusão definitiva.
- **Desvincular** (página da turma): apenas tira o aluno da turma.
- No cadastro em lote, cada linha é um nome. Um prefixo `M ` ou `F ` define o gênero daquela linha.

---

## Segurança

- Senhas de professores com `scrypt`; proteção CSRF nos formulários; cookies `httpOnly` com validade de 8 h
- Cabeçalhos de segurança (CSP, `X-Frame-Options`, `nosniff`) e `Cache-Control: no-store` nas áreas autenticadas
- Códigos de reset de senha com validade de 30 min, uso único e invalidados após 5 tentativas erradas
- Limite de tentativas (bloqueio temporário por IP e por nome) no login do admin, no login de professor, na redefinição de senha e na verificação do PIN
- Token CSRF amarrado à sessão; cookies assinados com chaves separadas por finalidade
- Login por biometria (WebAuthn): desafio de uso único com validade de 5 min, verificação biométrica obrigatória, checagem de domínio/origem e contador de assinatura
- Sessão do professor invalidada ao trocar/redefinir a senha ou remover o professor
- `/events` e `/api/evaluators/status` exigem login; erros nunca expõem stack trace
- Política de senha: mínimo de 6 caracteres para professores (sem senhas comuns ou sequências como 123456) e 6 para o admin (em produção)

Não versionar:

- `.env`
- `evaluations.db*`
- `logs/`
- `node_modules/`

Recomendações: senha de admin forte e única, repositório **privado** no GitHub e HTTPS em produção.

---

## Estrutura do projeto

```text
├── app.js                 # Rotas e middlewares
├── load-env.js            # Carrega o .env
├── src/
│   ├── config.js
│   ├── constants.js       # Critérios por gênero
│   ├── db/                # Conexão SQLite
│   ├── data/              # Candidatos padrão (seed)
│   ├── services/          # evaluation-service, scoring-rules, pdf-service, export-excel
│   └── utils/             # admin-auth, teacher-auth, network
├── templates/             # Views EJS (admin, avaliação, histórico, landing…)
├── static/                # CSS, JS e imagens
├── tests/                 # Testes automatizados
├── .env.example
└── package.json
```

---

## Contato da escola

**Fênix Dança de Salão**
Instagram: [@centrodedancasfenix](https://instagram.com/centrodedancasfenix)
Prédio da Livraria Pain — 2º piso
Rua Rio Grande do Sul, 182 — Centro
Rio Branco – Acre

---

## Licença

BSD-3-Clause — ver arquivo `LICENSE`.
