# Sistema de Avaliação Fênix

Aplicação web para organizar turmas, registrar presença, coletar avaliações de bolsistas e gerar resultados consolidados.

## Requisitos

- Node.js com suporte a `node:sqlite`
- npm

## Configuração

Crie um arquivo `.env` local com:

```env
PORT=5000
HOST=0.0.0.0
ADMIN_PASSWORD=troque-esta-senha
ADMIN_COOKIE_SECRET=troque-este-segredo
EVALUATOR_ONLINE_WINDOW_MINUTES=30
```

O banco padrão é `evaluations.db` na raiz do projeto. Para testes ou ambientes isolados, use `EVALUATIONS_DB_PATH`.

## Comandos

```bash
npm install
npm start
npm test
npm run check
```

## Segurança de Dados

Este projeto lida com nomes, notas, presença e histórico de avaliação. Não versionar:

- `.env`
- `evaluations.db*`
- `logs/`
- `node_modules/`

Use repositório privado no GitHub.
