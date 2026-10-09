const config = require('../config');
const {
    deriveKey,
    signPayload,
    readSignedPayload,
    parseCookieHeader,
    safeEqual,
} = require('./security');

const TEACHER_COOKIE_NAME = 'teacher_access';
const TEACHER_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 8;

// Chave exclusiva do cookie de professor, derivada do segredo principal.
const TEACHER_KEY = deriveKey(
    config.adminCookieValue || config.adminPassword || 'avali-teacher-cookie-secret',
    'teacher'
);

function getService() {
    // require tardio: evita dependência circular na carga dos módulos
    return require('../services/evaluation-service');
}

function signTeacherPayload(payload) {
    return signPayload(payload, TEACHER_KEY);
}

/**
 * Valida a assinatura, a expiração E o estado atual do professor no banco:
 * - professor removido => sessão inválida;
 * - senha trocada/redefinida => sessão antiga inválida (campo `pv`).
 */
function readTeacherPayload(token) {
    const payload = readSignedPayload(token, TEACHER_KEY);
    if (!payload || payload.type !== 'teacher' || !payload.exp) return null;
    if (!Number.isInteger(payload.evaluatorId) || typeof payload.pv !== 'string') return null;

    try {
        const service = getService();
        const teacher = service.getTeacherById(payload.evaluatorId);
        if (!teacher || teacher.name !== payload.evaluatorName) return null;

        const currentVersion = service.getTeacherAuthVersion(payload.evaluatorId);
        if (!currentVersion || !safeEqual(currentVersion, payload.pv)) return null;
    } catch {
        return null;
    }

    return payload;
}

function isTeacherAuthenticated(req) {
    const cookies = parseCookieHeader(req.headers.cookie);
    return Boolean(readTeacherPayload(cookies[TEACHER_COOKIE_NAME]));
}

function getSecureAttribute(secure = false) {
    return secure ? '; Secure' : '';
}

function setTeacherCookie(res, teacherId, teacherName, secure = false) {
    const maxAgeMs = TEACHER_COOKIE_MAX_AGE_SECONDS * 1000;
    const pv = getService().getTeacherAuthVersion(teacherId);
    if (!pv) {
        throw new Error('Professor não encontrado.');
    }

    const token = signTeacherPayload({
        type: 'teacher',
        evaluatorId: teacherId,
        evaluatorName: teacherName,
        pv,
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
