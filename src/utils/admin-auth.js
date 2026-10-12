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

function readAdminPayload(token, allowExpired = false) {
    const payload = readSignedPayload(token, ADMIN_KEY, { allowExpired });
    if (!payload || payload.type !== 'admin') return null;
    if (!payload.exp) return null;
    return payload;
}

function getAdminPayload(req, includeExpired = false) {
    if (!config.adminPassword) {
        return null;
    }

    const cookies = parseCookieHeader(req.headers.cookie);
    const payload = readAdminPayload(cookies[ADMIN_COOKIE_NAME], includeExpired);
    if (!payload) return null;
    if (!includeExpired && payload.adminAuthMode === 'emergency') {
        const emergencyUntil = Date.parse(payload.adminEmergencyUntil || '');
        if (!Number.isFinite(emergencyUntil) || emergencyUntil <= Date.now()) return null;
    }
    return payload;
}

function isAdminAuthenticated(req) {
    return Boolean(getAdminPayload(req));
}

function getSecureAttribute(secure = false) {
    return secure ? '; Secure' : '';
}

function setAdminCookie(res, secure = false, options = {}) {
    const emergencyUntil = options.adminAuthMode === 'emergency' ? Number(options.adminEmergencyUntil) : null;
    const maxAgeMs = emergencyUntil && Number.isFinite(emergencyUntil)
        ? Math.max(0, emergencyUntil - Date.now())
        : ADMIN_COOKIE_MAX_AGE_SECONDS * 1000;
    const token = signAdminPayload({
        type: 'admin',
        iat: Date.now(),
        exp: Date.now() + maxAgeMs,
        ...(options.adminAuthMode === 'emergency' ? {
            adminAuthMode: 'emergency',
            adminEmergencyUntil: new Date(emergencyUntil).toISOString(),
        } : {}),
    });

    res.setHeader(
        'Set-Cookie',
        `${ADMIN_COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${Math.floor(maxAgeMs / 1000)}; SameSite=Lax${getSecureAttribute(secure)}`
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
    getAdminPayload,
    setAdminCookie,
    clearAdminCookie,
    signAdminPayload,
    readAdminPayload,
};
