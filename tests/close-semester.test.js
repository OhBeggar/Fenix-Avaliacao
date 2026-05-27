const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

test('closeSemesterForTurmas closes a turma with active session and evaluator', () => {
    const { turma, candidate } = createTurmaWithCandidate('100%');

    // Create a session
    const code = service.generateSessionCode(turma.id);
    assert.ok(code);

    // Ensure evaluator exists (sets last_seen_at)
    const evaluator = service.getOrCreateEvaluator('tester-close');
    assert.ok(evaluator && evaluator.id);

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
});

test('closeSemesterForTurmas returns error when there is no active session', () => {
    const { turma } = createTurmaWithCandidate('100%');

    // Do not generate session for this turma, call close
    const result = service.closeSemesterForTurmas([turma.id], 'test', { preserveSnapshots: true });

    assert.equal(result.successes.length, 0);
    assert.equal(result.errors.length, 1);
    assert.ok(result.errors[0].error.includes('sessão') || result.errors[0].error.length > 0);
});
