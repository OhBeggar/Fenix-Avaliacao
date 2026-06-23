const crypto = require('crypto');
const config = require('../config');

const ADMIN_COOKIE_NAME = config.adminCookieName;
const ADMIN_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 8;

function getSigningSecret() {
    return config.adminCookieValue || config.adminPassword || 'avali-admin-cookie-secret';
}

function signValue(value) {
    return crypto.createHmac('sha256', getSigningSecret()).update(value).digest('base64url');
}

function signAdminPayload(payload) {
    const raw = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${raw}.${signValue(raw)}`;
}

function readAdminPayload(token) {
    if (!token || !token.includes('.')) return null;

    const [raw, signature] = token.split('.');
    const expected = signValue(raw);
    if (!signature || Buffer.byteLength(signature) !== Buffer.byteLength(expected)) return null;
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;

    try {
        const payload = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
        if (!payload || payload.type !== 'admin') return null;
        if (!payload.exp || Date.now() > Number(payload.exp)) return null;
        return payload;
    } catch {
        return null;
    }
}

function parseCookies(req) {
    const rawCookie = req.headers.cookie || '';

    return rawCookie
        .split(';')
        .map((item) => item.trim())
        .filter(Boolean)
        .reduce((acc, item) => {
            const separatorIndex = item.indexOf('=');

            if (separatorIndex === -1) {
                return acc;
            }

            const key = item.slice(0, separatorIndex);
            const value = item.slice(separatorIndex + 1);
            acc[key] = decodeURIComponent(value);
            return acc;
        }, {});
}

function isAdminAuthenticated(req) {
    if (!config.adminPassword) {
        return false;
    }

    const cookies = parseCookies(req);
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
};
