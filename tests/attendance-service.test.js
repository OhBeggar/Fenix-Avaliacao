const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avali-attendance-'));
process.env.EVALUATIONS_DB_PATH = path.join(tempDir, 'evaluations.db');

const service = require('../src/services/evaluation-service');
const { db } = require('../src/db');

service.initDb();

test.after(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

function createTurmaWithCandidate(candidatePresence = '0%') {
    service.createTurma(`Turma ${Date.now()} ${Math.random()}`, null);
    const turma = service.getTurmas().at(-1);
    service.createCandidate({
        name: `Aluno ${Date.now()} ${Math.random()}`,
        gender: 'male',
        presence: candidatePresence,
        status: 'Bolsista',
        turma_id: turma.id,
    });
    const candidate = service.getCandidatesByTurma(turma.id).at(-1);
    return { turma, candidate };
}

test('turma sem total de aulas cai no fallback de presença manual', () => {
    const { turma, candidate } = createTurmaWithCandidate('75%');

    const summary = service.getAttendanceSummary(turma.id)[candidate.id];

    assert.equal(summary.source, 'manual');
    assert.equal(summary.percentage, 75);
    assert.equal(summary.total, 0);
});

test('setAttendanceForTurma calcula o percentual a partir de total x presentes', () => {
    const { turma, candidate } = createTurmaWithCandidate();

    service.setAttendanceForTurma(turma.id, {
        total_aulas: '100',
        [`aulas_${candidate.id}`]: '80',
    });

    const summary = service.getAttendanceSummary(turma.id)[candidate.id];

    assert.equal(summary.source, 'attendance');
    assert.equal(summary.present, 80);
    assert.equal(summary.absent, 20);
    assert.equal(summary.total, 100);
    assert.equal(summary.percentage, 80);
    assert.equal(summary.label, '80%');
});

test('setAttendanceForTurma trava aulas presentes no total de aulas', () => {
    const { turma, candidate } = createTurmaWithCandidate();

    service.setAttendanceForTurma(turma.id, {
        total_aulas: '10',
        [`aulas_${candidate.id}`]: '999',
    });

    const summary = service.getAttendanceSummary(turma.id)[candidate.id];
    assert.equal(summary.present, 10);
    assert.equal(summary.percentage, 100);
});

test('setAttendanceForTurma rejeita valores negativos/inválidos', () => {
    const { turma, candidate } = createTurmaWithCandidate();

    assert.throws(() => {
        service.setAttendanceForTurma(turma.id, {
            total_aulas: '100',
            [`aulas_${candidate.id}`]: '-5',
        });
    });
});

test('isPresenceEligible reflete o mesmo corte de 80% usado no resultado final', () => {
    const { turma, candidate } = createTurmaWithCandidate();

    service.setAttendanceForTurma(turma.id, {
        total_aulas: '100',
        [`aulas_${candidate.id}`]: '79',
    });
    let summary = service.getAttendanceSummary(turma.id)[candidate.id];
    assert.equal(summary.percentage < 80, true);

    service.setAttendanceForTurma(turma.id, {
        total_aulas: '100',
        [`aulas_${candidate.id}`]: '80',
    });
    summary = service.getAttendanceSummary(turma.id)[candidate.id];
    assert.equal(summary.percentage >= 80, true);
});
