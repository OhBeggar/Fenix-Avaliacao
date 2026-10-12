'use strict';

const nodemailer = require('nodemailer');

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildResetEmail({ nome, codigo }) {
  const safeName = escapeHtml(nome || 'Administrador');
  const safeCode = escapeHtml(codigo);
  return {
    subject: 'Fênix Dança - Código de segurança',
    text: `Olá, ${nome || 'Administrador'}.\n\nSeu código de segurança do Sistema de Avaliação Fênix é ${codigo}.\n\nVálido por 30 minutos e para um único uso. Se você não solicitou este código, ignore esta mensagem.\n\nFênix Dança de Salão`,
    html: `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:32px 16px;background:#f5f0eb;font-family:Segoe UI,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#fff;border-radius:12px;overflow:hidden">
<tr><td style="padding:20px;background:#8b1e1e;color:#fff;text-align:center;font-size:18px;font-weight:700">Fênix Dança de Salão</td></tr>
<tr><td style="padding:28px 24px;color:#1a1210;font-size:15px;line-height:1.55">
<p>Olá, <strong>${safeName}</strong>.</p><p>Seu código de segurança do Sistema de Avaliação Fênix:</p>
<p style="text-align:center;padding:12px;background:#f7f3ee;border-radius:10px;color:#8b1e1e;font-size:30px;font-weight:700;letter-spacing:0.2em">${safeCode}</p>
<p>Válido por <strong>30 minutos</strong> e para <strong>um único uso</strong>.</p>
<p style="color:#6b5e58;font-size:13px">Se você não solicitou este código, ignore esta mensagem. Sua senha atual continua funcionando normalmente.</p>
</td></tr><tr><td style="padding:16px;background:#faf8f5;text-align:center;color:#8a817b;font-size:12px">Sistema de Avaliação · Fênix Dança</td></tr>
</table></td></tr></table></body></html>`,
  };
}

function createTransport() {
  const host = String(process.env.SMTP_HOST || 'smtp.gmail.com').trim();
  const port = Number.parseInt(process.env.SMTP_PORT || '587', 10);
  const user = String(process.env.SMTP_USER || '').trim();
  const pass = String(process.env.SMTP_PASS || '');
  if (!user || !pass || !Number.isInteger(port)) {
    throw new Error('Serviço de e-mail não está configurado.');
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
}

async function sendResetEmail({ to, nome, codigo }) {
  const recipient = String(to || '').trim();
  if (!recipient) throw new Error('Destinatário de e-mail ausente.');
  const content = buildResetEmail({ nome, codigo });
  const transporter = createTransport();
  return transporter.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to: recipient,
    ...content,
  });
}

module.exports = { sendResetEmail, buildResetEmail };
