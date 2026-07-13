const crypto = require('crypto');
const config = require('../config');

const TEACHER_COOKIE_NAME = 'teacher_access'; // Hardcoded name, can be moved to config if needed
const TEACHER_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 8;

// NOTE: This uses the ADMIN_COOKIE_VALUE because there is no separate teacher secret defined in config.
// For a more robust solution, a dedicated teacher secret should be added to config.js.
function getSigningSecret() {
    return config.adminCookieValue || config.adminPassword || 'avali-teacher-cookie-secret'; // Fallback to admin secret or generic
}

function signValue(value) {
    return crypto.createHmac('sha256', getSigningSecret()).update(value).digest('base64url');
}

function signTeacherPayload(payload) {
    const raw = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${raw}.${signValue(raw)}`;
}

function readTeacherPayload(token) {
    if (!token || !token.includes('.')) return null;

    const [raw, signature] = token.split('.');
    const expected = signValue(raw);

    // Ensure signatures have same byte length to prevent timing attacks
    if (!signature || Buffer.byteLength(signature) !== Buffer.byteLength(expected)) return null;
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;

    try {
        const payload = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
        // Ensure payload is for a teacher and not expired
        if (!payload || payload.type !== 'teacher') return null;
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

function isTeacherAuthenticated(req) {
    const cookies = parseCookies(req);
    return Boolean(readTeacherPayload(cookies[TEACHER_COOKIE_NAME]));
}

function getSecureAttribute(secure = false) {
    return secure ? '; Secure' : '';
}

function setTeacherCookie(res, teacherId, teacherName, secure = false) {
    const maxAgeMs = TEACHER_COOKIE_MAX_AGE_SECONDS * 1000;
    const token = signTeacherPayload({
        type: 'teacher',
        evaluatorId: teacherId,
        evaluatorName: teacherName,
        iat: Date.now(),
        exp: Date.now() + maxAgeMs,
    });

    res.setHeader(
        'Set-Cookie',
        `${TEACHER_COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${TEACHER_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax${getSecureAttribute(secure)}`
    );
}

function clearTeacherCookie(res, secure = false) {
    res.setHeader(
        'Set-Cookie',
        `${TEACHER_COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${getSecureAttribute(secure)}`
    );
}

module.exports = {
    TEACHER_COOKIE_NAME,
    isTeacherAuthenticated,
    setTeacherCookie,
    clearTeacherCookie,
    readTeacherPayload,
};