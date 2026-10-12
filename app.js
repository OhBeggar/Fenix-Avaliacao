require('./load-env'); // <-- carrega as variáveis de ambiente do .env
const QRCode = require('qrcode');
const { getNetworkUrls } = require('./src/utils/network');

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const evaluationService = require('./src/services/evaluation-service');
const { commonCriteria, maleCriteria, femaleCriteria } = require('./src/constants');
const { isAdminAuthenticated, getAdminPayload, setAdminCookie, clearAdminCookie } = require('./src/utils/admin-auth');
const { isTeacherAuthenticated, setTeacherCookie, clearTeacherCookie, readTeacherPayload } = require('./src/utils/teacher-auth');
const { buildResultsPdf, buildAttachmentDisposition, getDynamicTitle } = require('./src/services/pdf-service');
const { buildResultsExcel } = require('./src/services/export-excel');
const config = require('./src/config');
const {
  safeEqual,
  deriveKey,
  signPayload,
  readSignedPayload,
  safeJson,
  cleanText,
  validatePassword,
  getClientIp,
} = require('./src/utils/security');
const {
  AttemptTracker,
  lockedForAny,
  failAll,
  clearAll,
  tooManyAttemptsMessage,
  requestLimiter,
} = require('./src/utils/rate-limit');
const webauthnService = require('./src/services/webauthn-service');
const { registerWebauthnRoutes } = require('./src/routes/webauthn-routes');

function validateSecurityConfig() {
  if (process.env.NODE_ENV !== 'production') return;

  const weakValues = new Set(['', 'troque-esta-senha', 'troque-este-segredo', 'avali-admin-cookie-secret']);
  const cookieSecret = process.env.ADMIN_COOKIE_SECRET || '';

  if (weakValues.has(config.adminPassword) || weakValues.has(cookieSecret)) {
    throw new Error('Configure ADMIN_PASSWORD e ADMIN_COOKIE_SECRET fortes em produção.');
  }
  if (config.adminPassword.length < 6) {
    throw new Error('ADMIN_PASSWORD deve ter pelo menos 6 caracteres em produção.');
  }
  if (cookieSecret.length < 32) {
    throw new Error('ADMIN_COOKIE_SECRET deve ter pelo menos 32 caracteres em produção.');
  }
}

validateSecurityConfig();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.locals.safeJson = safeJson;

// --- Proteção contra força bruta (em memória; instância única) ---
const FIFTEEN_MIN = 15 * 60 * 1000;
const adminLoginByIp = new AttemptTracker({ maxAttempts: 5, windowMs: FIFTEEN_MIN, lockMs: FIFTEEN_MIN });
const adminLoginGlobal = new AttemptTracker({ maxAttempts: 30, windowMs: FIFTEEN_MIN, lockMs: FIFTEEN_MIN });
const teacherLoginByIpName = new AttemptTracker({ maxAttempts: 6, windowMs: FIFTEEN_MIN, lockMs: FIFTEEN_MIN });
const teacherLoginByIp = new AttemptTracker({ maxAttempts: 25, windowMs: FIFTEEN_MIN, lockMs: FIFTEEN_MIN });
const teacherLoginByName = new AttemptTracker({ maxAttempts: 40, windowMs: 60 * 60 * 1000, lockMs: FIFTEEN_MIN });
const resetByIp = new AttemptTracker({ maxAttempts: 10, windowMs: FIFTEEN_MIN, lockMs: 30 * 60 * 1000 });
const resetByName = new AttemptTracker({ maxAttempts: 10, windowMs: 30 * 60 * 1000, lockMs: 30 * 60 * 1000 });
const teacherResetRequestLimiter = requestLimiter({
  windowMs: FIFTEEN_MIN,
  max: 5,
  keyFn: req => getClientIp(req),
  message: 'Se os dados estiverem corretos, enviamos um código para o e-mail cadastrado. Válido por 30 minutos.',
});
const pinByTeacher = new AttemptTracker({ maxAttempts: 10, windowMs: 10 * 60 * 1000, lockMs: 10 * 60 * 1000 });
const pinByIp = new AttemptTracker({ maxAttempts: 40, windowMs: 10 * 60 * 1000, lockMs: 10 * 60 * 1000 });
const checkTeacherLimiter = requestLimiter({ windowMs: 60 * 1000, max: 120 });
const generalLimiter = requestLimiter({ windowMs: 60 * 1000, max: 1500 });
const adminResetRequestLimiter = requestLimiter({
  windowMs: FIFTEEN_MIN,
  max: 5,
  keyFn: req => getClientIp(req),
  message: 'Se o e-mail estiver cadastrado, enviaremos um código válido por 30 minutos.',
});
const adminEmergencyLoginByIp = new AttemptTracker({ maxAttempts: 5, windowMs: FIFTEEN_MIN, lockMs: FIFTEEN_MIN });
const adminEmergencyLoginGlobal = new AttemptTracker({ maxAttempts: 25, windowMs: FIFTEEN_MIN, lockMs: FIFTEEN_MIN });

const TEACHER_COOKIE_NAME = 'teacher_access';
const ACCESS_COOKIE_MAX_AGE_MS = 1000 * 60 * 60 * 8;
const CSRF_TOKEN_MAX_AGE_MS = 1000 * 60 * 60 * 8;

// Middlewares
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  if (isSecureRequest(req)) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  }
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; ')
  );

  if (
    req.path.startsWith('/admin')
    || req.path.startsWith('/evaluate')
    || req.path.startsWith('/turmas')
    || req.path.startsWith('/results')
    || req.path.startsWith('/export_pdf')
    || req.path.startsWith('/export_excel')
    || req.path.startsWith('/api')
    || req.path.startsWith('/events')
    || req.path.startsWith('/login')
    || req.path.startsWith('/professor')
    || req.path.startsWith('/teacher')
  ) {
    res.setHeader('Cache-Control', 'no-store');
  }

  next();
});
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'static')));
app.use(generalLimiter);

app.use((req, res, next) => {
  if (isAdminAuthenticated(req)) return next();

  const teacher = readTeacherPayload(req.cookies[TEACHER_COOKIE_NAME]);
  if (!teacher?.mustChangePassword) return next();

  const allowedWhileChangingPassword = req.path === '/avaliacao/alterar-senha'
    || (req.path === '/teacher/logout' && req.method === 'POST');
  if (allowedWhileChangingPassword) return next();

  return res.redirect('/avaliacao/alterar-senha');
});

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'templates'));

// Inicializar banco de dados
evaluationService.initDb();

// Server-Sent Events: EventEmitter para comunicar mudanças ao cliente (PINs, sessões)
const EventEmitter = require('events');
const serverEvents = new EventEmitter();
app.locals.serverEvents = serverEvents;

// Middleware de autenticação admin
function adminAuthMiddleware(req, res, next) {
  if (!isAdminAuthenticated(req)) {
    const payload = getAdminPayload(req, true);
    const expiredEmergency = payload?.adminAuthMode === 'emergency'
      && Date.parse(payload.adminEmergencyUntil || '') <= Date.now();
    return res.redirect(expiredEmergency ? '/admin/login?erro=sessao_expirada' : '/admin/login');
  }
  next();
}

// Middleware de autenticação professor
function teacherAuthMiddleware(req, res, next) {
  if (!isTeacherAuthenticated(req)) {
    return res.redirect('/login-teachers');
  }
  next();
}

// Middleware para permitir admin OU professor
function adminOrTeacherAuthMiddleware(req, res, next) {
  if (isAdminAuthenticated(req) || isTeacherAuthenticated(req)) {
    return next();
  }
  if (req.path.startsWith('/admin')) {
    return res.redirect('/admin/login');
  } else {
    return res.redirect('/login-teachers');
  }
}

function isSecureRequest(req) {
  return Boolean(req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https');
}

// Helper para obter detalhes da sessão (admin ou professor)
function getAuthDetails(req) {
  let user = null;
  let isAdmin = false;
  let isTeacher = false;

  if (isAdminAuthenticated(req)) {
    isAdmin = true;
    user = { type: 'admin', name: 'Administrador' };
  } else if (isTeacherAuthenticated(req)) {
    isTeacher = true;
    const teacherPayload = readTeacherPayload(req.cookies['teacher_access']);
    if (teacherPayload) {
      user = { type: 'teacher', id: teacherPayload.evaluatorId, name: teacherPayload.evaluatorName };
    }
  }
  const adminPayload = isAdmin ? getAdminPayload(req) : null;
  return {
    user,
    isAdmin,
    isTeacher,
    adminAuthMode: adminPayload?.adminAuthMode || 'normal',
    adminEmergencyUntil: adminPayload?.adminEmergencyUntil || null,
  };
}

function getAdminLocals(message = null, extra = {}) {
  let authDetails = { isAdmin: true, isTeacher: false, user: { type: 'admin', name: 'Administrador' } };
  if (this && this.req) {
    authDetails = getAuthDetails(this.req);
  }

  const activeSessions = evaluationService.getActiveSessions();
  const latestSession = activeSessions[0] || null;

  return {
    teachers: evaluationService.getTeacherList(),
    webauthnCounts: webauthnService.countByTeacher(),
    turmas: evaluationService.getTurmas(),
    allCandidates: evaluationService.getCandidatesByTurma('all'),
    activeStatus: evaluationService.getActiveEvaluatorStatus(),
    history: evaluationService.getEvaluationHistory(),
    sessionCode: latestSession ? latestSession.code : null,
    currentTurmaName: latestSession ? latestSession.turma_name : null,
    currentTurmaId: latestSession ? latestSession.turma_id : null,
    activeSessions: activeSessions,
    message,
    ...authDetails,
    ...extra,
  };
}

// Chaves separadas por finalidade: um token de CSRF nunca vale como cookie de avaliação, etc.
const ACCESS_MASTER = config.adminCookieValue || config.adminPassword || 'avali-local-secret';
const EVALUATION_KEY = deriveKey(ACCESS_MASTER, 'evaluation');
const CSRF_KEY = deriveKey(ACCESS_MASTER, 'csrf');

function isAjaxRequest(req) {
  return Boolean(req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest' || req.is('application/json'));
}

// Erro de validação nas rotas do painel admin: JSON para chamadas fetch, página para formulários.
function respondAdminError(req, res, message, status = 400) {
  if (isAjaxRequest(req)) {
    return res.status(status).json({ ok: false, message });
  }
  return res.status(status).render('adm', getAdminLocals({ type: 'error', text: message }));
}

function signAccessPayload(payload) {
  return signPayload(payload, EVALUATION_KEY);
}

function readAccessPayload(token) {
  return readSignedPayload(token, EVALUATION_KEY);
}

function setAccessCookie(req, res, name, payload) {
  res.cookie(name, signAccessPayload({
    ...payload,
    iat: Date.now(),
    exp: Date.now() + ACCESS_COOKIE_MAX_AGE_MS,
  }), {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecureRequest(req),
    maxAge: ACCESS_COOKIE_MAX_AGE_MS,
  });
}

function clearAccessCookie(req, res, name) {
  res.clearCookie(name, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecureRequest(req),
  });
}

// O token CSRF fica amarrado à sessão (cookies de admin/professor da requisição):
// um token obtido em outra sessão não serve para atacar esta.
function csrfBinding(req) {
  const cookies = req.cookies || {};
  return crypto
    .createHash('sha256')
    .update(`${cookies[config.adminCookieName] || ''}|${cookies[TEACHER_COOKIE_NAME] || ''}`)
    .digest('base64url');
}

function createCsrfToken(req) {
  return signPayload({
    type: 'csrf',
    b: csrfBinding(req),
    iat: Date.now(),
    exp: Date.now() + CSRF_TOKEN_MAX_AGE_MS,
  }, CSRF_KEY);
}

function verifyCsrfToken(token, req) {
  const payload = readSignedPayload(token, CSRF_KEY);
  if (!payload || payload.type !== 'csrf' || typeof payload.b !== 'string') return false;
  return safeEqual(payload.b, csrfBinding(req));
}

function csrfTokenFromRequest(req) {
  return req.body?._csrf || req.headers['x-csrf-token'];
}

function requireCsrf(req, res, next) {
  if (verifyCsrfToken(csrfTokenFromRequest(req), req)) {
    return next();
  }

  if (req.is('application/json') || (req.accepts('json') && !req.accepts('html'))) {
    return res.status(403).json({ success: false, message: 'Token CSRF inválido ou ausente.' });
  }

  return res.status(403).send('Token CSRF inválido ou ausente.');
}

app.use((req, res, next) => {
  res.locals.csrfToken = createCsrfToken(req);
  res.locals.webauthn = webauthnService.publicConfig();
  next();
});

function evaluationCookieName(turmaId) {
  return `evaluation_access_${turmaId}`;
}

function clearTeacherAccessCookiesAndRelatedCookies(req, res) {
  clearTeacherCookie(res, isSecureRequest(req));
  evaluationService.getTurmas().forEach((turma) => {
    clearAccessCookie(req, res, evaluationCookieName(turma.id));
  });
}

function hasEvaluationAccess(req, turmaId, evaluatorName) {
  // O cookie de avaliação só vale para o professor que está logado agora.
  const teacherPayload = readTeacherPayload(req.cookies[TEACHER_COOKIE_NAME]);
  if (!teacherPayload || teacherPayload.evaluatorName !== evaluatorName) return false;

  const payload = readAccessPayload(req.cookies[evaluationCookieName(turmaId)]);
  if (!payload || payload.type !== 'evaluation') return false;
  if (String(payload.evaluatorName) !== String(evaluatorName) || String(payload.turmaId) !== String(turmaId)) return false;

  const activeSession = evaluationService.getActiveSessionForTurma(turmaId);
  if (!activeSession) return false;
  return String(payload.sessionId) === String(activeSession.id);
}

function getTeacherSession(req) {
  const payload = readTeacherPayload(req.cookies['teacher_access']);
  if (!payload) return null;
  const teacher = evaluationService.getTeacherById(payload.evaluatorId);
  if (!teacher || teacher.name !== payload.evaluatorName) return null;
  return teacher;
}

function getLiveSessionState(turmaId = null) {
  const turmas = turmaId ? [{ id: turmaId }] : evaluationService.getTurmas();
  const activeTurmaIds = turmas
    .filter(turma => Boolean(evaluationService.getActiveSessionForTurma(turma.id)))
    .map(turma => turma.id);

  return {
    hasLiveSession: activeTurmaIds.length > 0,
    activeTurmaIds,
  };
}

// === ROTAS PÚBLICAS ===

// Landing pública
app.get('/', (req, res) => {
  res.render('landing');
});

app.get('/em-breve', (req, res) => {
  const indexHtml = fs.readFileSync(path.join(__dirname, 'templates', 'index.html'), 'utf8');
  const svg = indexHtml.match(/<svg\b[\s\S]*?<\/svg>/i)?.[0] || '';
  res.render('em-breve', { svg });
});

// Home - Login da avaliação
app.get('/avaliacao', (req, res) => {
  res.render('home', { 
    message: req.query.message || null,
    showForgot: false
  });
});

app.get('/avaliacao/alterar-senha', (req, res) => {
  const teacher = readTeacherPayload(req.cookies[TEACHER_COOKIE_NAME]);
  if (!teacher) return res.redirect('/avaliacao?message=Faça login para continuar.');
  if (!teacher.mustChangePassword) return res.redirect(`/turmas/${encodeURIComponent(teacher.evaluatorName)}`);
  res.render('teacher-change-password', { message: null });
});

app.post('/avaliacao/alterar-senha', requireCsrf, (req, res) => {
  const teacher = readTeacherPayload(req.cookies[TEACHER_COOKIE_NAME]);
  if (!teacher) return res.redirect('/avaliacao?message=Faça login para continuar.');
  if (!teacher.mustChangePassword) return res.redirect(`/turmas/${encodeURIComponent(teacher.evaluatorName)}`);

  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const password2 = typeof req.body.password2 === 'string' ? req.body.password2 : '';
  if (password !== password2) {
    return res.status(400).render('teacher-change-password', { message: 'As senhas não coincidem.' });
  }
  if (password.trim() === '1532') {
    return res.status(400).render('teacher-change-password', { message: 'Escolha uma senha diferente da padrão 1532.' });
  }
  const passwordError = validatePassword(password, { name: teacher.evaluatorName });
  if (passwordError) {
    return res.status(400).render('teacher-change-password', { message: passwordError });
  }

  try {
    evaluationService.changeTeacherPassword(teacher.evaluatorId, password);
    setTeacherCookie(res, teacher.evaluatorId, teacher.evaluatorName, isSecureRequest(req), { mustChangePassword: false });
    return res.redirect(`/turmas/${encodeURIComponent(teacher.evaluatorName)}`);
  } catch (error) {
    return res.status(400).render('teacher-change-password', { message: error.message || 'Não foi possível atualizar a senha.' });
  }
});

const teacherResetMessage = 'Se os dados estiverem corretos, enviamos um código para o e-mail cadastrado. Válido por 30 minutos.';

function renderTeacherForgot(req, res, message = null, status = 200) {
  return res.status(status).render('teacher-forgot', { message });
}

app.get(['/avaliacao/esqueci-senha', '/professor/esqueci-senha'], (req, res) => {
  renderTeacherForgot(req, res);
});

app.post(['/avaliacao/esqueci-senha', '/professor/esqueci-senha'], requireCsrf, teacherResetRequestLimiter, async (req, res) => {
  try {
    await evaluationService.requestTeacherResetByEmail(req.body.name, req.body.email);
  } catch (error) {
    console.error('Falha ao solicitar reset de senha do professor:', error.message);
  }
  renderTeacherForgot(req, res, teacherResetMessage);
});

function renderTeacherReset(req, res, message = null, status = 200) {
  return res.status(status).render('teacher-reset', { message });
}

app.get(['/avaliacao/redefinir-senha', '/professor/redefinir-senha'], (req, res) => {
  renderTeacherReset(req, res);
});

app.post(['/avaliacao/redefinir-senha', '/professor/redefinir-senha'], requireCsrf, (req, res) => {
  const { password, password2 } = req.body;
  const name = String(req.body.name || '').trim().slice(0, 200);
  const code = String(req.body.code || '').trim();
  const resetPairs = [[resetByIp, getClientIp(req)], [resetByName, name.toLowerCase()]];
  const resetWait = lockedForAny(resetPairs);
  if (resetWait) {
    return renderTeacherReset(req, res, tooManyAttemptsMessage(resetWait), 429);
  }
  if (password !== password2) {
    return renderTeacherReset(req, res, 'As senhas não coincidem.', 400);
  }

  const passwordError = validatePassword(password, { name });
  if (passwordError) {
    return renderTeacherReset(req, res, passwordError, 400);
  }
  if (String(password || '').trim() === '1532') {
    return renderTeacherReset(req, res, 'Escolha uma senha diferente da padrão 1532.', 400);
  }

  try {
    evaluationService.resetPasswordWithPin(name, code, password);
    clearAll(resetPairs);
    return res.redirect(`/avaliacao?message=${encodeURIComponent('Senha atualizada. Faça login.')}`);
  } catch (error) {
    failAll(resetPairs);
    return renderTeacherReset(req, res, error.message, 400);
  }
});

// Login POST
app.post('/login', async (req, res) => {
  const { name, password } = req.body;

  // 1. Verificar Professor
  const loginName = String(name || '').trim().slice(0, 200);
  const loginPassword = typeof password === 'string' ? password : '';
  const loginIp = getClientIp(req);
  const loginPairs = [
    [teacherLoginByIpName, `${loginIp}|${loginName.toLowerCase()}`],
    [teacherLoginByIp, loginIp],
    [teacherLoginByName, loginName.toLowerCase()],
  ];
  const loginWait = lockedForAny(loginPairs);
  if (loginWait) {
    return res.status(429).render('home', { message: tooManyAttemptsMessage(loginWait) });
  }

  const teacher = evaluationService.verifyTeacher(loginName, loginPassword);
  if (!teacher) {
    failAll(loginPairs);
    return res.render('home', { 
      message: 'Professor ou senha inválidos.',
      showForgot: true,
      professorName: loginName
    });
  }

  clearAll([loginPairs[0]]);
  setTeacherCookie(res, teacher.id, teacher.name, isSecureRequest(req), {
    mustChangePassword: teacher.mustChangePassword,
  });

  if (teacher.mustChangePassword) return res.redirect('/avaliacao/alterar-senha');

  // 2. Redirecionar para seleção de turmas
  res.redirect(`/turmas/${encodeURIComponent(teacher.name)}`);
});

// API: Verificar se professor está cadastrado (para validação em tempo real no login)
app.post('/api/check-teacher', checkTeacherLimiter, (req, res) => {
  const { name } = req.body;
  if (!name || typeof name !== 'string') {
    return res.json({ exists: false });
  }
  res.json({ exists: Boolean(evaluationService.getTeacherByName(name)) });
});

app.post('/teacher/logout', requireCsrf, (req, res) => {
  clearTeacherAccessCookiesAndRelatedCookies(req, res);
  res.redirect('/avaliacao');
});

// Página de Seleção de Turmas
app.get('/turmas/:name', (req, res) => {
  const evaluatorName = req.params.name; // o Express já decodifica os parâmetros
  const teacher = readTeacherPayload(req.cookies['teacher_access']);
  if (!teacher) return res.redirect('/avaliacao?message=Faça login para acessar suas turmas.');

  if (teacher.evaluatorName !== evaluatorName) {
    return res.redirect(`/turmas/${encodeURIComponent(teacher.evaluatorName)}`);
  }

  const turmas = evaluationService.getTurmas().map(turma => {
    const activeSession = evaluationService.getActiveSessionForTurma(turma.id);
    return {
      ...turma,
      hasActiveEvaluation: Boolean(activeSession),
    };
  });
  const activeEvaluationTurmas = turmas
    .filter(turma => turma.hasActiveEvaluation)
    .map(turma => ({
      id: turma.id,
      name: turma.name,
      teacher_name: turma.teacher_name,
    }));

  res.render('turmas', {
    evaluatorName,
    turmas,
    activeEvaluationTurmas,
    message: req.query.message || null,
  });
});

// Sala da Turma com reconhecimento de professor e verificação de acesso sem senha
app.get('/turmas/:name/:turmaId', (req, res) => {
  const evaluatorName = req.params.name; // o Express já decodifica os parâmetros
  const turmaId = parseInt(req.params.turmaId, 10);
  const teacher = readTeacherPayload(req.cookies['teacher_access']);
  if (!teacher) return res.redirect('/avaliacao?message=Faça login para acessar suas turmas.');

  if (teacher.evaluatorName !== evaluatorName) {
    return res.redirect(`/turmas/${encodeURIComponent(teacher.evaluatorName)}/${turmaId}`);
  }

  const turma = evaluationService.getTurmaById(turmaId);
  if (!turma) return res.status(404).send('Turma não encontrada');

  const candidates = evaluationService.getCandidatesByTurma(turmaId);
  const attendanceSummary = evaluationService.getAttendanceSummary(turmaId);
  const activeSession = evaluationService.getActiveSessionForTurma(turmaId);

  res.render('turma-sala', {
    evaluatorName: teacher.evaluatorName,
    turma,
    candidates,
    attendanceSummary,
    activeSession,
    canManageAttendance: teacher.evaluatorId === turma.teacher_id,
    message: req.query.message || null,
  });
});

app.post('/turmas/:name/:turmaId/aulas', requireCsrf, (req, res) => {
  const evaluatorName = req.params.name; // o Express já decodifica os parâmetros
  const turmaId = parseInt(req.params.turmaId, 10);
  const turma = evaluationService.getTurmaById(turmaId);
  const teacher = readTeacherPayload(req.cookies['teacher_access']);

  if (!teacher) {
    return res.status(401).send('Faça login novamente.');
  }

  if (!turma) {
    return res.status(404).send('Turma não encontrada.');
  }

  if (teacher.evaluatorName !== evaluatorName || teacher.evaluatorId !== turma.teacher_id) {
    return res.status(403).send('Acesso negado. Apenas o professor responsável pode alterar a presença.');
  }

  try {
    evaluationService.setAttendanceForTurma(turmaId, req.body);
    res.redirect(`/turmas/${encodeURIComponent(evaluatorName)}/${turmaId}`);
  } catch (error) {
    res.redirect(`/turmas/${encodeURIComponent(evaluatorName)}/${turmaId}?message=${encodeURIComponent(error.message)}`);
  }
});

app.post('/turmas/:name/:turmaId/ritmos', requireCsrf, (req, res) => {
  const evaluatorName = req.params.name; // o Express já decodifica os parâmetros
  const turmaId = parseInt(req.params.turmaId, 10);
  const turma = evaluationService.getTurmaById(turmaId);
  const teacher = readTeacherPayload(req.cookies['teacher_access']);

  if (!teacher) {
    return res.status(401).send('Faça login novamente.');
  }

  if (!turma) {
    return res.status(404).send('Turma não encontrada.');
  }

  if (teacher.evaluatorName !== evaluatorName || teacher.evaluatorId !== turma.teacher_id) {
    return res.status(403).send('Acesso negado. Apenas o professor responsável pode alterar os ritmos.');
  }

  try {
    const { ritmosAvaliados } = req.body;
    evaluationService.updateTurmaRitmos(turmaId, ritmosAvaliados);
    res.redirect(`/turmas/${encodeURIComponent(evaluatorName)}/${turmaId}`);
  } catch (error) {
    res.redirect(`/turmas/${encodeURIComponent(evaluatorName)}/${turmaId}?message=${encodeURIComponent(error.message || 'Erro ao atualizar ritmos.')}`);
  }
});

// API: Verificar Código PIN da avaliação
app.post('/turmas/evaluate-access', requireCsrf, (req, res) => {
  const turmaId = Number.parseInt(req.body.turmaId, 10);
  const code = String(req.body.code ?? '').trim();
  const teacher = getTeacherSession(req);
  if (!teacher) {
    return res.status(401).json({ success: false, message: 'Faça login novamente para acessar a avaliação.' });
  }
  
  if (!Number.isInteger(turmaId) || turmaId <= 0) {
    return res.status(400).json({ success: false, message: 'Turma inválida.' });
  }

  // Limite de tentativas: o PIN tem só 4 dígitos
  const pinPairs = [[pinByTeacher, String(teacher.id)], [pinByIp, getClientIp(req)]];
  const pinWait = lockedForAny(pinPairs);
  if (pinWait) {
    return res.status(429).json({ success: false, message: tooManyAttemptsMessage(pinWait) });
  }

  // 1. Verificar se o código existe e está ativo
  const session = evaluationService.verifySessionCode(code, turmaId);
  if (!session) {
    failAll(pinPairs);
    return res.json({ success: false, message: 'PIN inválido, expirado ou fora da data de avaliação.' });
  }
  clearAll([pinPairs[0]]);

  setAccessCookie(req, res, evaluationCookieName(turmaId), {
    type: 'evaluation',
    evaluatorName: teacher.name,
    turmaId,
    sessionId: session.id,
  });

  res.json({ success: true, redirectUrl: `/evaluate/${encodeURIComponent(teacher.name)}?turmaId=${turmaId}` });
});


// Avaliação (Corrigido para carregar notas salvas)
app.get('/evaluate/:name', (req, res) => {
  const evaluatorName = req.params.name; // o Express já decodifica os parâmetros
  const turmaId = req.query.turmaId ? parseInt(req.query.turmaId, 10) : null;
  const teacher = readTeacherPayload(req.cookies['teacher_access']);
  if (!teacher) return res.redirect('/avaliacao?message=Faça login para acessar suas turmas.');

  if (!turmaId || !hasEvaluationAccess(req, turmaId, evaluatorName)) {
    return res.redirect(`/turmas/${encodeURIComponent(evaluatorName)}?message=${encodeURIComponent('Informe o PIN ativo antes de avaliar.')}`);
  }

  const attendanceSummary = evaluationService.getAttendanceSummary(turmaId);
  const candidates = evaluationService.getCandidatesByTurma(turmaId).map(candidate => ({
    ...candidate,
    presence: attendanceSummary[candidate.id]?.label || candidate.presence,
  }));

  // Identifica ou cria o avaliador
  const evaluator = evaluationService.getOrCreateEvaluator(evaluatorName);
  evaluationService.touchEvaluatorForSession(evaluator.id, turmaId);

  // Busca as notas salvas usando o ID do avaliador
  const currentScores = evaluationService.getEvaluatorScores(evaluator.id, turmaId);

  const activeEvaluatorStatus = evaluationService.getActiveEvaluatorStatus(turmaId);
  const { commonCriteria, maleCriteria, femaleCriteria } = require('./src/constants');

  const turma = evaluationService.getTurmaById(turmaId);

  res.render('avaliacao', {
    evaluatorName,
    turmaId,
    turma,
    candidates,
    currentScores,
    activeEvaluatorStatus,
    commonCriteria,
    maleCriteria,
    femaleCriteria,
  });
});

app.post('/evaluate/:name', requireCsrf, (req, res) => {
  const evaluatorName = req.params.name; // o Express já decodifica os parâmetros
  const turmaId = req.query.turmaId ? parseInt(req.query.turmaId, 10) : null;
  const teacher = readTeacherPayload(req.cookies['teacher_access']);
  const isAjax = req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest';

  if (!teacher) {
    if (isAjax) return res.status(401).json({ ok: false, message: 'Faça login novamente.' });
    return res.redirect('/avaliacao?message=Faça login para acessar suas turmas.');
  }

  if (!turmaId || !hasEvaluationAccess(req, turmaId, evaluatorName)) {
    if (isAjax) return res.status(403).json({ ok: false, message: 'Acesso à avaliação não liberado.' });
    return res.status(403).send('Acesso à avaliação não liberado.');
  }

  try {
    const evaluator = evaluationService.getOrCreateEvaluator(evaluatorName);
    evaluationService.touchEvaluatorForSession(evaluator.id, turmaId);
    evaluationService.saveScores(evaluator.id, req.body, turmaId);

    if (isAjax) {
      return res.json({ ok: true, message: 'Notas salvas com sucesso!' });
    }

    return res.redirect(`/evaluate/${encodeURIComponent(evaluatorName)}?turmaId=${turmaId}&saved=1`);
  } catch (error) {
    console.error('Erro ao salvar notas:', error);
    if (isAjax) {
      return res.status(500).json({ ok: false, message: 'Erro ao salvar as notas.' });
    }
    return res.status(500).send('Erro ao salvar as notas.');
  }
});

// Endpoints de tempo real: exigem sessão de admin ou de professor.
function requireLiveAuth(req, res, next) {
  if (isAdminAuthenticated(req) || isTeacherAuthenticated(req)) return next();
  return res.status(401).json({ ok: false, message: 'Faça login para continuar.' });
}

const SSE_MAX_PER_IP = 20;
const SSE_MAX_TOTAL = 300;
const SSE_HEARTBEAT_MS = 25 * 1000;
const sseConnections = new Map();
let sseTotal = 0;

app.get('/api/evaluators/status', requireLiveAuth, (req, res) => {
  const turmaId = req.query.turmaId ? parseInt(req.query.turmaId, 10) : null;
  const { hasLiveSession } = getLiveSessionState(turmaId);

  if (!turmaId || !hasLiveSession) {
    return res.json({
      activeCount: 0,
      activeNames: [],
      activeEvaluators: [],
      timeoutMinutes: config.evaluatorOnlineWindowMinutes,
      sessionClosed: true,
    });
  }

  const teacher = getTeacherSession(req);
  const hasAuthorizedEvaluation = Boolean(teacher && hasEvaluationAccess(req, turmaId, teacher.name));
  if (hasAuthorizedEvaluation) {
    const evaluator = evaluationService.getOrCreateEvaluator(teacher.name);
    evaluationService.touchEvaluatorForSession(evaluator.id, turmaId);
  }

  const activeStatus = evaluationService.getActiveEvaluatorStatus(turmaId);
  res.json({
    ...activeStatus,
    activeNames: hasAuthorizedEvaluation ? activeStatus.activeNames : [],
    activeEvaluators: hasAuthorizedEvaluation ? activeStatus.activeEvaluators : [],
    sessionClosed: false,
  });
});

// Resultados em Tempo Real (SEM botão de PDF)
app.get('/results', adminAuthMiddleware, (req, res) => {
  const turmaId = req.query.turmaId ? parseInt(req.query.turmaId, 10) : null;
  const { hasLiveSession } = getLiveSessionState(turmaId);

  if (!turmaId || !hasLiveSession) {
    return res.redirect('/results/history');
  }

  const report = evaluationService.getResultsReport(turmaId);
  const activeSessions = evaluationService.getActiveSessions ? evaluationService.getActiveSessions() : [];
  const activeTurmas = activeSessions.map(s => ({ id: s.turma_id, name: s.turma_name }));
  const liveEvaluatorStatus = hasLiveSession
    ? evaluationService.getActiveEvaluatorStatus(turmaId)
    : {
      activeCount: 0,
      activeNames: [],
      activeEvaluators: [],
      timeoutMinutes: config.evaluatorOnlineWindowMinutes,
    };

  res.render('resultados', {
    ...report,
    turmas: activeTurmas,
    activeTurmas,
    selectedTurmaId: turmaId || '',
    liveEvaluatorStatus,
    sessionClosed: !hasLiveSession,
    canExportPdf: false,
    dynamicTitle: getDynamicTitle(report),
  });
});

// Exportar PDF (também com filtro opcional por turma)
app.get('/export_pdf', adminAuthMiddleware, async (req, res) => {
  try {
    const turmaId = req.query.turmaId ? parseInt(req.query.turmaId, 10) : null;
    const report = evaluationService.getResultsReport(turmaId);
    const pdfBytes = await buildResultsPdf(report);

    res.setHeader('Content-Type', 'application/pdf');
    // Nome do arquivo inclui o ID da turma se houver filtro
    const filename = turmaId ? `resultados-turma-${turmaId}.pdf` : 'resultados.pdf';
    res.setHeader('Content-Disposition', buildAttachmentDisposition(filename));
    res.send(Buffer.from(pdfBytes));
  } catch (error) {
    console.error('Erro ao gerar PDF:', error);
    res.status(500).send('Erro ao gerar PDF');
  }
});

// === NOVA ROTA: PDF do Histórico ===
app.get('/export_pdf/history/:eventId', adminAuthMiddleware, async (req, res) => {
  try {
    // Busca os dados congelados do histórico
    const report = evaluationService.getEvaluationHistoryReport(req.params.eventId);
    if (!report) return res.status(404).send('Histórico não encontrado.');
    
    // Gera o PDF com a biblioteca atual
    const pdfBytes = await buildResultsPdf(report);
    
    res.setHeader('Content-Type', 'application/pdf');
    // Gera um nome de arquivo seguro (ex: historico-Avaliacao-Teste.pdf)
    const filename = `historico-${report.event.title.replace(/[\s\/\\]/g, '_')}.pdf`;
    res.setHeader(
      'Content-Disposition',
      buildAttachmentDisposition(`historico-${report.event.title.replace(/[\s\/\\]/g, '_')}.pdf`)
    );
    res.send(Buffer.from(pdfBytes));
  } catch (error) {
    console.error('Erro ao gerar PDF do histórico:', error);
    res.status(500).send('Erro ao gerar PDF.');
  }
});

// === EXPORTAR EXCEL (.XLSX) ===

// Resultados ao vivo (com filtro opcional por turma)
app.get('/export_excel', adminAuthMiddleware, async (req, res) => {
  try {
    const turmaId = req.query.turmaId ? parseInt(req.query.turmaId, 10) : null;
    const report = evaluationService.getResultsReport(turmaId);
    const buffer = await buildResultsExcel(report);

    const filename = turmaId ? `resultados-turma-${turmaId}.xlsx` : 'resultados.xlsx';

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', buildAttachmentDisposition(filename));
    res.send(buffer);
  } catch (error) {
    console.error('Erro ao gerar Excel:', error);
    res.status(500).send('Erro ao gerar Excel');
  }
});

// Excel do Histórico
app.get('/export_excel/history/:eventId', adminAuthMiddleware, async (req, res) => {
  try {
    const report = evaluationService.getEvaluationHistoryReport(req.params.eventId);
    if (!report) return res.status(404).send('Histórico não encontrado.');

    const buffer = await buildResultsExcel(report);
    const safeTitle = (report.event?.title || 'historico')
      .replace(/[\s\/\\]+/g, '_')
      .slice(0, 80);

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      buildAttachmentDisposition(`historico-${safeTitle}.xlsx`)
    );
    res.send(buffer);
  } catch (error) {
    console.error('Erro ao gerar Excel do histórico:', error);
    res.status(500).send('Erro ao gerar Excel');
  }
});

// === ROTAS DE ADMIN ===

// Login Admin
app.get('/admin/login', (req, res) => {
  const message = req.query.erro === 'sessao_expirada' ? 'A sessão de emergência expirou. Entre novamente.' : null;
  res.render('admin-login', { message });
});

app.post('/admin/login', (req, res) => {
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const adminIp = getClientIp(req);
  const adminPairs = [[adminLoginByIp, adminIp], [adminLoginGlobal, 'admin']];
  const adminWait = lockedForAny(adminPairs);
  if (adminWait) {
    return res.status(429).render('admin-login', { message: tooManyAttemptsMessage(adminWait) });
  }
  
  if (config.adminPassword && safeEqual(password, config.adminPassword)) {
    clearAll(adminPairs);
    setAdminCookie(res, isSecureRequest(req));
    return res.redirect('/admin');
  }
  
  failAll(adminPairs);
  res.status(401).render('admin-login', { message: 'Senha incorreta.' });
});

app.get('/admin/forgot', (req, res) => {
  res.render('admin-forgot', { message: null });
});

app.post('/admin/forgot', requireCsrf, adminResetRequestLimiter, async (req, res) => {
  const genericMessage = 'Se o e-mail estiver cadastrado, enviaremos um código válido por 30 minutos.';
  try {
    await evaluationService.requestAdminResetCode(req.body.email);
  } catch (error) {
    console.error('Falha ao enviar código de emergência do admin:', error.message);
  }
  res.render('admin-forgot', { message: genericMessage });
});

app.get('/admin/emergency-login', (req, res) => {
  res.render('admin-emergency-login', { message: null });
});

app.post('/admin/emergency-login', requireCsrf, (req, res) => {
  const ip = getClientIp(req);
  const email = String(req.body.email || '').trim().toLowerCase();
  const pairs = [[adminEmergencyLoginByIp, ip], [adminEmergencyLoginGlobal, 'admin-emergency']];
  const wait = lockedForAny(pairs);
  if (wait) return res.status(429).render('admin-emergency-login', { message: tooManyAttemptsMessage(wait) });

  const result = evaluationService.consumeAdminResetCode(email, req.body.code);
  if (!result.ok) {
    failAll(pairs);
    return res.status(401).render('admin-emergency-login', { message: 'E-mail ou código inválido ou expirado.' });
  }

  clearAll(pairs);
  setAdminCookie(res, isSecureRequest(req), {
    adminAuthMode: 'emergency',
    adminEmergencyUntil: Date.parse(result.sessionExpiresAt),
  });
  return res.redirect('/admin');
});

app.post('/admin/logout', adminAuthMiddleware, requireCsrf, (req, res) => {
  clearAdminCookie(res, isSecureRequest(req));
  res.redirect('/admin/login');
});

// Admin Dashboard
app.get('/admin', adminAuthMiddleware, (req, res) => {
  res.render('adm', getAdminLocals.call({ req }, req.query.message ? { type: req.query.type, text: req.query.message } : null));
});

// SSE endpoint para clientes ouvirem eventos do servidor (PINs / sessões)
app.get('/events', requireLiveAuth, (req, res) => {
  const sseIp = getClientIp(req);
  if (sseTotal >= SSE_MAX_TOTAL || (sseConnections.get(sseIp) || 0) >= SSE_MAX_PER_IP) {
    return res.status(429).json({ ok: false, message: 'Muitas conexões abertas.' });
  }
  sseConnections.set(sseIp, (sseConnections.get(sseIp) || 0) + 1);
  sseTotal += 1;

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders && res.flushHeaders();

  // batimento periódico: mantém a conexão viva atrás do túnel e detecta clientes mortos
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (e) { /* ignore */ }
  }, SSE_HEARTBEAT_MS);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  const send = (data) => {
    try {
      const { code, ...safePayload } = data || {};
      res.write(`data: ${JSON.stringify(safePayload)}\n\n`);
    } catch (e) {
      // ignore
    }
  };

  // Envia um ping inicial para confirmar conexão
  send({ event: 'connected', time: new Date().toISOString() });

  const handler = (payload) => send(payload);
  serverEvents.on('session', handler);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseTotal = Math.max(0, sseTotal - 1);
    const remaining = (sseConnections.get(sseIp) || 1) - 1;
    if (remaining <= 0) sseConnections.delete(sseIp);
    else sseConnections.set(sseIp, remaining);
    serverEvents.removeListener('session', handler);
    try { res.end(); } catch (e) {}
  });
});

// Gerar Código de Sessão
app.post('/admin/generate-code', adminAuthMiddleware, requireCsrf, (req, res) => {
  const { turmaId } = req.body;
  const code = evaluationService.generateSessionCode(turmaId);
  const turma = evaluationService.getTurmas().find(t => t.id == turmaId);
  // Emite evento para clientes informando que uma sessão foi iniciada (PIN gerado)
  try {
    app.locals.serverEvents.emit('session', { event: 'session_started', turmaId: Number(turmaId) });
  } catch (e) {}

  res.redirect('/admin#audicao');
});

// Encerrar Sessão
app.post('/admin/end-session', adminAuthMiddleware, requireCsrf, (req, res) => {
  evaluationService.endCurrentSession();
  try { app.locals.serverEvents.emit('session', { event: 'session_ended' }); } catch (e) {}

  res.redirect('/admin#audicao');
});

app.post('/admin/close-evaluation', adminAuthMiddleware, requireCsrf, (req, res) => {
  try {
    const eventId = evaluationService.closeEvaluationEvent(req.body.turmaId, 'admin');
    try { app.locals.serverEvents.emit('session', { event: 'session_closed', turmaId: Number(req.body.turmaId) }); } catch (e) {}
    res.redirect('/admin#audicao');
  } catch (error) {
    res.render('adm', getAdminLocals({ type: 'error', text: error.message }));
  }
});

// Fechar semestre (para turmas selecionadas)
app.post('/admin/close-semester', adminAuthMiddleware, requireCsrf, (req, res) => {
  try {
    // turmaIds pode vir como uma string única ou um array
    let turmaIds = req.body.turmaIds || req.body.turmaId || [];
    if (!Array.isArray(turmaIds)) {
      turmaIds = turmaIds ? [turmaIds] : [];
    }
    // Normaliza para inteiros
    turmaIds = turmaIds.map(id => parseInt(id, 10)).filter(Boolean);

    if (turmaIds.length === 0) {
      return res.render('adm', getAdminLocals({ type: 'error', text: 'Nenhuma turma selecionada para fechamento.' }));
    }

    const result = evaluationService.closeSemesterForTurmas(turmaIds, 'admin', { preserveSnapshots: true });

    const successCount = result.successes.length;
    const errorCount = result.errors.length;

    const messages = [];
    if (successCount) messages.push(`${successCount} turma(s) fechada(s) com sucesso.`);
    if (errorCount) messages.push(`${errorCount} erro(s): ${result.errors.map(e => `Turma ${e.turmaId}: ${e.error}`).join('; ')}`);

    // Emite eventos de sessão encerrada para as turmas que foram fechadas
    try {
      result.successes.forEach(tid => app.locals.serverEvents.emit('session', { event: 'session_closed', turmaId: Number(tid) }));
    } catch (e) {}

    res.render('adm', getAdminLocals({ type: errorCount ? 'error' : 'success', text: messages.join(' ') }));
  } catch (error) {
    res.render('adm', getAdminLocals({ type: 'error', text: String(error.message || error) }));
  }
});

// Reabrir semestre (cria nova sessão) para uma turma específica
app.post('/admin/reopen-semester', adminAuthMiddleware, requireCsrf, (req, res) => {
  try {
    const turmaId = req.body.turmaId ? parseInt(req.body.turmaId, 10) : null;
    if (!turmaId) return res.render('adm', getAdminLocals({ type: 'error', text: 'Turma não informada.' }));

    const code = evaluationService.reopenSemesterForTurma(turmaId, 'admin');
    try { app.locals.serverEvents.emit('session', { event: 'session_started', turmaId: Number(turmaId) }); } catch (e) {}
    res.render('adm', getAdminLocals({ type: 'success', text: `Semestre reaberto. Novo código de sessão: ${code}` }));
  } catch (error) {
    res.render('adm', getAdminLocals({ type: 'error', text: String(error.message || error) }));
  }
});

// Adicionar Professor
app.post('/admin/teacher/add', adminAuthMiddleware, requireCsrf, (req, res) => {
  const { name, email } = req.body;
  const password = String(req.body.password || '').trim();
  const teacherName = cleanText(name, 100);
  if (!teacherName) {
    return respondAdminError(req, res, 'Informe o nome do professor.');
  }
  if (password && password !== '1532') {
    const teacherPasswordError = validatePassword(password, { name: teacherName });
    if (teacherPasswordError) return respondAdminError(req, res, teacherPasswordError);
  }

  try {
    evaluationService.addTeacher({ name: teacherName, email, password });
  } catch (error) {
    return respondAdminError(req, res, error.message || 'Não foi possível cadastrar o professor.');
  }

  res.render('adm', getAdminLocals({ type: 'success', text: `Professor ${teacherName} cadastrado.` }));
});

app.post('/admin/teacher/update', adminAuthMiddleware, requireCsrf, (req, res) => {
  const teacherId = Number.parseInt(req.body.teacherId, 10);
  const email = req.body.email;
  const password = String(req.body.password || '').trim();

  if (password && password !== '1532') {
    const passwordError = validatePassword(password);
    if (passwordError) return respondAdminError(req, res, passwordError);
  }

  try {
    evaluationService.updateTeacherProfile(teacherId, email, password);
  } catch (error) {
    return respondAdminError(req, res, error.message || 'Não foi possível atualizar o professor.');
  }

  res.render('adm', getAdminLocals({ type: 'success', text: 'Dados do professor atualizados.' }));
});

app.post('/admin/teacher/reset-code', adminAuthMiddleware, requireCsrf, (req, res) => {
  try {
    const teacherId = Number.parseInt(req.body.teacherId, 10);
    const { pin, expiresAt } = evaluationService.generateResetPin(teacherId);
    const isAjax = req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest';
    if (isAjax) return res.json({ ok: true, pin, expiresAt });
    return res.redirect('/admin#professores');
  } catch (error) {
    const isAjax = req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest';
    if (isAjax) return res.status(400).json({ ok: false, message: error.message });
    return res.redirect(`/admin?type=error&message=${encodeURIComponent(error.message || 'Não foi possível gerar o código.')}`);
  }
});

// Redefinir Senha Professor
app.post('/admin/teacher/reset-password', adminAuthMiddleware, requireCsrf, (req, res) => {
  const { teacherId, newPassword } = req.body;
  const newPasswordError = validatePassword(newPassword);
  if (newPasswordError) {
    return respondAdminError(req, res, newPasswordError);
  }
  evaluationService.resetTeacherPassword(teacherId, newPassword);

  res.render('adm', getAdminLocals({ type: 'success', text: 'Senha redefinida com sucesso.' }));
});

// Remover Professor
app.post('/admin/teacher/delete', adminAuthMiddleware, requireCsrf, (req, res) => {
  const { teacherId } = req.body;
  evaluationService.deleteTeacher(teacherId);

  res.render('adm', getAdminLocals({ type: 'success', text: 'Professor removido com sucesso.' }));
});

// Criar Turma
app.post('/admin/turma/add', adminAuthMiddleware, requireCsrf, (req, res) => {
  const { name, teacherId, ritmosAvaliados } = req.body;
  const turmaName = cleanText(name, 100);
  const turmaTeacherId = Number.parseInt(teacherId, 10);
  if (!turmaName) {
    return respondAdminError(req, res, 'Informe o nome da turma.');
  }
  if (!evaluationService.getTeacherById(turmaTeacherId)) {
    return respondAdminError(req, res, 'Professor responsável inválido.');
  }
  evaluationService.createTurma(turmaName, turmaTeacherId, cleanText(ritmosAvaliados, 200));

  res.render('adm', getAdminLocals({ type: 'success', text: 'Turma criada com sucesso.' }));
});

app.post('/admin/turma/ritmos', adminOrTeacherAuthMiddleware, requireCsrf, (req, res) => {
  const { turmaId, ritmosAvaliados } = req.body;
  const { isTeacher, user } = getAuthDetails(req);

  try {
    const turma = evaluationService.getTurmaById(turmaId);
    if (!turma) throw new Error('Turma não encontrada.');

    if (isTeacher && user.id !== turma.teacher_id) {
      return res.status(403).send('Acesso negado. Esta turma não pertence ao seu perfil de professor.');
    }

    evaluationService.updateTurmaRitmos(turmaId, ritmosAvaliados);
    res.redirect(`/admin/turma/${turmaId}?success=1`);
  } catch (error) {
    res.redirect(`/admin/turma/${turmaId}?type=error&message=${encodeURIComponent(error.message || 'Erro ao atualizar ritmos.')}`);
  }
});

// Adicionar Aluno (Admin)
app.post('/admin/candidate/add', adminAuthMiddleware, requireCsrf, (req, res) => {
  const { gender, status, turmaId } = req.body;
  const name = cleanText(req.body.name, 120);
  if (!name) {
    return respondAdminError(req, res, 'Informe o nome do aluno.');
  }
  
  evaluationService.createCandidate({ 
    name, 
    gender, 
    presence: '0%',
    status,
    turma_id: turmaId ? parseInt(turmaId, 10) : null 
  });

  res.render('adm', getAdminLocals({ type: 'success', text: `Aluno ${name} cadastrado com sucesso!` }));
});

app.post('/admin/candidate/bulk', adminAuthMiddleware, requireCsrf, (req, res) => {
  const isAjax = req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest';
  const { turmaId, gender, status, names } = req.body;
  const list = (Array.isArray(names) ? names : String(names || '').split(/\r?\n/))
    .map(name => cleanText(name, 120))
    .filter(Boolean)
    .slice(0, 500);

  if (!turmaId || !list.length) {
    const message = 'Informe a turma e ao menos um nome.';
    if (isAjax) return res.status(400).json({ ok: false, message });
    return res.redirect('/admin#alunos');
  }

  try {
    const result = evaluationService.addCandidatesBulk({
      turmaId: Number.parseInt(turmaId, 10),
      gender: gender === 'male' ? 'male' : 'female',
      status: status === 'Auxiliar' ? 'Auxiliar' : 'Bolsista',
      names: list,
    });
    const message = `${result.created} aluno(s) adicionado(s).${result.skipped.length ? ` ${result.skipped.length} ignorado(s).` : ''}`;
    if (isAjax) return res.json({ ok: true, message, ...result });
    return res.redirect('/admin#alunos');
  } catch (error) {
    if (isAjax) return res.status(500).json({ ok: false, message: error.message });
    return res.redirect('/admin#alunos');
  }
});

app.post('/admin/candidate/status', adminAuthMiddleware, requireCsrf, (req, res) => {
  const { candidateId, status, turmaId } = req.body;
  try {
    evaluationService.updateCandidateStatus(candidateId, status);
    res.redirect(`/admin/turma/${turmaId}`);
  } catch (error) {
    res.redirect(`/admin/turma/${turmaId}?type=error&message=${encodeURIComponent(error.message || 'Erro ao atualizar status.')}`);
  }
});

app.get('/admin/turma/:id/students-simple', adminAuthMiddleware, (req, res) => {
  const turmaId = Number.parseInt(req.params.id, 10);
  if (!turmaId) return res.status(400).json({ ok: false, error: 'Turma inválida.' });
  res.json({ ok: true, students: evaluationService.getStudentsSimpleByTurma(turmaId) });
});

app.post('/admin/turma/candidate/remove', adminAuthMiddleware, requireCsrf, (req, res) => {
  const { candidateId, turmaId } = req.body;
  try {
    const candidate = evaluationService.removeCandidateFromTurma(candidateId, turmaId);
    const name = candidate?.name || 'Aluno';
    res.redirect(`/admin/turma/${turmaId}?type=success&message=${encodeURIComponent(`“${name}” desvinculado da turma.`)}`);
  } catch (error) {
    res.redirect(`/admin/turma/${turmaId}?type=error&message=${encodeURIComponent(error.message || 'Erro ao desvincular aluno.')}`);
  }
});

// Vincular Alunos à Turma
app.post('/admin/turma/assign', adminAuthMiddleware, requireCsrf, (req, res) => {
  const { turmaId, candidates } = req.body;

  // 1. Remove APENAS os alunos que já estavam nesta turma específica
  const allCands = evaluationService.getCandidatesByTurma('all');
  allCands.forEach(c => {
    // Só remove se o aluno estiver vinculado a ESTA turma
    if (c.turma_id == turmaId) {
      evaluationService.assignCandidateToTurma(c.id, null);
    }
  });

  // 2. Vincula os selecionados
  if (Array.isArray(candidates)) {
    candidates.forEach(id => evaluationService.assignCandidateToTurma(id, turmaId));
  }

  res.render('adm', getAdminLocals({ type: 'success', text: 'Alunos vinculados com sucesso.' }));
});

// Visualizar detalhes de uma turma (lista de alunos)
app.get('/admin/turma/:id', adminOrTeacherAuthMiddleware, async (req, res) => {
  const { isAdmin, isTeacher, user } = getAuthDetails(req);
  const turmaId = parseInt(req.params.id, 10);
  const turmas = evaluationService.getTurmas();
  const turma = turmas.find(t => t.id === turmaId);
  
  if (isTeacher && turma && user.id !== turma.teacher_id) {
    return res.status(403).send('Acesso negado. Esta turma não pertence ao seu perfil de professor.');
  }
  
  if (!turma) {
    return res.status(404).send('Turma não encontrada');
  }
  
  const candidates = evaluationService.getCandidatesByTurma(turmaId);
  const attendanceSummary = evaluationService.getAttendanceSummary(turmaId);
  
  res.render('admin-turma-detalhes', {
    isAdmin,
    isTeacher,
    user,
    ...getAuthDetails(req),
    turma,
    candidates,
    attendanceSummary,
    message: req.query.message ? {
      type: req.query.type === 'success' ? 'success' : 'error',
      text: req.query.message,
    } : null,
  });
});

app.post('/admin/turma/:id/aulas', adminOrTeacherAuthMiddleware, requireCsrf, (req, res) => {
  const { isTeacher, user } = getAuthDetails(req);
  const turmaId = req.params.id;
  const turma = evaluationService.getTurmaById(turmaId);
  
  if (isTeacher && turma && user.id !== turma.teacher_id) {
    return res.status(403).send('Acesso negado. Esta turma não pertence ao seu perfil de professor.');
  }

  try {
    evaluationService.setAttendanceForTurma(turmaId, req.body);
    res.redirect(`/admin/turma/${turmaId}?type=success&message=${encodeURIComponent('Presença atualizada com sucesso.')}`);
  } catch (error) {
    res.redirect(`/admin/turma/${turmaId}?type=error&message=${encodeURIComponent(error.message || 'Erro ao salvar presença.')}`);
  }
});

app.post('/admin/candidate/delete', adminAuthMiddleware, requireCsrf, (req, res) => {
  const candidateId = Number(req.body.candidateId || req.body.id);
  const isAjax = req.xhr || req.headers.accept?.includes('application/json');
  try {
    if (!candidateId) throw new Error('ID do aluno inválido.');
    const result = evaluationService.deleteCandidate(candidateId);
    if (isAjax) return res.json({ ok: true, ...result });
    return res.redirect('/admin#alunos');
  } catch (error) {
    if (isAjax) return res.status(400).json({ ok: false, error: error.message || 'Erro ao remover aluno.' });
    return res.redirect(`/admin#alunos`);
  }
});

// Rota para renomear a turma (Admin)
app.post('/admin/turma/rename', adminAuthMiddleware, requireCsrf, (req, res) => {
    const { turmaId, newName } = req.body;
    try {
        evaluationService.updateTurmaName(turmaId, cleanText(newName, 100));
        // Redireciona de volta para a página de detalhes da turma com mensagem de sucesso
        res.redirect(`/admin/turma/${turmaId}?type=success&message=${encodeURIComponent('Nome da turma atualizado com sucesso.')}`);
    } catch (error) {
        res.redirect(`/admin/turma/${turmaId}?type=error&message=${encodeURIComponent(error.message || 'Erro ao renomear turma.')}`);
    }
});

// Excluir Turma
app.post('/admin/turma/delete', adminAuthMiddleware, requireCsrf, (req, res) => {
  const { turmaId } = req.body;
  evaluationService.deleteTurma(turmaId);

  res.render('adm', getAdminLocals({ type: 'success', text: 'Turma removida com sucesso.' }));
});

// Histórico de Avaliações (Lista)
app.get('/results/history', adminAuthMiddleware, (req, res) => {
  const history = evaluationService.getEvaluationHistory();
  res.render('historico', {
    history,
    message: req.query.message ? {
      type: req.query.type === 'success' ? 'success' : 'error',
      text: req.query.message,
    } : null,
  });
});

// Excluir um evento do histórico oficial
app.post('/admin/history/delete', adminAuthMiddleware, requireCsrf, (req, res) => {
  try {
    evaluationService.deleteEvaluationHistoryEvent(req.body.eventId);
    res.redirect(`/results/history?type=success&message=${encodeURIComponent('Histórico removido com sucesso.')}`);
  } catch (error) {
    res.redirect(`/results/history?type=error&message=${encodeURIComponent(error.message || 'Erro ao remover histórico.')}`);
  }
});

app.get('/results/history/:eventId', adminAuthMiddleware, (req, res) => {
  const report = evaluationService.getEvaluationHistoryReport(req.params.eventId);
  if (!report) return res.status(404).send('Histórico não encontrado');

  res.render('resultados', {
    ...report,
    turmas: evaluationService.getTurmas(),
    selectedTurmaId: report.event.turma_id || '',
    historicalEvent: report.event,
    canExportPdf: true,
    dynamicTitle: getDynamicTitle(report),
  });
});

// --- Login por biometria (WebAuthn) ---
registerWebauthnRoutes(app, {
  requireCsrf,
  getTeacherSession,
  adminAuthMiddleware,
  setTeacherCookie,
  isSecureRequest,
  isAdminAuthenticated,
  setAdminCookie,
});

// --- Página não encontrada e tratador de erros (nunca vaza stack trace) ---
app.use((req, res) => {
  if (req.accepts(['html', 'json']) === 'json') {
    return res.status(404).json({ ok: false, message: 'Não encontrado.' });
  }
  return res.status(404).send('Página não encontrada.');
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  const status = Number(err.status || err.statusCode);
  const safeStatus = status >= 400 && status < 500 ? status : 500;
  if (safeStatus === 500) console.error('Erro não tratado:', err);

  const message = safeStatus === 500 ? 'Erro interno. Tente novamente.' : 'Requisição inválida.';
  if (req.is('application/json') || req.accepts(['html', 'json']) === 'json') {
    return res.status(safeStatus).json({ ok: false, success: false, message });
  }
  return res.status(safeStatus).send(message);
});

// Iniciar servidor
const PORT = config.port;
const HOST = config.host;

if (require.main === module) {
app.listen(PORT, HOST, () => {
  console.log(`\n🎯 Servidor rodando em:`);
  
  const urls = getNetworkUrls(HOST, PORT, config.publicBaseUrl);
  urls.forEach((url, index) => {
    console.log(`   ${index === 0 ? '📱' : '💻'} ${url}`);
  });
  
  // Gerar QR Code para o primeiro URL (geralmente o localhost ou URL pública)
  const primaryUrl = urls[0];
  console.log('\n📲 QR Code de acesso rápido:');
  
  QRCode.toString(primaryUrl, { type: 'terminal', small: true }, (err, qrCode) => {
    if (err) {
      console.error('Erro ao gerar QR Code:', err);
      return;
    }
    console.log(qrCode);
    console.log(`\n✨ Aponte a câmera do celular para o QR Code acima!\n`);
  });
  
  console.log('');
});
}

module.exports = app;
