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
const { buildResultsPdf } = require('./src/services/pdf-service');
const config = require('./src/config');

const app = express();

// Middlewares
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

function getAdminLocals(message = null, extra = {}) {
  return {
    teachers: evaluationService.getTeacherList(),
    turmas: evaluationService.getTurmas(),
    allCandidates: evaluationService.getCandidatesByTurma('all'),
    activeStatus: evaluationService.getActiveEvaluatorStatus(),
    history: evaluationService.getEvaluationHistory(),
    message,
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
    return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function setAccessCookie(res, name, payload) {
  res.cookie(name, signAccessPayload(payload), {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 8,
  });
}

function hasAccess(req, cookieName, expected) {
  const payload = readAccessPayload(req.cookies[cookieName]);
  if (!payload) return false;
  return Object.entries(expected).every(([key, value]) => String(payload[key]) === String(value));
}

function turmaCookieName(turmaId) {
  return `turma_access_${turmaId}`;
}

function evaluationCookieName(turmaId) {
  return `evaluation_access_${turmaId}`;
}

function getAttendanceRecordsFromBody(body = {}) {
  if (body.attendance && typeof body.attendance === 'object') {
    return body.attendance;
  }

  return Object.entries(body).reduce((records, [key, value]) => {
    const match = /^attendance\[(\d+)\]$/.exec(key);
    if (match) {
      records[match[1]] = value;
    }
    return records;
  }, {});
}

// === ROTAS PÚBLICAS ===

// Home - Login
app.get('/', (req, res) => {
  res.render('home', { message: null });
});

// Login POST
app.post('/login', async (req, res) => {
  const { name, password } = req.body;

  // 1. Verificar Professor
  const teacher = evaluationService.verifyTeacher(name, password);
  if (!teacher) {
    return res.render('home', { message: 'Professor ou senha inválidos.' });
  }

  // 2. Redirecionar para seleção de turmas
  res.redirect(`/turmas/${encodeURIComponent(name)}`);
});

// API: Verificar se professor está cadastrado (para validação em tempo real no login)
app.post('/api/check-teacher', (req, res) => {
  const { name } = req.body;
  if (!name || typeof name !== 'string') {
    return res.json({ exists: false });
  }
  const teachers = evaluationService.getTeacherList();
  const exists = teachers.some(
    t => t.name && t.name.toLowerCase().trim() === name.toLowerCase().trim()
  );
  res.json({ exists });
});

// Página de Seleção de Turmas
app.get('/turmas/:name', (req, res) => {
  const evaluatorName = decodeURIComponent(req.params.name);
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
app.post('/turmas/access', (req, res) => {
  const { evaluatorName, turmaId, password } = req.body;

  if (!evaluationService.verifyTurmaPassword(turmaId, password)) {
    return res.json({ success: false, message: 'Senha da turma inválida.' });
  }

  setAccessCookie(res, turmaCookieName(turmaId), {
    type: 'turma',
    evaluatorName,
    turmaId,
  });

  res.json({ success: true, redirectUrl: `/turmas/${encodeURIComponent(evaluatorName)}/${turmaId}` });
});

// Sala da Turma
app.get('/turmas/:name/:turmaId', (req, res) => {
  const evaluatorName = decodeURIComponent(req.params.name);
  const turmaId = parseInt(req.params.turmaId, 10);

  if (!hasAccess(req, turmaCookieName(turmaId), { type: 'turma', evaluatorName, turmaId })) {
    return res.redirect(`/turmas/${encodeURIComponent(evaluatorName)}`);
  }

  const turma = evaluationService.getTurmaById(turmaId);
  if (!turma) return res.status(404).send('Turma não encontrada');

  const candidates = evaluationService.getCandidatesByTurma(turmaId);
  const attendanceSummary = evaluationService.getAttendanceSummary(turmaId);
  const meetings = evaluationService.getClassMeetings(turmaId);
  const meetingAttendanceMaps = Object.fromEntries(
    meetings.map(meeting => [meeting.id, evaluationService.getAttendanceMapForMeeting(meeting.id)])
  );
  const activeSession = evaluationService.getActiveSessionForTurma(turmaId);

  res.render('turma-sala', {
    evaluatorName,
    turma,
    candidates,
    attendanceSummary,
    meetings,
    meetingAttendanceMaps,
    activeSession,
    canManageAttendance: turma.teacher_name === evaluatorName,
    message: req.query.message || null,
  });
});

app.post('/turmas/:name/:turmaId/meetings', (req, res) => {
  const evaluatorName = decodeURIComponent(req.params.name);
  const turmaId = parseInt(req.params.turmaId, 10);
  const turma = evaluationService.getTurmaById(turmaId);

  if (!hasAccess(req, turmaCookieName(turmaId), { type: 'turma', evaluatorName, turmaId })) {
    return res.status(403).send('Acesso à turma não liberado.');
  }

  if (!turma || turma.teacher_name !== evaluatorName) {
    return res.status(403).send('Somente o professor responsável pode criar chamadas.');
  }

  evaluationService.createClassMeeting(turmaId, {
    title: req.body.title,
    meetingDate: req.body.meetingDate,
    createdBy: evaluatorName,
  });

  res.redirect(`/turmas/${encodeURIComponent(evaluatorName)}/${turmaId}`);
});

app.post('/turmas/:name/:turmaId/attendance/:meetingId', (req, res) => {
  const evaluatorName = decodeURIComponent(req.params.name);
  const turmaId = parseInt(req.params.turmaId, 10);
  const turma = evaluationService.getTurmaById(turmaId);

  if (!hasAccess(req, turmaCookieName(turmaId), { type: 'turma', evaluatorName, turmaId })) {
    return res.status(403).send('Acesso à turma não liberado.');
  }

  if (!turma || turma.teacher_name !== evaluatorName) {
    return res.status(403).send('Somente o professor responsável pode lançar presença.');
  }

  try {
    evaluationService.markAttendance(req.params.meetingId, getAttendanceRecordsFromBody(req.body), evaluatorName, turmaId);
    res.redirect(`/turmas/${encodeURIComponent(evaluatorName)}/${turmaId}`);
  } catch (error) {
    res.redirect(`/turmas/${encodeURIComponent(evaluatorName)}/${turmaId}?message=${encodeURIComponent(error.message)}`);
  }
});

// API: Verificar Código PIN da avaliação
app.post('/turmas/evaluate-access', (req, res) => {
  const { evaluatorName, turmaId, code } = req.body;
  
  // 1. Verificar se o código existe e está ativo
  const session = evaluationService.verifySessionCode(code, turmaId);
  if (!session) {
    return res.json({ success: false, message: 'PIN inválido, expirado ou fora da data de avaliação.' });
  }

  setAccessCookie(res, evaluationCookieName(turmaId), {
    type: 'evaluation',
    evaluatorName,
    turmaId,
    sessionId: session.id,
  });

  res.json({ success: true, redirectUrl: `/evaluate/${encodeURIComponent(evaluatorName)}?turmaId=${turmaId}` });
});


// Avaliação (Corrigido para carregar notas salvas)
app.get('/evaluate/:name', (req, res) => {
  const evaluatorName = decodeURIComponent(req.params.name);
  const turmaId = req.query.turmaId ? parseInt(req.query.turmaId, 10) : null;
  if (!turmaId || !hasAccess(req, evaluationCookieName(turmaId), { type: 'evaluation', evaluatorName, turmaId })) {
    return res.redirect(`/turmas/${encodeURIComponent(evaluatorName)}?message=${encodeURIComponent('Informe o PIN ativo antes de avaliar.')}`);
  }

  const attendanceSummary = evaluationService.getAttendanceSummary(turmaId);
  const candidates = evaluationService.getCandidatesByTurma(turmaId).map(candidate => ({
    ...candidate,
    presence: attendanceSummary[candidate.id]?.label || candidate.presence,
  }));

  // Identifica ou cria o avaliador
  const evaluator = evaluationService.getOrCreateEvaluator(evaluatorName);

  // Busca as notas salvas usando o ID do avaliador
  const currentScores = evaluationService.getEvaluatorScores(evaluator.id);

  const activeEvaluatorStatus = evaluationService.getActiveEvaluatorStatus();
  const { commonCriteria, maleCriteria, femaleCriteria } = require('./src/constants');

  res.render('avaliacao', {
    evaluatorName,
    turmaId,
    candidates,
    currentScores,
    activeEvaluatorStatus,
    commonCriteria,
    maleCriteria,
    femaleCriteria,
  });
});

app.post('/evaluate/:name', (req, res) => {
  const evaluatorName = decodeURIComponent(req.params.name);
  const turmaId = req.query.turmaId ? parseInt(req.query.turmaId, 10) : null;
  if (!turmaId || !hasAccess(req, evaluationCookieName(turmaId), { type: 'evaluation', evaluatorName, turmaId })) {
    return res.status(403).send('Acesso à avaliação não liberado.');
  }

  const evaluator = evaluationService.getOrCreateEvaluator(evaluatorName);

  evaluationService.saveScores(evaluator.id, req.body);
  res.redirect(`/evaluate/${encodeURIComponent(evaluatorName)}?turmaId=${turmaId}&saved=1`);
});

app.get('/api/evaluators/status', (req, res) => {
  if (req.query.evaluatorName) {
    const evaluator = evaluationService.getOrCreateEvaluator(String(req.query.evaluatorName));
    evaluationService.getEvaluatorScores(evaluator.id);
  }
  res.json(evaluationService.getActiveEvaluatorStatus());
});

// Resultados em Tempo Real (SEM botão de PDF)
app.get('/results', (req, res) => {
  const turmaId = req.query.turmaId ? parseInt(req.query.turmaId, 10) : null;
  const report = evaluationService.getResultsReport(turmaId);
  const turmas = evaluationService.getTurmas();

  res.render('resultados', {
    ...report,
    turmas,
    selectedTurmaId: turmaId || '',
    canExportPdf: false, // Remove o PDF da página de resultados
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
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
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
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(Buffer.from(pdfBytes));
  } catch (error) {
    console.error('Erro ao gerar PDF do histórico:', error);
    res.status(500).send('Erro ao gerar PDF.');
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
    setAdminCookie(res);
    return res.redirect('/admin');
  }
  
  res.render('admin-login', { message: 'Senha incorreta.' });
});

app.post('/admin/logout', (req, res) => {
  clearAdminCookie(res);
  res.redirect('/');
});

// Admin Dashboard
app.get('/admin', adminAuthMiddleware, (req, res) => {
  const activeSessions = evaluationService.getActiveSessions();
  const latestSession = activeSessions[0] || null;

  res.render('adm', getAdminLocals(null, {
    sessionCode: latestSession ? latestSession.code : null,
    currentTurmaName: latestSession ? latestSession.turma_name : null,
    currentTurmaId: latestSession ? latestSession.turma_id : null,
    activeSessions: activeSessions,
  }));
});

// SSE endpoint para clientes ouvirem eventos do servidor (PINs / sessões)
app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders && res.flushHeaders();

  const send = (data) => {
    try {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
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
app.post('/admin/generate-code', adminAuthMiddleware, (req, res) => {
  const { turmaId } = req.body;
  const code = evaluationService.generateSessionCode(turmaId);
  const turma = evaluationService.getTurmas().find(t => t.id == turmaId);
  // Emite evento para clientes informando que uma sessão foi iniciada (PIN gerado)
  try {
    app.locals.serverEvents.emit('session', { event: 'session_started', turmaId: Number(turmaId), code });
  } catch (e) {}

  res.redirect('/admin');
});

// Encerrar Sessão
app.post('/admin/end-session', adminAuthMiddleware, (req, res) => {
  evaluationService.endCurrentSession();
  try { app.locals.serverEvents.emit('session', { event: 'session_ended' }); } catch (e) {}

  res.redirect('/admin');
});

app.post('/admin/close-evaluation', adminAuthMiddleware, (req, res) => {
  try {
    const eventId = evaluationService.closeEvaluationEvent(req.body.turmaId, 'admin');
    try { app.locals.serverEvents.emit('session', { event: 'session_closed', turmaId: Number(req.body.turmaId) }); } catch (e) {}
    res.redirect('/admin');
  } catch (error) {
    res.render('adm', getAdminLocals({ type: 'error', text: error.message }));
  }
});

// Fechar semestre (para turmas selecionadas)
app.post('/admin/close-semester', adminAuthMiddleware, (req, res) => {
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
app.post('/admin/reopen-semester', adminAuthMiddleware, (req, res) => {
  try {
    const turmaId = req.body.turmaId ? parseInt(req.body.turmaId, 10) : null;
    if (!turmaId) return res.render('adm', getAdminLocals({ type: 'error', text: 'Turma não informada.' }));

    const code = evaluationService.reopenSemesterForTurma(turmaId, 'admin');
    try { app.locals.serverEvents.emit('session', { event: 'session_started', turmaId: Number(turmaId), code }); } catch (e) {}
    res.render('adm', getAdminLocals({ type: 'success', text: `Semestre reaberto. Novo código de sessão: ${code}` }));
  } catch (error) {
    res.render('adm', getAdminLocals({ type: 'error', text: String(error.message || error) }));
  }
});

// Adicionar Professor
app.post('/admin/teacher/add', adminAuthMiddleware, (req, res) => {
  const { name, password } = req.body;
  evaluationService.addTeacher(name, password);

  res.render('adm', getAdminLocals({ type: 'success', text: `Professor ${name} cadastrado.` }));
});

// Redefinir Senha Professor
app.post('/admin/teacher/reset-password', adminAuthMiddleware, (req, res) => {
  const { teacherId, newPassword } = req.body;
  evaluationService.resetTeacherPassword(teacherId, newPassword);

  res.render('adm', getAdminLocals({ type: 'success', text: 'Senha redefinida com sucesso.' }));
});

// Remover Professor
app.post('/admin/teacher/delete', adminAuthMiddleware, (req, res) => {
  const { teacherId } = req.body;
  evaluationService.deleteTeacher(teacherId);

  res.render('adm', getAdminLocals({ type: 'success', text: 'Professor removido com sucesso.' }));
});

// Criar Turma
app.post('/admin/turma/add', adminAuthMiddleware, (req, res) => {
  const { name, teacherId, accessPassword } = req.body;
  evaluationService.createTurma(name, teacherId, accessPassword);

  res.render('adm', getAdminLocals({ type: 'success', text: 'Turma criada com sucesso.' }));
});

app.post('/admin/turma/password', adminAuthMiddleware, (req, res) => {
  const { turmaId, accessPassword } = req.body;
  evaluationService.setTurmaPassword(turmaId, accessPassword);
  res.render('adm', getAdminLocals({ type: 'success', text: 'Senha da turma atualizada.' }));
});

// Adicionar Aluno (Admin)
app.post('/admin/candidate/add', adminAuthMiddleware, (req, res) => {
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
app.post('/admin/turma/assign', adminAuthMiddleware, (req, res) => {
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
app.get('/admin/turma/:id', adminAuthMiddleware, (req, res) => {
  const turmaId = parseInt(req.params.id, 10);
  const turmas = evaluationService.getTurmas();
  const turma = turmas.find(t => t.id === turmaId);
  
  if (!turma) {
    return res.status(404).send('Turma não encontrada');
  }
  
  const candidates = evaluationService.getCandidatesByTurma(turmaId);
  const meetings = evaluationService.getClassMeetings(turmaId);
  const attendanceSummary = evaluationService.getAttendanceSummary(turmaId);
  const meetingAttendanceMaps = Object.fromEntries(
    meetings.map(meeting => [meeting.id, evaluationService.getAttendanceMapForMeeting(meeting.id)])
  );
  
  res.render('admin-turma-detalhes', {
    turma,
    candidates,
    meetings,
    attendanceSummary,
    meetingAttendanceMaps,
    message: null,
  });
});

app.post('/admin/turma/:id/meetings', adminAuthMiddleware, (req, res) => {
  evaluationService.createClassMeeting(req.params.id, {
    title: req.body.title,
    meetingDate: req.body.meetingDate,
    createdBy: 'admin',
  });
  res.redirect(`/admin/turma/${req.params.id}`);
});

app.post('/admin/turma/:id/attendance/:meetingId', adminAuthMiddleware, (req, res) => {
  try {
    evaluationService.markAttendance(req.params.meetingId, getAttendanceRecordsFromBody(req.body), 'admin', req.params.id);
  } catch (error) {
    console.error('Erro ao salvar presença:', error);
  }
  res.redirect(`/admin/turma/${req.params.id}`);
});

// Excluir aluno (atualizado para redirecionar de volta para a turma)
app.post('/admin/candidate/delete', adminAuthMiddleware, (req, res) => {
  const { candidateId, turmaId } = req.body;
  evaluationService.deleteCandidate(candidateId);
  
  // Se veio de uma página de turma específica, redireciona de volta para ela
  if (turmaId) {
    return res.redirect(`/admin/turma/${turmaId}`);
  }

  // Senão, vai para a página principal de admin
  res.render('adm', getAdminLocals({ type: 'success', text: 'Aluno removido com sucesso.' }));
});

// Excluir Turma
app.post('/admin/turma/delete', adminAuthMiddleware, (req, res) => {
  const { turmaId } = req.body;
  evaluationService.deleteTurma(turmaId);

  res.render('adm', getAdminLocals({ type: 'success', text: 'Turma removida com sucesso.' }));
});

// Histórico de Avaliações (Lista)
app.get('/results/history', adminAuthMiddleware, (req, res) => {
  const history = evaluationService.getEvaluationHistory();
  res.render('historico', {
    history,
    message: null,
  });
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
