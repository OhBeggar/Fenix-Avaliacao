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

## Rotas Principais

- `/`: landing page pública.
- `/avaliacao`: login dos professores para acessar turmas e avaliações.
- `/results`: painel público de resultados ao vivo.
- `/admin`: painel administrativo protegido.

## Regras de Avaliação

- Frequência mínima: candidato com menos de `80%` de presença fica automaticamente reprovado.
- Notas: professores atribuem notas inteiras de `1` a `10`; use `X` quando um item não for avaliado.
- Pontuação total: `20 + 80 + 150 = 250` pontos.
- Nota final: `pontuação / 25`; aprovação exige nota final mínima `7,0`, equivalente a `175/250`.
- Maioria simples: aprovação exige mais da metade dos avaliadores aprovando. Empate reprova.
- Promoção: candidato aprovado sobe uma patente no fechamento oficial, por exemplo `Bolsista -> Auxiliar`.

## Segurança de Dados

Este projeto lida com nomes, notas, presença e histórico de avaliação. Não versionar:

- `.env`
- `evaluations.db*`
- `logs/`
- `node_modules/`

Use repositório privado no GitHub.
