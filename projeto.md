# Sistema de Avaliação de Bolsistas — Fênix Dança

## Visão Geral

Aplicação web para registro, consolidação e arquivamento de avaliações de candidatos à audição de bolsistas da **Fênix Dança de Salão** (Rio Branco – Acre).

O sistema oferece:
- Acesso seguro para professores e secretaria
- Organização por turmas e sessões temporárias com PIN
- Lançamento de notas em tempo real (celular, tablet ou desktop)
- Consolidação oficial com maioria simples
- Histórico congelado e exportação em PDF e Excel
- Interface com tema claro/escuro (OLED)

---

## Base Documental

Regras oficiais de referência:
- `AUDIÇÃO BOLSISTAS 2024_2 PARA AUXILIARES 2025_2.pdf` (e documentos equivalentes de semestres posteriores)

A implementação atual usa a **fórmula B** (médias ponderadas em escala 0–10), alinhada à planilha Excel da Fênix. Ela substituiu o modelo antigo de 250 pontos (20 + 80 + 150), que segue equivalente em espírito.

---

## Regras de Negócio

### Hierarquia e Progressão

- **Patentes:** Bolsista → Auxiliar → Assistente → Monitor → Professor
- **Promoção:** no fechamento oficial, o candidato **aprovado** sobe um nível (ex.: Bolsista → Auxiliar)
- Na interface, a secretaria ajusta o status dos alunos entre Bolsista e Auxiliar

### Presença (gate eliminatório)

- Presença nas aulas **≥ 80%**. Quem não atinge é **automaticamente reprovado**, independentemente das notas técnicas.
- Modelo simplificado: cada turma tem um **total de aulas** e cada aluno um número de **aulas presentes**. A porcentagem é `presentes / total`.
- Se a turma não tem total de aulas definido, vale a presença manual do aluno.
- A porcentagem de presença **não entra** na nota final.

### Modelo de pontuação (fórmula B)

Notas inteiras de **1 a 10** por critério (ou **X** = não avaliado).

| Peso | % da nota final | Critérios |
|------|-----------------|-----------|
| **1** | **10%** | Presença e comportamento nos auxílios · Comprometimento e participação em eventos |
| **2** | **30%** | Deslocamento/Floreio · Abraço e postura · Equilíbrio |
| **3** | **60%** | Passos · Ritmo · Corpo do ritmo · Condução · Musicalidade |

**Nota final** = `(médiaPeso1 × 0,1) + (médiaPeso2 × 0,3) + (médiaPeso3 × 0,6)`, arredondada a uma casa decimal.

- **Deslocamento/Floreio:** um único campo na interface. Deslocamento para cavalheiro, Floreio para dama, conforme o gênero do candidato.
- **X** não entra na média do critério. Se um critério ficar sem nenhuma nota válida entre os avaliadores, conta como zero na consolidação.
- Na aprovação individual de cada professor, critérios marcados com `X` ou em branco são preenchidos com a média global do critério, para o aluno não receber zero por um item não avaliado.

### Regra de aprovação

O candidato precisa cumprir **todos** os itens:

1. Presença nas aulas **≥ 80%** (eliminatória)
2. Nota final **≥ 7,0**
3. Aprovação pela **maioria simples** dos avaliadores ativos (mais da metade; empate reprova). Cada avaliador aprova individualmente se a nota final calculada com as notas dele for ≥ 7,0.

Exemplos de maioria:
- 2 avaliadores → aprova com 2/2
- 3 avaliadores → aprova com 2/3
- 9 avaliadores → aprova com 5/9
- 10 avaliadores → aprova com 6/10

### Avaliadores ativos

Um avaliador é considerado **online** se teve atividade na sessão nos últimos `EVALUATOR_ONLINE_WINDOW_MINUTES` (padrão 30). Só os avaliadores ativos entram na consolidação e na maioria.

---

## Arquitetura Técnica

### Stack

| Camada | Tecnologia |
|--------|------------|
| Backend | Node.js + Express 5 |
| Banco | SQLite (`node:sqlite` nativo) |
| Views | EJS |
| Estilo | CSS moderno (variáveis, claro/escuro OLED) |
| PDF | pdf-lib |
| Excel | ExcelJS |
| Terminal | qrcode (QR Code de acesso ao iniciar) |
| Testes | Node test runner (`node --test`) |

### Estrutura de arquivos

```text
├── app.js                          # Rotas e middlewares
├── load-env.js                     # Carrega o .env
├── .env / .env.example
├── src/
│   ├── config.js
│   ├── constants.js                # Critérios por gênero
│   ├── db/index.js                 # Conexão SQLite
│   ├── data/default-candidates.js  # Seed inicial
│   ├── services/
│   │   ├── evaluation-service.js   # Negócio + banco
│   │   ├── scoring-rules.js        # Fórmula B
│   │   ├── pdf-service.js          # Relatório PDF
│   │   └── export-excel.js         # Relatório Excel
│   └── utils/
│       ├── admin-auth.js           # Sessão do admin
│       ├── teacher-auth.js         # Sessão do professor
│       └── network.js              # URLs de acesso
├── templates/                      # Views EJS
├── static/                         # CSS, JS e imagens
└── tests/
```

### Modelo de dados (tabelas principais)

`candidates` (alunos) · `evaluators` (professores) · `turmas` · `sessions` (PINs) · `scores` · `evaluator_session_presence` · `teacher_reset_tokens` · `evaluation_events` e `evaluation_snapshots` (histórico oficial) · `candidate_fixed_scores`.

---

## Fluxos principais

### 1. Secretaria (Admin)

**Acesso:** `/admin/login` (senha via `.env`), depois `/admin`.

**Funções:**
- Dashboard com KPIs
- Cadastro de professores, turmas e alunos (individual e em lote)
- Geração de PIN de audição (4 dígitos, válido no dia, expira em 6 h) e encerramento de sessão
- Página da turma: presença, status (Bolsista/Auxiliar), renomear turma, desvínculo de aluno
- Fechamento de semestre e reabertura (gera novo PIN)
- Histórico oficial (snapshot) com exportação em PDF e Excel
- Cadastro de professor com e-mail e senha inicial opcional (`1532` se vazia)
- Reset de senha de professor por e-mail ou PIN manual gerado pela secretaria
- Exclusão definitiva de aluno (aba Alunos) vs. desvínculo da turma (página da turma)

### 2. Professor avaliador

- **Login:** nome + senha em `/avaliacao`
- **Turmas:** escolhe a turma em `/turmas/:nome`
- **PIN:** informa o PIN gerado pela secretaria para liberar a avaliação
- **Avaliação:** lança notas em `/evaluate/:nome`, com salvamento sem recarregar a página
- **Professor responsável pela turma:** também edita presença (total de aulas e aulas presentes) e os ritmos avaliados
- **Esqueci a senha:** `/avaliacao/esqueci-senha` solicita código por e-mail; `/avaliacao/redefinir-senha` redefine com o código recebido
- **Primeiro acesso com `1532`:** troca obrigatória em `/avaliacao/alterar-senha` antes de entrar nas turmas

### 3. Consolidação e histórico

- **Ao vivo:** `/results?turmaId=` (médias por critério, nota final, maioria), restrito ao admin. Sem sessão ativa, redireciona para o histórico.
- **Fechamento:** ao fechar o semestre, o sistema grava o snapshot em `/results/history`, promove os aprovados e zera notas e presença da turma para o próximo ciclo.
- **Exportação:** PDF e Excel a partir dos resultados ao vivo ou do snapshot histórico.

## Autenticação

### Professor
1. Admin cadastra nome, e-mail e senha (padrão `1532` se vazia).
2. Primeiro login com `1532` abre “Defina sua nova senha” e bloqueia turmas até a troca.
3. “Esqueci a senha” solicita nome + e-mail e envia código por SMTP para redefinir a senha.
4. O PIN gerado no admin permanece como fallback manual.

### Admin
1. Login normal com `ADMIN_PASSWORD` (`.env`).
2. No fluxo de emergência, `ADMIN_EMAIL` recebe um código de 5 dígitos.
3. Login com código cria sessão de até 6 h ou até logout; o código não pode ser reutilizado.
4. A senha do `.env` não é alterada; o código concede acesso temporário assinado no cookie.

### Concluído (autenticação)
- E-mail no cadastro de professor + `must_change_password`
- Troca obrigatória no primeiro acesso
- Reset de professor por e-mail e PIN manual
- Reset emergencial admin de uso único, com sessão de até 6 h
- Serviço de e-mail compartilhado com template Fênix

---

## Configuração

Variáveis no `.env`:

```env
PORT=5000
HOST=0.0.0.0
ADMIN_PASSWORD=troque-esta-senha
ADMIN_COOKIE_SECRET=troque-este-segredo
ADMIN_EMAIL=admin@exemplo.com
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=seu@gmail.com
SMTP_PASS=senha-de-app
MAIL_FROM="Fênix Dança <seu@gmail.com>"
EVALUATOR_ONLINE_WINDOW_MINUTES=30
```

Para Gmail, use senha de app em `SMTP_PASS`, não a senha normal da conta. Comentários no `.env` começam com `#`.

Opcionais: `PUBLIC_BASE_URL` (URL pública mostrada no terminal/QR Code) e `EVALUATIONS_DB_PATH` (caminho do banco; padrão `./evaluations.db`).

Com `NODE_ENV=production`, o servidor recusa iniciar com senha/segredo vazios ou de exemplo.

```bash
npm install
npm start       # servidor
npm test        # testes
npm run check   # sintaxe
```

---

## Deploy e acesso público

Produção atual:

- **Cloudflare Tunnel** (`cloudflared`)
- Domínio **DigitalPlat** (`.us.kg`), ex.: `https://ohbeggar.us.kg`
- HTTPS fornecido pelo túnel
- App Node em `HOST=0.0.0.0` + porta do `.env` (padrão `5000`)

Fluxo:

```text
Professor / Secretaria  →  https://ohbeggar.us.kg  →  Cloudflare Tunnel  →  localhost:5000
```

Acesso por IP local (`http://192.168.x.x:5000`) continua válido na LAN.
`fenix.local` é opcional e só faz sentido em rede sem túnel/internet.

### Boas práticas de operação

- Rodar o tunnel de forma persistente (serviço Windows ou script de inicialização)
- Não commitar tokens do Cloudflare nem o arquivo `.env`
- Backup periódico de `evaluations.db`

---

## Estado atual

### Concluído

- Login de professores e painel admin protegido (CSRF, cookies, senhas com scrypt)
- Turmas, alunos e status
- Presença simplificada (total de aulas x aulas presentes)
- PIN de sessão de audição
- Fórmula B (10% / 30% / 60%)
- Histórico oficial com snapshot, promoção de patente e reabertura de semestre
- Exportação em PDF e Excel
- Cadastro em lote de alunos
- Reset de senha por código de 5 dígitos
- Ritmos avaliados por turma
- Tema claro/escuro OLED, toasts, interface mobile
- Separação clara entre exclusão do sistema e desvínculo da turma
- Deploy público via Cloudflare Tunnel + domínio `.us.kg` (DigitalPlat), com execução via PM2
- Endurecimento de segurança: limite de tentativas, CSRF amarrado à sessão, chaves de cookie separadas, sessão do professor invalidada ao trocar a senha, política de senha e cabeçalhos extras
- Login por biometria (WebAuthn/passkeys) para professores e para o admin, com revogação pelo admin (`@simplewebauthn/server`)
- Testes automatizados cobrindo autenticação, recuperação de senha, avaliações e exportações (`npm test`)

### Melhorias futuras (opcional)

- Backup automático do banco `evaluations.db`
- Logs de auditoria (quem alterou o quê e quando)

---

## Contato da escola

**Fênix Dança de Salão**
Instagram: [@centrodedancasfenix](https://instagram.com/centrodedancasfenix)
Prédio da Livraria Pain — 2º piso
Rua Rio Grande do Sul, 182 — Centro · Rio Branco – Acre
