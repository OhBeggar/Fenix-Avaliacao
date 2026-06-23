const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { getCriteriaFor } = require('../src/constants');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avali-close-semester-'));
process.env.EVALUATIONS_DB_PATH = path.join(tempDir, 'evaluations.db');

const service = require('../src/services/evaluation-service');
const { db } = require('../src/db');

service.initDb();

test.after(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

function createTurmaWithCandidate(presence = '100%') {
    service.createTurma(`Turma ${Date.now()} ${Math.random()}`, null);
    const turma = service.getTurmas().at(-1);
    service.createCandidate({
        name: `Aluno ${Date.now()} ${Math.random()}`,
        gender: 'male',
        presence,
        status: 'Bolsista',
        turma_id: turma.id,
    });
    const candidate = service.getCandidatesByTurma(turma.id).at(-1);
    return { turma, candidate };
}

function saveScoresForCandidate(candidate, score) {
    const evaluator = service.getOrCreateEvaluator(`avaliador-${Date.now()}-${Math.random()}`);
    service.touchEvaluatorForSession(evaluator.id, candidate.turma_id);

    const formBody = {};
    const criteria = getCriteriaFor(candidate.gender);
    criteria.forEach(criterion => {
        formBody[`${candidate.id}_${criterion}`] = String(score);
    });
    service.saveScores(evaluator.id, formBody);

    return evaluator;
}

test('closeSemesterForTurmas closes a turma with active session and evaluator', () => {
    const { turma, candidate } = createTurmaWithCandidate('100%');

    // Create a session
    const code = service.generateSessionCode(turma.id);
    assert.ok(code);

    // Ensure evaluator exists (sets last_seen_at)
    const evaluator = service.getOrCreateEvaluator('tester-close');
    assert.ok(evaluator && evaluator.id);

    // Create and save sample scores for the candidate so we can assert they are cleared on close
    const formBody = {};
    const criteria = getCriteriaFor(candidate.gender);
    criteria.forEach(criterion => {
        formBody[`${candidate.id}_${criterion}`] = '5';
    });
    service.saveScores(evaluator.id, formBody);

    // Ensure there were scores before closing
    const preScores = service.getEvaluatorScores(evaluator.id);
    assert.ok(Object.keys(preScores).length > 0);

    // Call closeSemesterForTurmas
    const result = service.closeSemesterForTurmas([turma.id], 'test', { preserveSnapshots: true });

    assert.equal(result.successes.length, 1);
    assert.equal(result.errors.length, 0);

    // Check that meetings and attendance are cleared (no meetings)
    const meetings = service.getClassMeetings(turma.id);
    assert.equal(meetings.length, 0);

    // Candidate presence should be reset to '0%'
    const refreshed = service.getCandidatesByTurma(turma.id).find(c => c.id === candidate.id);
    assert.equal(refreshed.presence, '0%');

    // There should be at least one evaluation_event recorded
    const history = service.getEvaluationHistory().filter(h => h.turma_id === turma.id);
    assert.ok(history.length >= 1);

    // After close, scores for evaluators should be cleared
    const postScores = service.getEvaluatorScores(evaluator.id);
    assert.equal(Object.keys(postScores).length, 0);
});

test('closeSemesterForTurmas returns error when there is no active session', () => {
    const { turma } = createTurmaWithCandidate('100%');

    // Do not generate session for this turma, call close
    const result = service.closeSemesterForTurmas([turma.id], 'test', { preserveSnapshots: true });

    assert.equal(result.successes.length, 0);
    assert.equal(result.errors.length, 1);
    assert.ok(result.errors[0].error.includes('sessão') || result.errors[0].error.length > 0);
});

test('approved candidate is promoted after official close', () => {
    const { turma, candidate } = createTurmaWithCandidate('100%');
    service.generateSessionCode(turma.id);
    saveScoresForCandidate(candidate, 10);

    const eventId = service.closeEvaluationEvent(turma.id, 'test');
    assert.ok(eventId);

    const refreshed = service.getCandidatesByTurma(turma.id).find(c => c.id === candidate.id);
    assert.equal(refreshed.status, 'Auxiliar');

    const snapshot = service.getEvaluationHistoryReport(eventId).results.find(result => result.name === candidate.name);
    assert.equal(snapshot.status, 'Aprovado');
    assert.equal(snapshot.current_rank, 'Bolsista');
    assert.equal(snapshot.final_status, 'Auxiliar');
});

test('reproved candidate keeps current rank after official close', () => {
    const { turma, candidate } = createTurmaWithCandidate('100%');
    service.generateSessionCode(turma.id);
    saveScoresForCandidate(candidate, 5);

    service.closeEvaluationEvent(turma.id, 'test');

    const refreshed = service.getCandidatesByTurma(turma.id).find(c => c.id === candidate.id);
    assert.equal(refreshed.status, 'Bolsista');

    const snapshot = service.getEvaluationHistory().find(h => h.turma_id === turma.id);
    const report = service.getEvaluationHistoryReport(snapshot.id);
    const result = report.results.find(row => row.name === candidate.name);
    assert.equal(result.current_rank, 'Bolsista');
    assert.equal(result.final_status, 'Bolsista');
});

test('presence insufficient candidate keeps current rank after official close', () => {
    const { turma, candidate } = createTurmaWithCandidate('75%');
    service.generateSessionCode(turma.id);
    saveScoresForCandidate(candidate, 10);

    service.closeEvaluationEvent(turma.id, 'test');

    const refreshed = service.getCandidatesByTurma(turma.id).find(c => c.id === candidate.id);
    assert.equal(refreshed.status, 'Bolsista');

    const snapshot = service.getEvaluationHistory().find(h => h.turma_id === turma.id);
    const report = service.getEvaluationHistoryReport(snapshot.id);
    const result = report.results.find(row => row.name === candidate.name);
    assert.equal(result.status, 'Presença insuficiente');
    assert.equal(result.current_rank, 'Bolsista');
});
