# Sistema de Avaliação de Bolsistas - Fênix Dança

## Visão Geral
Aplicação web profissional para registro e consolidação de avaliações de candidatos à audição de bolsistas da Fênix Dança de Salão. O sistema conta com segurança de acesso por professores, organização por turmas, sessões temporárias com códigos PIN e geração de relatórios PDF com títulos dinâmicos.

## Base Documental
O sistema segue as regras oficiais definidas nos documentos de referência da audição:
- `AUDIÇÃO BOLSISTAS 2024_2 PARA AUXILIARES 2025_2.pdf`

## Regras de Negócio

### Hierarquia e Progressão
- **Status:** Bolsista → Auxiliar → Assistente → Monitor → Professor.
- **Promoção:** Ao ser aprovado, o candidato avança automaticamente um nível na hierarquia (ex: Bolsista aprovado torna-se Auxiliar).

### Modelo de Pontuação
- **Peso 1:** Presença auxílios + Comprometimento (20 pts)
- **Peso 2:** Deslocamento/Floreio (80 pts)
- **Peso 3:** Demais critérios (150 pts)
- **Total:** 250 pontos
- **Nota Final:** Escala de 0 a 10 (Pontuação / 25)

### Regra de Aprovação
O candidato deve cumprir **todos** os requisitos abaixo:
1. Presença nas aulas $\ge$ 80% (Eliminatória)
2. Nota final $\ge$ 7,0
3. Aprovação pela maioria simples dos avaliadores ativos

### Escala de Avaliação
- Notas inteiras de **1 a 10**.
- **X** para item não avaliado (excluído da média).

## Arquitetura Técnica

### Stack
- **Backend:** Node.js + Express
- **Banco de Dados:** SQLite (via `node:sqlite` nativo)
- **Frontend:** EJS + CSS3 (Variáveis e Animações)
- **PDF:** `pdf-lib`

### Estrutura de Arquivos
```text
├── app.js                 # Rotas e Middleware
├── .env                   # Configurações sensíveis
├── load-env.js            # Carregamento manual de variáveis
├── src/
│   ├── services/
│   │   ├── evaluation-service.js  # Lógica de negócio e DB
│   │   ├── scoring-rules.js       # Cálculos matemáticos
│   │   └── pdf-service.js         # Geração do relatório
│   ├── utils/
│   │   ├── admin-auth.js          # Sessão do Admin
│   │   └── network.js             # Detecção de IP local
│   ├── data/
│   │   └── default-candidates.js
│   └── db/index.js        # Conexão SQLite
└── templates/             # Views EJS
```

## Fluxos Principais

### 1. Administrador
**Acesso:** `/admin/login` (Senha via `.env`).
**Funções:**
- Cadastrar/Remover Professores (com senha).
- Criar Turmas e vincular Alunos.
- Iniciar Sessão de Audição (Gera PIN de 4 dígitos).
- Gerenciar candidatos (CRUD).

### 2. Professor Avaliador
**Login:** Nome + Senha em `/`.
**Seleção:** Escolhe a Turma da avaliação.
**Validação:** Insere o PIN de sessão fornecido pelo Admin.
**Avaliação:** Preenche notas. O sistema salva e persiste os dados (não perde ao recarregar).

### 3. Consolidação
**Resultados:** `/results`. Atualiza em tempo real (auto-refresh).
**Filtros:** Possibilidade de filtrar resultados por Turma.
**PDF:** Exportação com nome dinâmico baseado na patente dos alunos.

## Configuração (config.js)
Variáveis de ambiente obrigatórias no `.env`:
- `PORT`: Porta do servidor (Padrão: 5000)
- `HOST`: Interface de escuta (Use 0.0.0.0 para rede local)
- `ADMIN_PASSWORD`: Senha mestra do painel
- `ADMIN_COOKIE_SECRET`: Hash para segurança do cookie
- `EVALUATOR_ONLINE_WINDOW_MINUTES`: Janela de tempo para considerar avaliador "online"

## Estado Atual

### ✅ Resolvido
- **Segurança:** Login de professores e Painel Admin protegido.
- **Organização:** Sistema de Turmas e Vinculação de Alunos.
- **Acesso Temporário:** Códigos PIN de 4 dígitos para sessões.
- **Persistência:** Notas salvas no banco e recuperadas ao recarregar.
- **PDF Dinâmico:** Título e lógica de patente automática.
- **UX/UI:** Animações, Transições, Toast Notifications e Scrollbar customizada.
- **Rede:** QR Code de acesso rápido no terminal ao iniciar.

### 🚧 Pendências / Melhorias Futuras
- Configuração de DNS local (ex: `fenix.local`) para acesso amigável.
- Backup automático do banco de dados `evaluations.db`.
- Logs de auditoria (quem alterou o quê e quando).
- Suporte a temas (Light/Dark mode).
