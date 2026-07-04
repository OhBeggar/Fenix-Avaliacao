const config = require('../config');
const { db, runInTransaction } = require('../db');
const defaultCandidates = require('../data/default-candidates');
const {
  commonCriteria,
  maleCriteria,
  femaleCriteria,
  getCriteriaFor,
} = require('../constants');
const {
  average,
  calculateFinalNote,
  calculateTotalPoints,
  determineResultStatus,
  isPresenceEligible,
  numericValue,
  parsePresence,
  roundOneDecimal,
} = require('./scoring-rules');
const crypto = require('crypto');

const SCORE_PATTERN = /^\d+$/;
const PASSWORD_ALGORITHM = 'scrypt';
const FIXED_SCORE_CRITERIA = ['presenca_auxilios', 'comprometimento_eventos'];
const FIXED_SCORE_CRITERIA_SET = new Set(FIXED_SCORE_CRITERIA);

// --- Inicialização do Banco de Dados ---

function initDb() {
  // Tabela de Candidatos (Alunos)
  db.exec(`CREATE TABLE IF NOT EXISTS candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    gender TEXT,
    presence TEXT,
    status TEXT,
    turma_id INTEGER
  )`);

  // Tabela de Avaliadores (Professores)
  db.exec(`CREATE TABLE IF NOT EXISTS evaluators (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    password_hash TEXT,
    last_seen_at TEXT
  )`);

  // Tabela de Turmas
  db.exec(`CREATE TABLE IF NOT EXISTS turmas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    teacher_id INTEGER,
    access_password_hash TEXT,
    FOREIGN KEY (teacher_id) REFERENCES evaluators(id)
  )`);

  // Tabela de Sessões Ativas (Segurança do Código)
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE,
    turma_id INTEGER,
    status TEXT DEFAULT 'active',
    created_at TEXT,
    session_date TEXT,
    closed_at TEXT,
    FOREIGN KEY (turma_id) REFERENCES turmas(id)
  )`);

  // Tabela de Notas
  db.exec(`CREATE TABLE IF NOT EXISTS scores (
    evaluator_id INTEGER,
    candidate_id INTEGER,
    criterion TEXT,
    score TEXT,
    PRIMARY KEY(evaluator_id, candidate_id, criterion)
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS evaluator_session_presence (
    session_id INTEGER NOT NULL,
    turma_id INTEGER NOT NULL,
    evaluator_id INTEGER NOT NULL,
    last_seen_at TEXT NOT NULL,
    PRIMARY KEY(session_id, evaluator_id),
    FOREIGN KEY (session_id) REFERENCES sessions(id),
    FOREIGN KEY (turma_id) REFERENCES turmas(id),
    FOREIGN KEY (evaluator_id) REFERENCES evaluators(id)
  )`);

  // Sistema antigo de chamadas (class_meetings/attendance_records) foi substituído
  // pelo modelo simplificado de "total de aulas x aulas presentes". Remove tabelas antigas.
  db.exec('DROP TABLE IF EXISTS attendance_records');
  db.exec('DROP TABLE IF EXISTS class_meetings');

  db.exec(`CREATE TABLE IF NOT EXISTS evaluation_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    turma_id INTEGER,
    session_id INTEGER,
    title TEXT,
    closed_at TEXT,
    closed_by TEXT,
    num_evaluators INTEGER,
    evaluator_names TEXT,
    FOREIGN KEY (turma_id) REFERENCES turmas(id),
    FOREIGN KEY (session_id) REFERENCES sessions(id)
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS evaluation_snapshots (
    event_id INTEGER NOT NULL,
    candidate_id INTEGER,
    candidate_name TEXT,
    payload TEXT NOT NULL,
    PRIMARY KEY(event_id, candidate_id),
    FOREIGN KEY (event_id) REFERENCES evaluation_events(id)
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS candidate_fixed_scores (
    candidate_id INTEGER NOT NULL,
    criterion TEXT NOT NULL,
    score INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(candidate_id, criterion),
    FOREIGN KEY (candidate_id) REFERENCES candidates(id)
  )`);

  // Garante que a coluna turma_id exista em candidates (para atualizações de DB antigos)
  try {
    db.exec("ALTER TABLE candidates ADD COLUMN turma_id INTEGER");
  } catch (e) {}
  try {
    db.exec("ALTER TABLE turmas ADD COLUMN access_password_hash TEXT");
  } catch (e) {}
  try {
    db.exec("ALTER TABLE sessions ADD COLUMN session_date TEXT");
  } catch (e) {}
  try {
    db.exec("ALTER TABLE sessions ADD COLUMN closed_at TEXT");
  } catch (e) {}
  try {
    db.exec("ALTER TABLE sessions ADD COLUMN expires_at TEXT");
  } catch (e) {}
  try {
    db.exec("ALTER TABLE turmas ADD COLUMN total_aulas INTEGER DEFAULT 0");
  } catch (e) {}
  try {
    db.exec("ALTER TABLE candidates ADD COLUMN aulas_presentes INTEGER DEFAULT 0");
  } catch (e) {}

  seedCandidates();
}

// --- Seed Inicial ---

function seedCandidates() {
  const count = db.prepare('SELECT COUNT(*) AS cnt FROM candidates').get().cnt;
  if (count > 0) return;

  const insertCandidate = db.prepare(
    'INSERT INTO candidates (name, gender, presence, status, turma_id) VALUES (?, ?, ?, ?, NULL)'
  );

  runInTransaction(() => {
    defaultCandidates.forEach((candidate) => {
      insertCandidate.run(candidate.name, candidate.gender, candidate.presence, candidate.status);
    });
  });
}

// --- Autenticação e Gerenciamento de Professores ---

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(password || ''), salt, 64).toString('hex');
  return `${PASSWORD_ALGORITHM}$${salt}$${derived}`;
}

function legacyHashPassword(password) {
  return crypto.createHash('sha256').update(String(password || '')).digest('hex');
}

function verifyPassword(password, storedHash) {
  if (!storedHash) return false;

  if (!storedHash.startsWith(`${PASSWORD_ALGORITHM}$`)) {
    if (Buffer.byteLength(legacyHashPassword(password)) !== Buffer.byteLength(String(storedHash))) return false;
    return crypto.timingSafeEqual(
      Buffer.from(legacyHashPassword(password)),
      Buffer.from(String(storedHash))
    );
  }

  const [, salt, hash] = storedHash.split('$');
  if (!salt || !hash) return false;
  const derived = crypto.scryptSync(String(password || ''), salt, 64).toString('hex');
  if (Buffer.byteLength(derived) !== Buffer.byteLength(hash)) return false;
  return crypto.timingSafeEqual(Buffer.from(derived), Buffer.from(hash));
}

function addTeacher(name, password) {
  const hash = hashPassword(password);
  try {
    db.prepare('INSERT INTO evaluators (name, password_hash) VALUES (?, ?)').run(name, hash);
    return true;
  } catch (e) {
    return false; // Já existe
  }
}

function verifyTeacher(name, password) {
  const teacher = db.prepare('SELECT id, name, password_hash FROM evaluators WHERE name = ?').get(String(name || '').trim());
  if (!teacher || !verifyPassword(password, teacher.password_hash)) return false;

  if (!String(teacher.password_hash || '').startsWith(`${PASSWORD_ALGORITHM}$`)) {
    resetTeacherPassword(teacher.id, password);
  }

  return { id: teacher.id, name: teacher.name };
}

function getTeacherById(teacherId) {
  return db.prepare('SELECT id, name FROM evaluators WHERE id = ? AND password_hash IS NOT NULL').get(teacherId) || null;
}

function getTeacherByName(name) {
  return db.prepare('SELECT id, name FROM evaluators WHERE name = ? AND password_hash IS NOT NULL').get(String(name || '').trim()) || null;
}

function getTeacherList() {
  return db.prepare('SELECT id, name FROM evaluators ORDER BY name').all();
}

function resetTeacherPassword(teacherId, newPassword) {
  const hash = hashPassword(newPassword);
  db.prepare('UPDATE evaluators SET password_hash = ? WHERE id = ?').run(hash, teacherId);
}

function deleteTeacher(teacherId) {
  const id = Number.parseInt(teacherId, 10);
  runInTransaction(() => {
    // Desvincula turmas que tinham este professor como responsável
    // (turmas.teacher_id tem FOREIGN KEY em evaluators)
    db.prepare('UPDATE turmas SET teacher_id = NULL WHERE teacher_id = ?').run(id);
    // Remove presença de sessão deste avaliador (evaluator_session_presence tem FOREIGN KEY em evaluators)
    db.prepare('DELETE FROM evaluator_session_presence WHERE evaluator_id = ?').run(id);
    // Remove as notas deste avaliador
    db.prepare('DELETE FROM scores WHERE evaluator_id = ?').run(id);
    // Remove o professor
    db.prepare('DELETE FROM evaluators WHERE id = ?').run(id);
  });
}

// --- Gerenciamento de Turmas ---

function createTurma(name, teacherId, accessPassword = '') {
  db.prepare('INSERT INTO turmas (name, teacher_id, access_password_hash) VALUES (?, ?, ?)').run(
    String(name || '').trim(),
    teacherId,
    accessPassword ? hashPassword(accessPassword) : null
  );
}

function getTurmas() {
  return db.prepare(`SELECT t.id, t.name, t.teacher_id, t.total_aulas, t.access_password_hash IS NOT NULL AS has_access_password, e.name as teacher_name
    FROM turmas t LEFT JOIN evaluators e ON t.teacher_id = e.id ORDER BY t.name`).all();
}

function getTurmaById(turmaId) {
  return db.prepare(`SELECT t.id, t.name, t.teacher_id, t.total_aulas, t.access_password_hash, e.name as teacher_name
    FROM turmas t LEFT JOIN evaluators e ON t.teacher_id = e.id WHERE t.id = ?`).get(turmaId);
}

function setTurmaPassword(turmaId, password) {
  db.prepare('UPDATE turmas SET access_password_hash = ? WHERE id = ?').run(hashPassword(password), turmaId);
}

function verifyTurmaPassword(turmaId, password) {
  const turma = db.prepare('SELECT id, access_password_hash FROM turmas WHERE id = ?').get(turmaId);
  if (!turma) return false;
  if (!turma.access_password_hash) return false;
  return verifyPassword(password, turma.access_password_hash);
}

function getCandidatesByTurma(turmaId) {
  // Se turmaId for 0 ou null, retorna todos (para admin)
  if (!turmaId || turmaId === 'all') {
    return db.prepare('SELECT id, name, gender, presence, status, turma_id, aulas_presentes FROM candidates ORDER BY id').all();
  }
  return db.prepare('SELECT id, name, gender, presence, status, turma_id, aulas_presentes FROM candidates WHERE turma_id = ? ORDER BY id').all(turmaId);
}

function assignCandidateToTurma(candidateId, turmaId) {
  db.prepare('UPDATE candidates SET turma_id = ? WHERE id = ?').run(turmaId, candidateId);
}

// --- Sessão e Códigos de Acesso ---

function generateSessionCode(turmaId) {
  // Gera PIN de 4 dígitos
  let code = Math.floor(1000 + Math.random() * 9000).toString();
  while (db.prepare('SELECT id FROM sessions WHERE code = ?').get(code)) {
    code = Math.floor(1000 + Math.random() * 9000).toString();
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + (6 * 60 * 60 * 1000)); // +6 horas

  db.prepare("UPDATE sessions SET status = 'closed', closed_at = ? WHERE turma_id = ? AND status = 'active'")
    .run(now.toISOString(), turmaId);
  db.prepare('INSERT INTO sessions (code, turma_id, status, created_at, session_date, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(code, turmaId, 'active', now.toISOString(), getLocalDateString(now), expiresAt.toISOString());
  return code;
}

function verifySessionCode(code, turmaId = null) {
  const today = getLocalDateString();
  const session = turmaId
    ? db.prepare('SELECT * FROM sessions WHERE code = ? AND turma_id = ? AND status = ? AND session_date = ?').get(code, turmaId, 'active', today)
    : db.prepare('SELECT * FROM sessions WHERE code = ? AND status = ? AND session_date = ?').get(code, 'active', today);
  return session || false;
}

function endCurrentSession() {
  // Encerra a sessão ativa (fecha todas as sessões 'active' na prática, ou usa lógica mais complexa se necessário)
  // Para simplicidade, vamos encerrar todas as sessões ativas
  db.prepare("UPDATE sessions SET status = 'closed', closed_at = ? WHERE status = ?").run(getNowIsoString(), 'active');
  db.prepare('UPDATE evaluators SET last_seen_at = NULL').run();
}

function endSessionByTurma(turmaId) {
  db.prepare("UPDATE sessions SET status = 'closed', closed_at = ? WHERE turma_id = ? AND status = 'active'")
    .run(getNowIsoString(), turmaId);
}

function getActiveSessionForTurma(turmaId) {
  return db.prepare("SELECT * FROM sessions WHERE turma_id = ? AND status = 'active' AND session_date = ? ORDER BY id DESC LIMIT 1")
    .get(turmaId, getLocalDateString());
}

// --- Lógica de Avaliação ---

function getCandidatesForEvaluation(turmaId) {
  return getCandidatesByTurma(turmaId);
}

function touchEvaluator(evaluatorId) {
  db.prepare('UPDATE evaluators SET last_seen_at = ? WHERE id = ?').run(getNowIsoString(), evaluatorId);
}

function touchEvaluatorForSession(evaluatorId, turmaId) {
  const session = getActiveSessionForTurma(turmaId);
  if (!session) return false;

  const now = getNowIsoString();
  db.prepare('UPDATE evaluators SET last_seen_at = ? WHERE id = ?').run(now, evaluatorId);
  db.prepare(`INSERT INTO evaluator_session_presence
    (session_id, turma_id, evaluator_id, last_seen_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(session_id, evaluator_id) DO UPDATE SET
      turma_id = excluded.turma_id,
      last_seen_at = excluded.last_seen_at`)
    .run(session.id, turmaId, evaluatorId, now);
  return true;
}

function getOrCreateEvaluator(name) {
  let evaluator = db.prepare('SELECT id, name FROM evaluators WHERE name = ?').get(name);
  if (evaluator) {
    touchEvaluator(evaluator.id);
    return evaluator;
  }

  const insert = db.prepare(
    'INSERT INTO evaluators (name, password_hash, last_seen_at) VALUES (?, NULL, ?)'
  ).run(name, getNowIsoString());

  return { id: insert.lastInsertRowid, name };
}

function getActiveEvaluatorCutoffIso() {
  return new Date(
    Date.now() - (config.evaluatorOnlineWindowMinutes * 60 * 1000)
  ).toISOString();
}

function getGlobalActiveEvaluators(cutoffIso) {
  return db.prepare(
    'SELECT id, name, last_seen_at FROM evaluators WHERE last_seen_at IS NOT NULL AND last_seen_at >= ? ORDER BY name'
  ).all(cutoffIso);
}

function getGlobalActiveEvaluatorsForTurma(turmaId, cutoffIso) {
  return db.prepare(`SELECT DISTINCT e.id, e.name, e.last_seen_at
    FROM evaluators e
    INNER JOIN scores s ON s.evaluator_id = e.id
    INNER JOIN candidates c ON c.id = s.candidate_id
    WHERE c.turma_id = ?
      AND e.last_seen_at IS NOT NULL
      AND e.last_seen_at >= ?
    ORDER BY e.name`).all(turmaId, cutoffIso);
}

function getActiveEvaluators(turmaId = null) {
  const cutoffIso = getActiveEvaluatorCutoffIso();

  if (turmaId) {
    const session = getActiveSessionForTurma(turmaId);
    if (!session) return [];

    const scoped = db.prepare(`SELECT e.id, e.name, p.last_seen_at
      FROM evaluator_session_presence p
      INNER JOIN evaluators e ON e.id = p.evaluator_id
      WHERE p.session_id = ?
        AND p.turma_id = ?
        AND p.last_seen_at >= ?
      ORDER BY e.name`).all(session.id, turmaId, cutoffIso);

    if (scoped.length > 0) return scoped;

    const legacyByTurma = getGlobalActiveEvaluatorsForTurma(turmaId, cutoffIso);
    return legacyByTurma.length > 0
      ? legacyByTurma
      : getGlobalActiveEvaluators(cutoffIso);
  }

  const activeSessions = getActiveSessions();
  if (activeSessions.length === 0) return [];

  const sessionIds = activeSessions.map(session => session.id);
  const placeholders = sessionIds.map(() => '?').join(', ');
  const scoped = db.prepare(`SELECT DISTINCT e.id, e.name, p.last_seen_at
    FROM evaluator_session_presence p
    INNER JOIN evaluators e ON e.id = p.evaluator_id
    WHERE p.session_id IN (${placeholders})
      AND p.last_seen_at >= ?
    ORDER BY e.name`).all(...sessionIds, cutoffIso);

  return scoped.length > 0
    ? scoped
    : getGlobalActiveEvaluators(cutoffIso);
}

function getActiveEvaluatorStatus(turmaId = null) {
  const activeEvaluators = getActiveEvaluators(turmaId);
  return {
    activeCount: activeEvaluators.length,
    activeNames: activeEvaluators.map((evaluator) => evaluator.name),
    activeEvaluators,
    timeoutMinutes: config.evaluatorOnlineWindowMinutes,
  };
}

function saveScores(evaluatorId, formBody, turmaId = null) {
  const candidates = turmaId
    ? db.prepare('SELECT id, gender FROM candidates WHERE turma_id = ? ORDER BY id').all(turmaId)
    : db.prepare('SELECT id, gender FROM candidates ORDER BY id').all();
  
  const upsert = db.prepare(
    'INSERT OR REPLACE INTO scores (evaluator_id, candidate_id, criterion, score) VALUES (?, ?, ?, ?)'
  );

  runInTransaction(() => {
    touchEvaluator(evaluatorId);
    candidates.forEach((candidate) => {
      const criteria = getCriteriaFor(candidate.gender);
      criteria.forEach((criterion) => {
        const key = `${candidate.id}_${criterion}`;
        if (formBody[key] === undefined) return;

        const score = String(formBody[key]).trim().toUpperCase();
        if (FIXED_SCORE_CRITERIA_SET.has(criterion)) return;
        if (score === 'X' || isValidScore(score)) {
          upsert.run(evaluatorId, candidate.id, criterion, score);
        }
      });
    });
  });
}

function isValidScore(score) {
  if (!SCORE_PATTERN.test(String(score))) return false;
  const value = Number.parseInt(score, 10);
  return value >= 1 && value <= 10;
}

function isValidFixedScore(score) {
  if (!SCORE_PATTERN.test(String(score))) return false;
  const value = Number.parseInt(score, 10);
  return value >= 1 && value <= 10;
}

function getNowIsoString() {
  return new Date().toISOString();
}

function getLocalDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Busca as notas de um avaliador específico
function getEvaluatorScores(evaluatorId, turmaId = null) {
  if (!evaluatorId) return {};

  // Garante que é um número inteiro
  const id = Number.parseInt(evaluatorId, 10);

  const rows = turmaId
    ? db.prepare(`SELECT s.candidate_id, s.criterion, s.score
      FROM scores s
      INNER JOIN candidates c ON c.id = s.candidate_id
      WHERE s.evaluator_id = ? AND c.turma_id = ?`).all(id, turmaId)
    : db.prepare(
      'SELECT candidate_id, criterion, score FROM scores WHERE evaluator_id = ?'
    ).all(id);

  const scoresMap = {};
  rows.forEach(row => {
    if (!scoresMap[row.candidate_id]) {
      scoresMap[row.candidate_id] = {};
    }
    scoresMap[row.candidate_id][row.criterion] = row.score;
  });

  return scoresMap;
}

// --- Admin & CRUD Candidatos ---

function createCandidate(payload) {
  db.prepare('INSERT INTO candidates (name, gender, presence, status, turma_id) VALUES (?, ?, ?, ?, ?)').run(
    String(payload.name || '').trim(),
    normalizeGender(payload.gender),
    String(payload.presence || '0%').trim(),
    String(payload.status || 'Bolsista').trim(),
    payload.turma_id || null
  );
}

function updateCandidate(payload) {
  db.prepare('UPDATE candidates SET name = ?, gender = ?, presence = ?, status = ?, turma_id = ? WHERE id = ?').run(
    String(payload.name || '').trim(),
    normalizeGender(payload.gender),
    String(payload.presence || '').trim(),
    String(payload.status || 'Bolsista').trim(),
    payload.turma_id || null,
    Number.parseInt(payload.id, 10)
  );
}

function deleteCandidate(candidateId) {
  const id = Number.parseInt(candidateId, 10);
  runInTransaction(() => {
    // Remove notas fixas do candidato (candidate_fixed_scores tem FOREIGN KEY em candidate_id)
    db.prepare('DELETE FROM candidate_fixed_scores WHERE candidate_id = ?').run(id);
    // Remove as notas do candidato
    db.prepare('DELETE FROM scores WHERE candidate_id = ?').run(id);
    // Remove o candidato
    db.prepare('DELETE FROM candidates WHERE id = ?').run(id);
  });
}

function deleteTurma(turmaId) {
  const id = Number.parseInt(turmaId, 10);
  runInTransaction(() => {
    // Remove todos os alunos vinculados a esta turma
    db.prepare('UPDATE candidates SET turma_id = NULL WHERE turma_id = ?').run(id);
    // Remove registros de presença de avaliadores ligados às sessões desta turma
    // (evaluator_session_presence tem FOREIGN KEY em turma_id)
    db.prepare('DELETE FROM evaluator_session_presence WHERE turma_id = ?').run(id);
    // Preserva o histórico oficial, apenas desvinculando da turma e da sessão que serão removidas
    // (o título do evento já guarda o nome da turma no momento do fechamento,
    // e evaluation_events tem FOREIGN KEY tanto em turma_id quanto em session_id)
    db.prepare('UPDATE evaluation_events SET turma_id = NULL, session_id = NULL WHERE turma_id = ?').run(id);
    // Remove as sessões desta turma (também tem FOREIGN KEY em turma_id)
    db.prepare('DELETE FROM sessions WHERE turma_id = ?').run(id);
    // Remove a turma
    db.prepare('DELETE FROM turmas WHERE id = ?').run(id);
  });
}

// --- Presença / Aulas ---

/**
 * Salva, em uma única operação, o total de aulas do período de uma turma
 * e a quantidade de aulas que cada aluno compareceu.
 * formBody esperado: { total_aulas: '100', aulas_<candidateId>: '80', ... }
 */
function setAttendanceForTurma(turmaId, formBody = {}) {
  const id = Number.parseInt(turmaId, 10);
  const total = Math.max(0, Number.parseInt(formBody.total_aulas, 10) || 0);
  const candidates = getCandidatesByTurma(id);

  runInTransaction(() => {
    db.prepare('UPDATE turmas SET total_aulas = ? WHERE id = ?').run(total, id);

    const update = db.prepare('UPDATE candidates SET aulas_presentes = ? WHERE id = ?');
    candidates.forEach((candidate) => {
      const key = `aulas_${candidate.id}`;
      if (!Object.prototype.hasOwnProperty.call(formBody, key)) return;

      const raw = String(formBody[key] ?? '').trim();
      let value = raw === '' ? 0 : Number.parseInt(raw, 10);
      if (Number.isNaN(value) || value < 0) {
        throw new Error(`Quantidade de aulas presentes inválida para ${candidate.name}.`);
      }
      if (value > total) value = total;
      update.run(value, candidate.id);
    });
  });
}

function getFixedScoresByCandidateIds(candidateIds = []) {
  if (!candidateIds.length) return {};
  const placeholders = candidateIds.map(() => '?').join(', ');
  const rows = db.prepare(`SELECT candidate_id, criterion, score
    FROM candidate_fixed_scores
    WHERE candidate_id IN (${placeholders})`).all(...candidateIds);

  return rows.reduce((map, row) => {
    if (!map[row.candidate_id]) map[row.candidate_id] = {};
    map[row.candidate_id][row.criterion] = row.score;
    return map;
  }, {});
}

function getFixedScoresForTurma(turmaId) {
  const candidates = getCandidatesByTurma(turmaId);
  return getFixedScoresByCandidateIds(candidates.map(candidate => candidate.id));
}

function saveFixedScoresForTurma(turmaId, formBody = {}) {
  const candidates = getCandidatesByTurma(turmaId);
  const validCandidateIds = new Set(candidates.map(candidate => String(candidate.id)));
  const upsert = db.prepare(`INSERT OR REPLACE INTO candidate_fixed_scores
    (candidate_id, criterion, score, updated_at) VALUES (?, ?, ?, ?)`);
  const remove = db.prepare('DELETE FROM candidate_fixed_scores WHERE candidate_id = ? AND criterion = ?');
  const now = getNowIsoString();

  runInTransaction(() => {
    candidates.forEach(candidate => {
      FIXED_SCORE_CRITERIA.forEach(criterion => {
        const key = `fixed_${candidate.id}_${criterion}`;
        if (!Object.prototype.hasOwnProperty.call(formBody, key)) return;
        if (!validCandidateIds.has(String(candidate.id))) return;

        const rawScore = String(formBody[key] ?? '').trim();
        if (!rawScore) {
          remove.run(candidate.id, criterion);
          return;
        }
        if (!isValidFixedScore(rawScore)) {
          throw new Error('Notas fixas devem ser números inteiros de 1 a 10.');
        }

        upsert.run(candidate.id, criterion, Number.parseInt(rawScore, 10), now);
      });
    });
  });
}

function getAttendanceSummary(turmaId) {
  const candidates = getCandidatesByTurma(turmaId);
  const turmaCache = new Map();

  return candidates.reduce((map, candidate) => {
    if (!candidate.turma_id) {
      map[candidate.id] = calculateCandidatePresence(candidate, 0);
      return map;
    }

    if (!turmaCache.has(candidate.turma_id)) {
      turmaCache.set(candidate.turma_id, getTurmaById(candidate.turma_id));
    }
    const turma = turmaCache.get(candidate.turma_id);
    map[candidate.id] = calculateCandidatePresence(candidate, turma ? turma.total_aulas : 0);
    return map;
  }, {});
}

function calculateCandidatePresence(candidate, totalAulas = 0) {
  const total = Number(totalAulas) || 0;

  if (!candidate.turma_id || total <= 0) {
    const fallback = parsePresence(candidate.presence);
    return {
      percentage: fallback,
      label: candidate.presence || `${fallback}%`,
      present: 0,
      absent: 0,
      total: 0,
      source: 'manual',
    };
  }

  const present = Math.min(Number(candidate.aulas_presentes) || 0, total);
  const absent = total - present;
  const percentage = roundOneDecimal((present / total) * 100);
  return {
    percentage,
    label: `${percentage}%`,
    present,
    absent,
    total,
    source: 'attendance',
  };
}

// --- Relatórios e Resultados ---

/**
 * Gera o relatório de resultados consolidado
 * @param {number|null} turmaId - ID da turma para filtrar (null = todos)
 * @returns {object} { results, numEvaluators, activeEvaluators }
 */
function getResultsReport(turmaId = null) {
  const turma = getReportTurma(turmaId);
  const activeEvaluators = getActiveEvaluators(turmaId);
  const evaluatorIds = activeEvaluators.map(e => e.id);
  const numEvaluators = evaluatorIds.length;

  if (numEvaluators === 0) {
    return { 
      results: [], 
      numEvaluators: 0, 
      activeEvaluators: [],
      turma,
    };
  }

  // Filtra candidatos pela turma se especificado
  const candidates = turmaId 
    ? getCandidatesByTurma(turmaId) 
    : getCandidatesByTurma('all');
  const fixedScores = getFixedScoresByCandidateIds(candidates.map(candidate => candidate.id));

  const results = candidates.map(candidate => calculateCandidateResult(candidate, evaluatorIds, fixedScores[candidate.id]));

  return {
    results,
    numEvaluators,
    activeEvaluators: activeEvaluators.map(e => e.name),
    turma,
  };
}

function getReportTurma(turmaId) {
  if (!turmaId) return null;
  const turma = getTurmas().find(row => String(row.id) === String(turmaId));
  return turma ? { id: turma.id, name: turma.name } : null;
}

// Define a progressão de patentes
function getNextStatus(currentStatus) {
  const hierarchy = ['Bolsista', 'Auxiliar', 'Assistente', 'Monitor', 'Professor'];
  const normalized = String(currentStatus || '').trim().toLowerCase();

  const currentIndex = hierarchy.findIndex(h => h.toLowerCase() === normalized);

  // Se o status atual não estiver na lista ou já for o nível máximo, mantém o atual
  if (currentIndex === -1 || currentIndex === hierarchy.length - 1) {
    return currentStatus;
  }

  return hierarchy[currentIndex + 1];
}

function promoteApprovedCandidates(results, idByName) {
  const updateStatus = db.prepare('UPDATE candidates SET status = ? WHERE id = ?');

  results.forEach(result => {
    if (!result || result.status !== 'Aprovado') return;

    const candidateId = idByName.get(result.name);
    if (!candidateId || !result.final_status) return;

    updateStatus.run(result.final_status, candidateId);
  });
}

/**
 * Calcula o resultado individual de um candidato
 */
function calculateCandidateResult(candidate, evaluatorIds, fixedScores = {}) {
  const numEvaluators = evaluatorIds.length;
  const turma = candidate.turma_id ? getTurmaById(candidate.turma_id) : null;
  const presenceSummary = calculateCandidatePresence(candidate, turma ? turma.total_aulas : 0);
  const presenceValue = presenceSummary.percentage;

  // Reprovação automática por presença
  if (!isPresenceEligible(presenceValue)) {
    return buildReprovedResult({ ...candidate, presence: presenceSummary.label }, numEvaluators, 'Presença insuficiente', presenceSummary);
  }

  // Calcula médias
  const averages = {
    ...calculateAverages(candidate.id, evaluatorIds),
    ...getFixedScoreAverages(fixedScores),
  };
  
  // Critérios específicos por gênero
  const peso2Criterion = candidate.gender === 'male' ? maleCriteria : femaleCriteria;
  
  // Nota final
  const finalNote = calculateFinalNote(averages, peso2Criterion);
  
  // Aprovações individuais
  const approvedCount = countIndividualApprovals(candidate.id, evaluatorIds, peso2Criterion, fixedScores);
  const reprovedCount = numEvaluators - approvedCount;
  
  // Status final
  const status = determineResultStatus(finalNote, approvedCount, numEvaluators);

  return {
    name: candidate.name,
    presence: presenceSummary.label,
    presence_source: presenceSummary.source,
    attendance: presenceSummary,
    averages,
    final_note: finalNote,
    approved: approvedCount,
    reproved: reprovedCount,
    status,
    current_rank: candidate.status,
    final_status: status === 'Aprovado' ? getNextStatus(candidate.status) : candidate.status,
  };
}

/**
 * Calcula as médias de todas as critérios para um candidato
 */
function calculateAverages(candidateId, evaluatorIds) {
  const criteria = getCriteriaFor(getCandidateGender(candidateId));
  const averages = {};

  criteria.forEach(criterion => {
    const scores = getScoresForCriterion(candidateId, criterion, evaluatorIds);
    averages[criterion] = scores.length > 0 
      ? roundOneDecimal(average(scores)) 
      : '-';
  });

  return averages;
}

function getFixedScoreAverages(fixedScores = {}) {
  return FIXED_SCORE_CRITERIA.reduce((averages, criterion) => {
    averages[criterion] = fixedScores[criterion] ?? '-';
    return averages;
  }, {});
}

/**
 * Conta quantos avaliadores aprovaram o candidato individualmente
 */
function countIndividualApprovals(candidateId, evaluatorIds, peso2Criterion, fixedScores = {}) {
  let approvedCount = 0;
  const evaluatorCriteria = getCriteriaFor(getCandidateGender(candidateId))
    .filter(criterion => !FIXED_SCORE_CRITERIA_SET.has(criterion));

  for (const evaluatorId of evaluatorIds) {
    if (isEvaluatorApproved(evaluatorId, candidateId, evaluatorCriteria, peso2Criterion, fixedScores)) {
      approvedCount++;
    }
  }

  return approvedCount;
}

/**
 * Verifica se um avaliador aprovou o candidato
 */
function isEvaluatorApproved(evaluatorId, candidateId, criteria, peso2Criterion, fixedScores = {}) {
  const scores = getScoresForEvaluatorCandidate(evaluatorId, candidateId);
  
  // Verifica se avaliou todos os critérios editáveis exigidos.
  if (!criteria.every(criterion => Object.prototype.hasOwnProperty.call(scores, criterion))) {
    return false;
  }

  const finalNote = calculateFinalNote({
    ...scores,
    ...getFixedScoreAverages(fixedScores),
  }, peso2Criterion);
  return finalNote >= 7; // Utiliza a mesma lógica de arredondamento da nota final
}

// --- Funções Auxiliares ---

function buildReprovedResult(candidate, numEvaluators, reason = 'Reprovado', presenceSummary = null) {
  return {
    name: candidate.name,
    presence: candidate.presence,
    presence_source: presenceSummary ? presenceSummary.source : 'manual',
    attendance: presenceSummary,
    averages: {},
    final_note: 0,
    approved: 0,
    reproved: numEvaluators,
    status: reason,
    current_rank: candidate.status,
    final_status: candidate.status,
  };
}

// --- Histórico oficial ---

function closeEvaluationEvent(turmaId, closedBy = 'admin') {
  const session = getActiveSessionForTurma(turmaId);
  if (!session) {
    throw new Error('Não existe sessão ativa hoje para esta turma.');
  }

  const report = getResultsReport(turmaId);
  if (report.numEvaluators === 0) {
    throw new Error('Não há avaliadores online para fechar esta avaliação.');
  }

  const turma = getTurmaById(turmaId);
  const title = `Avaliação - ${turma ? turma.name : `Turma ${turmaId}`} - ${getLocalDateString()}`;

  return runInTransaction(() => {
    const event = db.prepare(`INSERT INTO evaluation_events
      (turma_id, session_id, title, closed_at, closed_by, num_evaluators, evaluator_names)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        turmaId,
        session.id,
        title,
        getNowIsoString(),
        closedBy,
        report.numEvaluators,
        JSON.stringify(report.activeEvaluators)
      );

    const eventId = event.lastInsertRowid;
    const insertSnapshot = db.prepare(`INSERT INTO evaluation_snapshots
      (event_id, candidate_id, candidate_name, payload) VALUES (?, ?, ?, ?)`);
    const candidates = getCandidatesByTurma(turmaId);
    const idByName = new Map(candidates.map(candidate => [candidate.name, candidate.id]));

    report.results.forEach(result => {
      insertSnapshot.run(eventId, idByName.get(result.name) || null, result.name, JSON.stringify(result));
    });

    promoteApprovedCandidates(report.results, idByName);

    db.prepare("UPDATE sessions SET status = 'closed', closed_at = ? WHERE id = ?").run(getNowIsoString(), session.id);
    db.prepare('UPDATE evaluators SET last_seen_at = NULL').run();

    return eventId;
  });
}

function getEvaluationHistory() {
  return db.prepare(`SELECT ev.*, t.name AS turma_name
    FROM evaluation_events ev
    LEFT JOIN turmas t ON t.id = ev.turma_id
    ORDER BY ev.closed_at DESC`).all().map(row => ({
      ...row,
      evaluator_names: safeJsonParse(row.evaluator_names, []),
    }));
}

function getEvaluationHistoryReport(eventId) {
  const event = db.prepare(`SELECT ev.*, t.name AS turma_name
    FROM evaluation_events ev
    LEFT JOIN turmas t ON t.id = ev.turma_id
    WHERE ev.id = ?`).get(eventId);
  if (!event) return null;

  const snapshots = db.prepare('SELECT payload FROM evaluation_snapshots WHERE event_id = ? ORDER BY candidate_id').all(eventId);
  return {
    event: {
      ...event,
      evaluator_names: safeJsonParse(event.evaluator_names, []),
    },
    results: snapshots.map(row => safeJsonParse(row.payload, {})),
    numEvaluators: event.num_evaluators,
    activeEvaluators: safeJsonParse(event.evaluator_names, []),
  };
}

function deleteEvaluationHistoryEvent(eventId) {
  const id = Number.parseInt(eventId, 10);
  runInTransaction(() => {
    // Remove os snapshots de notas deste evento (evaluation_snapshots tem FOREIGN KEY em event_id)
    db.prepare('DELETE FROM evaluation_snapshots WHERE event_id = ?').run(id);
    // Remove o evento do histórico
    db.prepare('DELETE FROM evaluation_events WHERE id = ?').run(id);
  });
}

/**
 * Fecha o semestre (ou reinicia dados) para turmas especificadas.
 * @param {Array<number>} turmaIds
 * @param {string} closedBy
 * @param {object} options - { preserveSnapshots: boolean }
 * @returns {object} resumo { successes: [], errors: [{turmaId, error}] }
 */
function closeSemesterForTurmas(turmaIds = [], closedBy = 'admin', options = { preserveSnapshots: true }) {
  if (!Array.isArray(turmaIds)) turmaIds = [turmaIds];

  const summary = { successes: [], errors: [] };

  turmaIds.forEach(tid => {
    try {
      // 1) Fecha a avaliação oficial (gera evento + snapshots)
      // closeEvaluationEvent já valida sessão ativa e avaliadores
      try {
        closeEvaluationEvent(tid, closedBy);
      } catch (e) {
        // Se não houver sessão ativa ou avaliadores, registramos o erro e continuamos
        throw e;
      }

      // 2) Encerra sessão ativa da turma
      endSessionByTurma(tid);

      // 3) Se preservamos snapshots, removemos apenas reuniões e presenças para reiniciar o semestre
      //    Os registros históricos (evaluation_events / evaluation_snapshots) já foram gravados.
      //    Ajustamos também o campo `presence` dos candidatos para '0%'.
      runInTransaction(() => {
        // Zera total de aulas e presença dos alunos desta turma
        db.prepare('UPDATE turmas SET total_aulas = 0 WHERE id = ?').run(tid);
        db.prepare('UPDATE candidates SET aulas_presentes = 0 WHERE turma_id = ?').run(tid);

        // Remove notas (scores) dos candidatos desta turma para reinício
        db.prepare('DELETE FROM scores WHERE candidate_id IN (SELECT id FROM candidates WHERE turma_id = ?)').run(tid);
        db.prepare('DELETE FROM candidate_fixed_scores WHERE candidate_id IN (SELECT id FROM candidates WHERE turma_id = ?)').run(tid);

        // Zera presença manual (fallback) dos candidatos desta turma para reinício
        db.prepare("UPDATE candidates SET presence = '0%' WHERE turma_id = ?").run(tid);
      });

      summary.successes.push(tid);
    } catch (error) {
      summary.errors.push({ turmaId: tid, error: String(error && error.message ? error.message : error) });
    }
  });

  return summary;
}

/**
 * Reabre o semestre/cria nova sessão para a turma se já houver evento histórico.
 * Não restaura reuniões apagadas; cria uma nova sessão ativa para que avaliações possam recomeçar.
 * @param {number} turmaId
 * @param {string} reopenedBy
 * @returns {string} novo código de sessão
 */
function reopenSemesterForTurma(turmaId, reopenedBy = 'admin') {
  const lastEvent = db.prepare('SELECT id FROM evaluation_events WHERE turma_id = ? ORDER BY closed_at DESC LIMIT 1').get(turmaId);
  if (!lastEvent) {
    throw new Error('Não há eventos fechados para esta turma.');
  }

  // Gera uma nova sessão ativa para a turma
  const code = generateSessionCode(turmaId);
  return code;
}

function getActiveSessions() {
  const now = new Date().toISOString();
  return db.prepare(`SELECT s.*, t.name as turma_name 
    FROM sessions s 
    JOIN turmas t ON t.id = s.turma_id 
    WHERE s.status = 'active' AND (s.expires_at IS NULL OR s.expires_at > ?)
    ORDER BY s.created_at DESC`).all(now);
}

function getActiveSessionCodeForTurma(turmaId) {
  const now = new Date().toISOString();
  return db.prepare(`SELECT code, turma_id, expires_at, t.name as turma_name 
    FROM sessions s 
    JOIN turmas t ON t.id = s.turma_id 
    WHERE s.turma_id = ? AND s.status = 'active' AND (s.expires_at IS NULL OR s.expires_at > ?)
    ORDER BY s.id DESC LIMIT 1`).get(turmaId, now);
}

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function getScoresForCriterion(candidateId, criterion, evaluatorIds) {
  const rows = selectScoresForActiveEvaluators(
    "SELECT score FROM scores WHERE candidate_id = ? AND criterion = ? AND score != 'X'",
    [candidateId, criterion],
    evaluatorIds
  );
  
  return rows
    .map(row => row.score)
    .filter(isValidScore)
    .map(Number);
}

function getScoresForEvaluatorCandidate(evaluatorId, candidateId) {
  const rows = db.prepare(
    "SELECT criterion, score FROM scores WHERE evaluator_id = ? AND candidate_id = ? AND score != 'X'"
  ).all(evaluatorId, candidateId);

  const scores = {};
  rows.forEach(row => {
    if (isValidScore(row.score)) {
      scores[row.criterion] = Number.parseInt(row.score, 10);
    }
  });

  return scores;
}

function getCandidateGender(candidateId) {
  const candidate = db.prepare('SELECT gender FROM candidates WHERE id = ?').get(candidateId);
  return candidate ? candidate.gender : 'male';
}

function getCandidateGenderById(candidateId) {
  return getCandidateGender(candidateId);
}

function normalizeGender(gender) {
  return gender === 'female' ? 'female' : 'male';
}

function selectScoresForActiveEvaluators(baseSql, params, activeEvaluatorIds) {
  if (activeEvaluatorIds.length === 0) return [];
  const placeholders = activeEvaluatorIds.map(() => '?').join(', ');
  const statement = db.prepare(`${baseSql} AND evaluator_id IN (${placeholders})`);
  return statement.all(...params, ...activeEvaluatorIds);
}

module.exports = {
  // Autenticação
  addTeacher,
  verifyTeacher,
  getTeacherById,
  getTeacherByName,
  getTeacherList,
  resetTeacherPassword,
  deleteTeacher,
  
  // Turmas
  createTurma,
  getTurmas,
  getTurmaById,
  setTurmaPassword,
  verifyTurmaPassword,
  getCandidatesByTurma,
  assignCandidateToTurma,
  deleteTurma,
  
  // Sessão
  generateSessionCode,
  verifySessionCode,
  endCurrentSession,
  endSessionByTurma,
  getActiveSessionForTurma,
  
  // Presença
  setAttendanceForTurma,
  getAttendanceSummary,
  
  // Avaliação
  initDb,
  getCandidates: getCandidatesByTurma,
  getOrCreateEvaluator,
  touchEvaluatorForSession,
  saveScores,
  saveFixedScoresForTurma,
  getFixedScoresForTurma,
  getEvaluatorScores,
  getActiveEvaluatorStatus,
  getResultsReport,
  closeEvaluationEvent,
  closeSemesterForTurmas,
  reopenSemesterForTurma,
  getEvaluationHistory,
  getEvaluationHistoryReport,
  deleteEvaluationHistoryEvent,
  getActiveSessions,
  getActiveSessionCodeForTurma,

  // Admin
  createCandidate,
  updateCandidate,
  deleteCandidate,
};
