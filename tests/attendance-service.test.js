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

test('migrateJustifiedAttendance converts legacy justified records to absent', () => {
    const { turma, candidate } = createTurmaWithCandidate();
    const meetingId = service.createClassMeeting(turma.id, { title: 'Aula teste' });

    db.prepare(`INSERT INTO attendance_records
        (meeting_id, candidate_id, status, marked_by, marked_at)
        VALUES (?, ?, 'justified', 'test', ?)`)
        .run(meetingId, candidate.id, new Date().toISOString());

    service.migrateJustifiedAttendance();

    assert.deepEqual(service.getAttendanceMapForMeeting(meetingId), {
        [candidate.id]: 'absent',
    });
});

test('new class meetings do not affect presence until attendance is saved', () => {
    const { turma, candidate } = createTurmaWithCandidate('75%');

    service.createClassMeeting(turma.id, { title: 'Aula pendente' });
    const summary = service.getAttendanceSummary(turma.id)[candidate.id];

    assert.equal(summary.source, 'manual');
    assert.equal(summary.percentage, 75);
    assert.equal(summary.total, 0);
});

test('presence is calculated only from saved present and absent records', () => {
    const { turma, candidate } = createTurmaWithCandidate();
    const firstMeetingId = service.createClassMeeting(turma.id, { title: 'Aula 1' });
    const secondMeetingId = service.createClassMeeting(turma.id, { title: 'Aula 2' });

    service.markAttendance(firstMeetingId, { [candidate.id]: 'present' }, 'test', turma.id);
    service.markAttendance(secondMeetingId, { [candidate.id]: 'absent' }, 'test', turma.id);

    const summary = service.getAttendanceSummary(turma.id)[candidate.id];

    assert.equal(summary.source, 'attendance');
    assert.equal(summary.present, 1);
    assert.equal(summary.absent, 1);
    assert.equal(summary.total, 2);
    assert.equal(summary.percentage, 50);
    assert.equal(summary.label, '50%');
});

test('markAttendance ignores unsupported statuses', () => {
    const { turma, candidate } = createTurmaWithCandidate();
    const meetingId = service.createClassMeeting(turma.id, { title: 'Aula sem justificativa' });

    service.markAttendance(meetingId, { [candidate.id]: 'justified' }, 'test', turma.id);

    assert.deepEqual(service.getAttendanceMapForMeeting(meetingId), {});
});
