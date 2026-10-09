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
function subject() {
  return 'Fênix Dança — Código para redefinir sua senha';
}

function textBody(nome, codigo) {
  return `Olá, ${nome}.

Você solicitou a redefinição de senha no Sistema de Avaliação Fênix.

Seu código de verificação é:

    ${codigo}

• Válido por 30 minutos
• Uso único
• Não compartilhe este código com outras pessoas

Se você não pediu essa alteração, ignore este e-mail. Sua senha atual continua valendo.

—
Fênix Dança de Salão
Sistema de Avaliação`;
}

function htmlBody(nome, codigo) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /></head>
<body style="margin:0;padding:0;background:#f5f0eb;font-family:Segoe UI,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f0eb;padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" style="max-width:480px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,0.06);">
        <tr>
          <td style="background:#8b1e1e;padding:20px 24px;text-align:center;">
            <span style="color:#fff;font-size:18px;font-weight:700;">Fênix Dança de Salão</span>
          </td>
        </tr>
        <tr>
          <td style="padding:28px 24px;color:#1a1210;font-size:15px;line-height:1.55;">
            <p style="margin:0 0 12px;">Olá, <strong>${escapeHtml(nome)}</strong>.</p>
            <p style="margin:0 0 20px;">Você solicitou a redefinição de senha no Sistema de Avaliação Fênix.</p>
            <p style="margin:0 0 8px;color:#6b5e58;font-size:13px;">Seu código de verificação:</p>
            <p style="margin:0 0 20px;text-align:center;">
              <span style="display:inline-block;background:#f7f3ee;border:1px solid #e5ddd6;border-radius:10px;padding:14px 28px;font-size:28px;font-weight:700;letter-spacing:0.2em;color:#8b1e1e;">
                ${escapeHtml(codigo)}
              </span>
            </p>
            <ul style="margin:0 0 20px;padding-left:18px;color:#6b5e58;font-size:13px;">
              <li>Válido por <strong>30 minutos</strong></li>
              <li>Uso único</li>
              <li>Não compartilhe este código</li>
            </ul>
            <p style="margin:0;color:#6b5e58;font-size:13px;">
              Se você não pediu essa alteração, ignore este e-mail. Sua senha atual continua valendo.
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 24px;background:#faf8f5;border-top:1px solid #efe8e2;text-align:center;color:#a89f98;font-size:12px;">
            Fênix Dança de Salão · Sistema de Avaliação
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

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

  const info = await transporter.sendMail({
    from: MAIL_FROM,
    to: TEST_MAIL_TO,
    subject: subject(),
    text: textBody(NOME_PROFESSOR, CODIGO),
    html: htmlBody(NOME_PROFESSOR, CODIGO),
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