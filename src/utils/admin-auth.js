const config = require('../config');
const {
    deriveKey,
    signPayload,
    readSignedPayload,
    parseCookieHeader,
} = require('./security');

const ADMIN_COOKIE_NAME = config.adminCookieName;
const ADMIN_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 8;

// Chave exclusiva do admin, derivada do segredo principal.
const ADMIN_KEY = deriveKey(
    config.adminCookieValue || config.adminPassword || 'avali-admin-cookie-secret',
    'admin'
);

function signAdminPayload(payload) {
    return signPayload(payload, ADMIN_KEY);
}

function readAdminPayload(token) {
    const payload = readSignedPayload(token, ADMIN_KEY);
    if (!payload || payload.type !== 'admin') return null;
    if (!payload.exp) return null;
    return payload;
}

function isAdminAuthenticated(req) {
    if (!config.adminPassword) {
        return false;
    }

    const cookies = parseCookieHeader(req.headers.cookie);
    return Boolean(readAdminPayload(cookies[ADMIN_COOKIE_NAME]));
}

function getSecureAttribute(secure = false) {
    return secure ? '; Secure' : '';
}

function setAdminCookie(res, secure = false) {
    const maxAgeMs = ADMIN_COOKIE_MAX_AGE_SECONDS * 1000;
    const token = signAdminPayload({
        type: 'admin',
        iat: Date.now(),
        exp: Date.now() + maxAgeMs,
    });

    res.setHeader(
        'Set-Cookie',
        `${ADMIN_COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${ADMIN_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax${getSecureAttribute(secure)}`
    );
}

function clearAdminCookie(res, secure = false) {
    res.setHeader(
        'Set-Cookie',
        `${ADMIN_COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${getSecureAttribute(secure)}`
    );
}

module.exports = {
    ADMIN_COOKIE_NAME,
    isAdminAuthenticated,
    setAdminCookie,
    clearAdminCookie,
    signAdminPayload,
    readAdminPayload,
};
