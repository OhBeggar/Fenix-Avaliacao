/**
 * Teste isolado — envio de e-mail com código de reset
 * Não altera rotas, banco nem o fluxo atual de PIN no admin.
 *
 * Uso:
 *   node test-email-reset.js
 *
 * Requer no .env (ou variáveis de ambiente):
 *   SMTP_HOST=
 *   SMTP_PORT=587
 *   SMTP_USER=
 *   SMTP_PASS=
 *   MAIL_FROM="Fênix Dança <seu@email.com>"
 *   TEST_MAIL_TO=destino@email.com
 */

require('./load-env'); // se o projeto já carrega .env assim; senão use dotenv
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const { buildResetEmail } = require('./src/services/mail-service');

// ---------- Config ----------
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const MAIL_FROM = process.env.MAIL_FROM || SMTP_USER;
const TEST_MAIL_TO = process.env.TEST_MAIL_TO || SMTP_USER;

const NOME_PROFESSOR = process.env.TEST_PROFESSOR_NAME || 'Professor Teste';
const CODIGO = String(crypto.randomInt(0, 100000)).padStart(5, '0'); // 5 dígitos

// ---------- Templates ----------
// ---------- Envio ----------
async function main() {
  if (!SMTP_USER || !SMTP_PASS) {
    console.error('Defina SMTP_USER e SMTP_PASS no .env (ou no ambiente).');
    process.exit(1);
  }

  console.log('--- Teste de e-mail (reset) ---');
  console.log('Para:', TEST_MAIL_TO);
  console.log('Professor:', NOME_PROFESSOR);
  console.log('Código gerado:', CODIGO);
  console.log('');

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });

  // Verifica conexão SMTP antes de enviar
  await transporter.verify();
  console.log('SMTP OK.');

  const email = buildResetEmail({ nome: NOME_PROFESSOR, codigo: CODIGO });

  const info = await transporter.sendMail({
    from: MAIL_FROM,
    to: TEST_MAIL_TO,
    ...email,
  });

  console.log('E-mail enviado.');
  console.log('MessageId:', info.messageId);
  console.log('');
  console.log('Fluxo atual do app NÃO foi alterado.');
}

main().catch((err) => {
  console.error('Falha no teste:', err.message);
  process.exit(1);
});