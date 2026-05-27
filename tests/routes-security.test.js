const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avali-routes-'));
process.env.EVALUATIONS_DB_PATH = path.join(tempDir, 'evaluations.db');
process.env.ADMIN_PASSWORD = 'test-admin-password';
process.env.ADMIN_COOKIE_SECRET = 'test-cookie-secret';

const app = require('../app');
const service = require('../src/services/evaluation-service');
const { db } = require('../src/db');

function request(server, pathname) {
    const { port } = server.address();

    return new Promise((resolve, reject) => {
        const req = http.request({ port, path: pathname, method: 'GET' }, (res) => {
            res.resume();
            res.on('end', () => resolve(res));
        });

        req.on('error', reject);
        req.end();
    });
}

function postJson(server, pathname, payload) {
    const { port } = server.address();
    const body = JSON.stringify(payload);

    return new Promise((resolve, reject) => {
        const req = http.request({
            port,
            path: pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
            },
        }, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                resolve({ res, text, json: JSON.parse(text) });
            });
        });

        req.on('error', reject);
        req.end(body);
    });
}

test.after(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

test('results page remains public', async () => {
    const server = http.createServer(app).listen(0);

    try {
        const res = await request(server, '/results');
        assert.equal(res.statusCode, 200);
    } finally {
        server.close();
    }
});

test('PDF export requires admin authentication', async () => {
    const server = http.createServer(app).listen(0);

    try {
        const res = await request(server, '/export_pdf');
        assert.equal(res.statusCode, 302);
        assert.equal(res.headers.location, '/admin/login');
    } finally {
        server.close();
    }
});

test('historical results require admin authentication', async () => {
    const server = http.createServer(app).listen(0);

    try {
        const res = await request(server, '/results/history/1');
        assert.equal(res.statusCode, 302);
        assert.equal(res.headers.location, '/admin/login');
    } finally {
        server.close();
    }
});

test('evaluation PIN does not require turma room access', async () => {
    service.addTeacher('Avaliador PIN', 'senha');
    const teacher = service.getTeacherList().find((row) => row.name === 'Avaliador PIN');
    service.createTurma('Turma PIN', teacher.id, 'senha-da-turma');
    const turma = service.getTurmas().find((row) => row.name === 'Turma PIN');
    service.createCandidate({ name: 'Aluno PIN', gender: 'male', presence: '100%', status: 'Bolsista', turma_id: turma.id });
    const code = service.generateSessionCode(turma.id);

    const server = http.createServer(app).listen(0);

    try {
        const bad = await postJson(server, '/turmas/evaluate-access', {
            evaluatorName: 'Avaliador PIN',
            turmaId: turma.id,
            code: '0000',
        });
        assert.equal(bad.json.success, false);

        const good = await postJson(server, '/turmas/evaluate-access', {
            evaluatorName: 'Avaliador PIN',
            turmaId: turma.id,
            code,
        });
        assert.equal(good.json.success, true);
        assert.equal(good.json.redirectUrl, `/evaluate/Avaliador%20PIN?turmaId=${turma.id}`);
        assert.match(good.res.headers['set-cookie'][0], new RegExp(`evaluation_access_${turma.id}=`));
    } finally {
        server.close();
    }
});
