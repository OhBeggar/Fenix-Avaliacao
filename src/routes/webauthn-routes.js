'use strict';

const webauthnService = require('../services/webauthn-service');
const { getClientIp } = require('../utils/security');
const {
    AttemptTracker,
    lockedForAny,
    failAll,
    clearAll,
    tooManyAttemptsMessage,
    requestLimiter,
} = require('../utils/rate-limit');

const FIFTEEN_MIN = 15 * 60 * 1000;

/**
 * Rotas do login por biometria (WebAuthn).
 *
 * deps: { requireCsrf, getTeacherSession, adminAuthMiddleware, setTeacherCookie, isSecureRequest }
 */
function registerWebauthnRoutes(app, deps) {
    const {
        requireCsrf,
        getTeacherSession,
        adminAuthMiddleware,
        setTeacherCookie,
        isSecureRequest,
        isAdminAuthenticated,
        setAdminCookie,
    } = deps;

    // Erros de login por biometria contam por IP (o aparelho, sozinho, já exige digital/rosto).
    const loginFailuresByIp = new AttemptTracker({ maxAttempts: 10, windowMs: FIFTEEN_MIN, lockMs: FIFTEEN_MIN });
    const loginLimiter = requestLimiter({ windowMs: 60 * 1000, max: 40, message: 'Muitas tentativas. Aguarde um instante.' });
    const manageLimiter = requestLimiter({ windowMs: 60 * 1000, max: 30, message: 'Muitas tentativas. Aguarde um instante.' });

    function sendError(res, error) {
        const status = error && error.name === 'WebauthnError' ? error.status : 500;
        const message = error && error.name === 'WebauthnError'
            ? error.message
            : 'Não foi possível concluir a operação.';
        if (status === 500) console.error('Erro no login por biometria:', error);
        return res.status(status).json({ ok: false, message });
    }

    function requireTeacher(req, res, next) {
        const teacher = getTeacherSession(req);
        if (!teacher) {
            return res.status(401).json({ ok: false, message: 'Faça login para continuar.' });
        }
        req.teacher = teacher;
        return next();
    }

    // --- Professor logado: cadastrar / listar / remover aparelhos ---

    app.post('/webauthn/register/options', manageLimiter, requireCsrf, requireTeacher, async (req, res) => {
        try {
            const options = await webauthnService.beginRegistration(req.teacher);
            return res.json({ ok: true, options });
        } catch (error) {
            return sendError(res, error);
        }
    });

    app.post('/webauthn/register/verify', manageLimiter, requireCsrf, requireTeacher, async (req, res) => {
        try {
            const credentials = await webauthnService.completeRegistration(
                req.teacher,
                req.body && req.body.credential,
                req.body && req.body.label
            );
            return res.json({ ok: true, credentials });
        } catch (error) {
            return sendError(res, error);
        }
    });

    app.get('/webauthn/credentials', requireTeacher, (req, res) => {
        return res.json({
            ok: true,
            max: webauthnService.MAX_CREDENTIALS_PER_TEACHER,
            credentials: webauthnService.listCredentialsForClient(req.teacher.id),
        });
    });

    app.post('/webauthn/credentials/:id/delete', manageLimiter, requireCsrf, requireTeacher, (req, res) => {
        const removed = webauthnService.deleteCredential(req.teacher.id, req.params.id);
        if (!removed) {
            return res.status(404).json({ ok: false, message: 'Aparelho não encontrado.' });
        }
        return res.json({
            ok: true,
            credentials: webauthnService.listCredentialsForClient(req.teacher.id),
        });
    });

    // --- Login (público) ---

    app.post('/webauthn/login/options', loginLimiter, async (req, res) => {
        const ip = getClientIp(req);
        const wait = lockedForAny([[loginFailuresByIp, ip]]);
        if (wait) {
            return res.status(429).json({ ok: false, message: tooManyAttemptsMessage(wait) });
        }

        try {
            const { options, challengeId } = await webauthnService.beginLogin();
            return res.json({ ok: true, options, challengeId });
        } catch (error) {
            return sendError(res, error);
        }
    });

    app.post('/webauthn/login/verify', loginLimiter, async (req, res) => {
        const ip = getClientIp(req);
        const pairs = [[loginFailuresByIp, ip]];
        const wait = lockedForAny(pairs);
        if (wait) {
            return res.status(429).json({ ok: false, message: tooManyAttemptsMessage(wait) });
        }

        try {
            const teacher = await webauthnService.completeLogin(
                req.body && req.body.challengeId,
                req.body && req.body.credential
            );
            clearAll(pairs);
            setTeacherCookie(res, teacher.id, teacher.name, isSecureRequest(req), {
                mustChangePassword: Number(teacher.must_change_password) === 1,
            });
            const redirectUrl = Number(teacher.must_change_password) === 1
                ? '/avaliacao/alterar-senha'
                : `/turmas/${encodeURIComponent(teacher.name)}`;
            return res.json({ ok: true, name: teacher.name, redirectUrl });
        } catch (error) {
            failAll(pairs);
            return sendError(res, error);
        }
    });

    // ============================================================
    // Biometria do ADMIN (senha única do painel)
    // ============================================================

    const adminLoginFailuresByIp = new AttemptTracker({ maxAttempts: 10, windowMs: FIFTEEN_MIN, lockMs: FIFTEEN_MIN });

    function requireAdminJson(req, res, next) {
        if (isAdminAuthenticated(req)) return next();
        return res.status(401).json({ ok: false, message: 'Faça login como administrador para continuar.' });
    }

    // Cadastro/gerenciamento: só com o admin já logado (senha) + CSRF ligado à sessão
    app.post('/admin/webauthn/register/options', manageLimiter, requireAdminJson, requireCsrf, async (req, res) => {
        try {
            return res.json({ ok: true, options: await webauthnService.beginAdminRegistration() });
        } catch (error) {
            return sendError(res, error);
        }
    });

    app.post('/admin/webauthn/register/verify', manageLimiter, requireAdminJson, requireCsrf, async (req, res) => {
        try {
            const credentials = await webauthnService.completeAdminRegistration(
                req.body && req.body.credential,
                req.body && req.body.label
            );
            return res.json({ ok: true, credentials });
        } catch (error) {
            return sendError(res, error);
        }
    });

    app.get('/admin/webauthn/credentials', requireAdminJson, (req, res) => {
        return res.json({
            ok: true,
            max: webauthnService.MAX_CREDENTIALS_PER_TEACHER,
            credentials: webauthnService.listAdminCredentialsForClient(),
        });
    });

    app.post('/admin/webauthn/credentials/:id/delete', manageLimiter, requireAdminJson, requireCsrf, (req, res) => {
        if (!webauthnService.deleteAdminCredential(req.params.id)) {
            return res.status(404).json({ ok: false, message: 'Aparelho não encontrado.' });
        }
        return res.json({ ok: true, credentials: webauthnService.listAdminCredentialsForClient() });
    });

    // Login (público, com limite de tentativas por IP)
    app.post('/admin/webauthn/login/options', loginLimiter, async (req, res) => {
        const wait = lockedForAny([[adminLoginFailuresByIp, getClientIp(req)]]);
        if (wait) {
            return res.status(429).json({ ok: false, message: tooManyAttemptsMessage(wait) });
        }

        try {
            const { options, challengeId } = await webauthnService.beginAdminLogin();
            return res.json({ ok: true, options, challengeId });
        } catch (error) {
            return sendError(res, error);
        }
    });

    app.post('/admin/webauthn/login/verify', loginLimiter, async (req, res) => {
        const pairs = [[adminLoginFailuresByIp, getClientIp(req)]];
        const wait = lockedForAny(pairs);
        if (wait) {
            return res.status(429).json({ ok: false, message: tooManyAttemptsMessage(wait) });
        }

        try {
            await webauthnService.completeAdminLogin(
                req.body && req.body.challengeId,
                req.body && req.body.credential
            );
            clearAll(pairs);
            setAdminCookie(res, isSecureRequest(req));
            return res.json({ ok: true, redirectUrl: '/admin' });
        } catch (error) {
            failAll(pairs);
            return sendError(res, error);
        }
    });

    // --- Admin: revogar todos os aparelhos de um professor (celular perdido) ---

    app.post('/admin/teacher/webauthn/revoke', adminAuthMiddleware, requireCsrf, (req, res) => {
        const teacherId = Number.parseInt(req.body && req.body.teacherId, 10);
        if (!Number.isInteger(teacherId)) {
            return res.status(400).json({ ok: false, message: 'Professor inválido.' });
        }
        const removed = webauthnService.revokeAll(teacherId);
        return res.json({ ok: true, removed });
    });
}

module.exports = { registerWebauthnRoutes };
