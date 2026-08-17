require('./load-env'); // <-- carrega as variáveis de ambiente do .env
const QRCode = require('qrcode');
const { getNetworkUrls } = require('./src/utils/network');

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const evaluationService = require('./src/services/evaluation-service');
const { commonCriteria, maleCriteria, femaleCriteria } = require('./src/constants');
const { isAdminAuthenticated, setAdminCookie, clearAdminCookie } = require('./src/utils/admin-auth');
const { isTeacherAuthenticated, setTeacherCookie, clearTeacherCookie, readTeacherPayload } = require('./src/utils/teacher-auth');
const { buildResultsPdf, buildAttachmentDisposition, getDynamicTitle } = require('./src/services/pdf-service');
const { buildResultsExcel } = require('./src/services/export-excel');
const config = require('./src/config');

function validateSecurityConfig() {
  if (process.env.NODE_ENV !== 'production') return;

  const weakValues = new Set(['', 'troque-esta-senha', 'troque-este-segredo', 'avali-admin-cookie-secret']);
  if (weakValues.has(config.adminPassword) || weakValues.has(process.env.ADMIN_COOKIE_SECRET || '')) {
    throw new Error('Configure ADMIN_PASSWORD e ADMIN_COOKIE_SECRET fortes em produção.');
  }
}

validateSecurityConfig();

const app = express();
app.set('trust proxy', 1);

const TEACHER_COOKIE_NAME = 'teacher_access';
const ACCESS_COOKIE_MAX_AGE_MS = 1000 * 60 * 60 * 8;
const CSRF_TOKEN_MAX_AGE_MS = 1000 * 60 * 60 * 8;

// Middlewares
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
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
  ) {
    res.setHeader('Cache-Control', 'no-store');
  }

  next();
});
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'static')));

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
    return res.redirect('/admin/login');
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
  return { user, isAdmin, isTeacher };
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

const ACCESS_SECRET = config.adminCookieValue || config.adminPassword || 'avali-local-secret';

function signAccessPayload(payload) {
  const raw = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', ACCESS_SECRET).update(raw).digest('base64url');
  return `${raw}.${signature}`;
}

function readAccessPayload(token) {
  if (!token || !token.includes('.')) return null;
  const [raw, signature] = token.split('.');
  const expected = crypto.createHmac('sha256', ACCESS_SECRET).update(raw).digest('base64url');
  if (Buffer.byteLength(signature) !== Buffer.byteLength(expected)) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (payload.exp && Date.now() > Number(payload.exp)) return null;
    return payload;
  } catch {
    return null;
  }
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

function hasAccess(req, cookieName, expected) {
  const payload = readAccessPayload(req.cookies[cookieName]);
  if (!payload) return false;
  return Object.entries(expected).every(([key, value]) => String(payload[key]) === String(value));
}

function createCsrfToken() {
  return signAccessPayload({
    type: 'csrf',
    iat: Date.now(),
    exp: Date.now() + CSRF_TOKEN_MAX_AGE_MS,
  });
}

function verifyCsrfToken(token) {
  const payload = readAccessPayload(token);
  return Boolean(payload && payload.type === 'csrf');
}

function csrfTokenFromRequest(req) {
  return req.body?._csrf || req.headers['x-csrf-token'];
}

function requireCsrf(req, res, next) {
  if (verifyCsrfToken(csrfTokenFromRequest(req))) {
    return next();
  }

  if (req.is('application/json') || (req.accepts('json') && !req.accepts('html'))) {
    return res.status(403).json({ success: false, message: 'Token CSRF inválido ou ausente.' });
  }

  return res.status(403).send('Token CSRF inválido ou ausente.');
}

app.use((req, res, next) => {
  res.locals.csrfToken = createCsrfToken();
  next();
});

function turmaCookieName(turmaId) {
  return `turma_access_${turmaId}`;
}

function evaluationCookieName(turmaId) {
  return `evaluation_access_${turmaId}`;
}

function clearTeacherAccessCookiesAndRelatedCookies(req, res) {
  clearTeacherCookie(res, isSecureRequest(req));
  evaluationService.getTurmas().forEach((turma) => {
    clearAccessCookie(req, res, turmaCookieName(turma.id));
    clearAccessCookie(req, res, evaluationCookieName(turma.id));
  });
}

function hasEvaluationAccess(req, turmaId, evaluatorName) {
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

// Home - Login da avaliação
app.get('/avaliacao', (req, res) => {
  res.render('home', { message: req.query.message || null });
});

// Login POST
app.post('/login', async (req, res) => {
  const { name, password } = req.body;

  // 1. Verificar Professor
  const teacher = evaluationService.verifyTeacher(name, password);
  if (!teacher) {
    return res.render('home', { message: 'Professor ou senha inválidos.' });
  }

  setTeacherCookie(res, teacher.id, teacher.name, isSecureRequest(req));

  // 2. Redirecionar para seleção de turmas
  res.redirect(`/turmas/${encodeURIComponent(teacher.name)}`);
});

// API: Verificar se professor está cadastrado (para validação em tempo real no login)
app.post('/api/check-teacher', (req, res) => {
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
  const evaluatorName = decodeURIComponent(req.params.name);
  const teacher = readTeacherPayload(req.cookies['teacher_access']);
  if (!teacher) return res.redirect('/avaliacao?message=Faça login para acessar suas turmas.');

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

// API: Verificar senha da turma
app.post('/turmas/access', requireCsrf, (req, res) => {
  const { turmaId, password } = req.body;
  const teacher = getTeacherSession(req);
  if (!teacher) {
    return res.status(401).json({ success: false, message: 'Faça login novamente para acessar a turma.' });
  }

  if (!evaluationService.verifyTurmaPassword(turmaId, password)) {
    return res.json({ success: false, message: 'Senha da turma inválida.' });
  }

  setAccessCookie(req, res, turmaCookieName(turmaId), {
    type: 'turma',
    evaluatorName: teacher.name,
    turmaId,
  });

  res.json({ success: true, redirectUrl: `/turmas/${encodeURIComponent(teacher.name)}/${turmaId}` });
});

// Sala da Turma
app.get('/turmas/:name/:turmaId', (req, res) => {
  const evaluatorName = decodeURIComponent(req.params.name);
  const turmaId = parseInt(req.params.turmaId, 10);
  const teacher = readTeacherPayload(req.cookies['teacher_access']);
  if (!teacher) return res.redirect('/avaliacao?message=Faça login para acessar suas turmas.');

  if (!hasAccess(req, turmaCookieName(turmaId), { type: 'turma', evaluatorName, turmaId })) {
    return res.redirect(`/turmas/${encodeURIComponent(evaluatorName)}`);
  }

  const turma = evaluationService.getTurmaById(turmaId);
  if (!turma) return res.status(404).send('Turma não encontrada');

  const candidates = evaluationService.getCandidatesByTurma(turmaId);
  const attendanceSummary = evaluationService.getAttendanceSummary(turmaId);
  const activeSession = evaluationService.getActiveSessionForTurma(turmaId);

  res.render('turma-sala', {
    evaluatorName,
    turma,
    candidates,
    attendanceSummary,
    activeSession,
    canManageAttendance: teacher.evaluatorId === turma.teacher_id,
    message: req.query.message || null,
  });
});

app.post('/turmas/:name/:turmaId/aulas', requireCsrf, (req, res) => {
  const evaluatorName = decodeURIComponent(req.params.name);
  const turmaId = parseInt(req.params.turmaId, 10);
  const turma = evaluationService.getTurmaById(turmaId);
  const teacher = readTeacherPayload(req.cookies['teacher_access']);

  if (!hasAccess(req, turmaCookieName(turmaId), { type: 'turma', evaluatorName, turmaId })) {
    return res.status(403).send('Acesso à turma não liberado.');
  }

  if (!turma) {
    return res.status(404).send('Turma não encontrada.');
  }

  if (teacher.evaluatorId !== turma.teacher_id) {
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
  const evaluatorName = decodeURIComponent(req.params.name);
  const turmaId = parseInt(req.params.turmaId, 10);
  const turma = evaluationService.getTurmaById(turmaId);
  const teacher = readTeacherPayload(req.cookies['teacher_access']);

  if (!hasAccess(req, turmaCookieName(turmaId), { type: 'turma', evaluatorName, turmaId })) {
    return res.status(403).send('Acesso à turma não liberado.');
  }

  if (!turma) {
    return res.status(404).send('Turma não encontrada.');
  }

  if (teacher.evaluatorId !== turma.teacher_id) {
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
  const { turmaId, code } = req.body;
  const teacher = getTeacherSession(req);
  if (!teacher) {
    return res.status(401).json({ success: false, message: 'Faça login novamente para acessar a avaliação.' });
  }
  
  // 1. Verificar se o código existe e está ativo
  const session = evaluationService.verifySessionCode(code, turmaId);
  if (!session) {
    return res.json({ success: false, message: 'PIN inválido, expirado ou fora da data de avaliação.' });
  }

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
  const evaluatorName = decodeURIComponent(req.params.name);
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
  const evaluatorName = decodeURIComponent(req.params.name);
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

app.get('/api/evaluators/status', (req, res) => {
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
  res.render('admin-login', { message: null });
});

app.post('/admin/login', (req, res) => {
  const { password } = req.body;
  
  if (password === config.adminPassword) {
    setAdminCookie(res, isSecureRequest(req));
    return res.redirect('/admin');
  }
  
  res.render('admin-login', { message: 'Senha incorreta.' });
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
app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders && res.flushHeaders();

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
  const { name, password } = req.body;
  evaluationService.addTeacher(name, password);

  res.render('adm', getAdminLocals({ type: 'success', text: `Professor ${name} cadastrado.` }));
});

// Redefinir Senha Professor
app.post('/admin/teacher/reset-password', adminAuthMiddleware, requireCsrf, (req, res) => {
  const { teacherId, newPassword } = req.body;
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
  const { name, teacherId, accessPassword, ritmosAvaliados } = req.body;
  evaluationService.createTurma(name, teacherId, accessPassword, ritmosAvaliados);

  res.render('adm', getAdminLocals({ type: 'success', text: 'Turma criada com sucesso.' }));
});

app.post('/admin/turma/password', adminAuthMiddleware, requireCsrf, (req, res) => {
  const { turmaId, accessPassword } = req.body;
  evaluationService.setTurmaPassword(turmaId, accessPassword);
  res.render('adm', getAdminLocals({ type: 'success', text: 'Senha da turma atualizada.' }));
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
  const { name, gender, status, turmaId } = req.body;
  
  evaluationService.createCandidate({ 
    name, 
    gender, 
    presence: '0%',
    status,
    turma_id: turmaId ? parseInt(turmaId, 10) : null 
  });

  res.render('adm', getAdminLocals({ type: 'success', text: `Aluno ${name} cadastrado com sucesso!` }));
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

// Excluir aluno (atualizado para redirecionar de volta para a turma)
app.post('/admin/candidate/delete', adminAuthMiddleware, requireCsrf, (req, res) => {
  const { candidateId, turmaId } = req.body;
  evaluationService.deleteCandidate(candidateId);
  
  // Se veio de uma página de turma específica, redireciona de volta para ela
  if (turmaId) {
    return res.redirect(`/admin/turma/${turmaId}`);
  }

  // Senão, vai para a página principal de admin
  res.render('adm', getAdminLocals({ type: 'success', text: 'Aluno removido com sucesso.' }));
});

// Rota para renomear a turma (Admin)
app.post('/admin/turma/rename', adminAuthMiddleware, requireCsrf, (req, res) => {
    const { turmaId, newName } = req.body;
    try {
        evaluationService.updateTurmaName(turmaId, newName);
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
