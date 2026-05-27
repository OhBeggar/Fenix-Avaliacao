const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avali-reopen-'));
process.env.EVALUATIONS_DB_PATH = path.join(tempDir, 'evaluations.db');

const service = require('../src/services/evaluation-service');
const { db } = require('../src/db');

service.initDb();

test.after(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

function createTurmaWithCandidate() {
    service.createTurma(`Turma ${Date.now()} ${Math.random()}`, null);
    const turma = service.getTurmas().at(-1);
    service.createCandidate({
        name: `Aluno ${Date.now()} ${Math.random()}`,
        gender: 'female',
        presence: '100%',
        status: 'Bolsista',
        turma_id: turma.id,
    });
    const candidate = service.getCandidatesByTurma(turma.id).at(-1);
    return { turma, candidate };
}

test('reopenSemesterForTurma creates a new active session if history exists', () => {
    const { turma } = createTurmaWithCandidate();

    // Close once to create history (we need a session and evaluator)
    const code = service.generateSessionCode(turma.id);
    const evaluator = service.getOrCreateEvaluator('reopen-tester');
    const closeResult = service.closeSemesterForTurmas([turma.id], 'test', { preserveSnapshots: true });
    assert.equal(closeResult.successes.length, 1);

    // Now reopen
    const newCode = service.reopenSemesterForTurma(turma.id, 'test');
    assert.ok(newCode && typeof newCode === 'string');

    const active = service.getActiveSessionForTurma(turma.id);
    assert.ok(active && active.code === newCode);
});

test('reopenSemesterForTurma fails when no historical event exists', () => {
    const { turma } = createTurmaWithCandidate();

    // Ensure no history exists for this turma
    const history = service.getEvaluationHistory().filter(h => h.turma_id === turma.id);
    assert.equal(history.length, 0);

    let threw = false;
    try {
        service.reopenSemesterForTurma(turma.id, 'test');
    } catch (e) {
        threw = true;
        assert.ok(String(e.message).includes('Não há eventos fechados'));
    }
    assert.equal(threw, true);
});
