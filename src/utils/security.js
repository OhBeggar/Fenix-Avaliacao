'use strict';

const crypto = require('crypto');

function sha256(value) {
    return crypto.createHash('sha256').update(String(value)).digest();
}

// Comparação em tempo constante (compara os hashes, então o tamanho não vaza).
function safeEqual(a, b) {
    return crypto.timingSafeEqual(sha256(a), sha256(b));
}

// Deriva uma chave por finalidade (admin, professor, avaliação, csrf...).
// Assim, um token assinado para um fim nunca vale para outro.
function deriveKey(masterSecret, purpose) {
    return crypto
        .createHmac('sha256', String(masterSecret))
        .update(`avali:v1:${purpose}`)
        .digest();
}

function signPayload(payload, key) {
    const raw = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto.createHmac('sha256', key).update(raw).digest('base64url');
    return `${raw}.${signature}`;
}

function readSignedPayload(token, key, options = {}) {
    if (typeof token !== 'string') return null;

    const parts = token.split('.');
    if (parts.length !== 2) return null;

    const [raw, signature] = parts;
    const expected = crypto.createHmac('sha256', key).update(raw).digest('base64url');
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    try {
        const payload = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
        if (!payload || typeof payload !== 'object') return null;
        if (!options.allowExpired && payload.exp !== undefined && Date.now() > Number(payload.exp)) return null;
        return payload;
    } catch {
        return null;
    }
}

// Lê o header Cookie sem lançar erro em valores malformados (ex.: "%").
function parseCookieHeader(header) {
    const cookies = Object.create(null);

    String(header || '')
        .split(';')
        .forEach((item) => {
            const index = item.indexOf('=');
            if (index === -1) return;

            const key = item.slice(0, index).trim();
            if (!key || key in cookies) return;

            let value = item.slice(index + 1).trim();
            try {
                value = decodeURIComponent(value);
            } catch {
                // mantém o valor bruto
            }
            cookies[key] = value;
        });

    return cookies;
}

// Serializa JSON para uso dentro de <script> sem permitir "quebrar" a tag
// (</script>, <!--, etc.).
function safeJson(value) {
    const json = JSON.stringify(value === undefined ? null : value);
    return json
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}

// Limpa texto livre: remove caracteres de controle, colapsa espaços e limita o tamanho.
function cleanText(value, max = 120) {
    return String(value ?? '')
        .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
}

const COMMON_PASSWORDS = new Set([
    '123456',
    '1234567',
    '12345678',
    '123456789',
    '1234567890',
    '654321',
    '000000',
    '111111',
    '222222',
    '123123',
    '112233',
    '121212',
    '102030',
    '010203',
    '147258',
    '159753',
    'abc123',
    'abc1234',
    'abcdef',
    'qwerty',
    'qwerty1',
    'qwe123',
    'password',
    'password1',
    'senha1',
    'senha12',
    'senha123',
    'senha1234',
    'qwerty123',
    'abcd1234',
    'abc12345',
    '11111111',
    '00000000',
    'fenix1',
    'fenix12',
    'fenix123',
    'fenix1234',
    'mudar1',
    'mudar12',
    'mudar123',
]);

// Sequências como 123456, 345678 ou abcdef (crescentes ou decrescentes).
function isSequentialRun(value) {
    if (value.length < 4) return false;
    const codes = Array.from(value.toLowerCase()).map((char) => char.codePointAt(0));
    const step = codes[1] - codes[0];
    if (Math.abs(step) !== 1) return false;
    return codes.every((code, index) => index === 0 || code - codes[index - 1] === step);
}

// Retorna a mensagem de erro (string) ou null quando a senha é aceitável.
// O mínimo de 6 caracteres é compensado pelo limite de tentativas por IP e por nome.
function validatePassword(password, { name = '', min = 6 } = {}) {
    const value = typeof password === 'string' ? password : '';

    if (value.length < min) return `A senha deve ter pelo menos ${min} caracteres.`;
    if (value.length > 128) return 'A senha deve ter no máximo 128 caracteres.';
    if (/^(.)\1+$/u.test(value)) return 'Escolha uma senha menos previsível.';

    const lower = value.toLowerCase();
    if (COMMON_PASSWORDS.has(lower)) return 'Essa senha é muito comum. Escolha outra.';
    if (isSequentialRun(value)) return 'Escolha uma senha menos previsível.';
    if (name && lower === String(name).trim().toLowerCase()) {
        return 'A senha não pode ser igual ao nome.';
    }

    return null;
}

function getClientIp(req) {
    return String(req.ip || (req.socket && req.socket.remoteAddress) || 'unknown');
}

module.exports = {
    safeEqual,
    deriveKey,
    signPayload,
    readSignedPayload,
    parseCookieHeader,
    safeJson,
    cleanText,
    validatePassword,
    getClientIp,
};
