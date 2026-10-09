const crypto = require('crypto');

const port = Number.parseInt(process.env.PORT || '5000', 10);
const host = process.env.HOST || '0.0.0.0';
const adminPassword = process.env.ADMIN_PASSWORD || '';
const adminCookieSecret = process.env.ADMIN_COOKIE_SECRET || 'avali-admin-cookie-secret';
const evaluatorOnlineWindowMinutes = Number.parseInt(
    process.env.EVALUATOR_ONLINE_WINDOW_MINUTES || '30',
    10
);
const publicBaseUrl = process.env.PUBLIC_BASE_URL || '';

// --- Login por biometria (WebAuthn / passkeys) ---
// O rpID é o domínio do site (sai do PUBLIC_BASE_URL) e a chave criada no celular fica presa a ele.
// Opcional: WEBAUTHN_RP_ID, WEBAUTHN_ORIGINS (lista separada por vírgula) e WEBAUTHN_DISABLED=1.
function resolveWebauthn() {
    const rpName = 'Fênix Dança — Avaliação';
    if (process.env.WEBAUTHN_DISABLED === '1') {
        return { enabled: false, rpID: '', rpName, origins: [] };
    }

    let rpID = String(process.env.WEBAUTHN_RP_ID || '').trim().toLowerCase();
    const origins = new Set(
        String(process.env.WEBAUTHN_ORIGINS || '')
            .split(',')
            .map((item) => item.trim().replace(/\/$/, ''))
            .filter(Boolean)
    );

    try {
        const parsed = new URL(publicBaseUrl);
        if (!rpID) rpID = parsed.hostname.toLowerCase();
        if (parsed.protocol === 'https:' || parsed.hostname === 'localhost') {
            origins.add(parsed.origin);
        }
    } catch {
        // PUBLIC_BASE_URL ausente ou inválido
    }

    const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(rpID) || rpID.includes(':');
    const validRpId = Boolean(rpID) && !isIp && (rpID === 'localhost' || rpID.includes('.'));

    return {
        enabled: validRpId && origins.size > 0,
        rpID,
        rpName,
        origins: Array.from(origins),
    };
}

function hashValue(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

module.exports = {
    port: Number.isNaN(port) ? 5000 : port,
    host,
    publicBaseUrl,
    webauthn: resolveWebauthn(),
    adminPassword,
    adminCookieName: 'avali_admin',
    adminCookieValue: hashValue(`${adminCookieSecret}:${adminPassword || 'disabled'}`),
    evaluatorOnlineWindowMinutes: Number.isNaN(evaluatorOnlineWindowMinutes)
        ? 30
        : evaluatorOnlineWindowMinutes,
};
