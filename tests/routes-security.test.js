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

function request(server, pathname, headers = {}) {
    const { port } = server.address();

    return new Promise((resolve, reject) => {
        const req = http.request({ port, path: pathname, method: 'GET', headers }, (res) => {
            res.resume();
            res.on('end', () => resolve(res));
        });

        req.on('error', reject);
        req.end();
    });
}

function getText(server, pathname, headers = {}) {
    const { port } = server.address();

    return new Promise((resolve, reject) => {
        const req = http.request({ port, path: pathname, method: 'GET', headers }, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({ res, text: Buffer.concat(chunks).toString('utf8') }));
        });

        req.on('error', reject);
        req.end();
    });
}

async function getJson(server, pathname, headers = {}) {
    const response = await getText(server, pathname, headers);
    return {
        res: response.res,
        json: JSON.parse(response.text),
    };
}

function postJson(server, pathname, payload, headers = {}) {
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
                ...headers,
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

function postForm(server, pathname, form, headers = {}) {
    const { port } = server.address();
    const body = form.toString();

    return new Promise((resolve, reject) => {
        const req = http.request({
            port,
            path: pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(body),
                ...headers,
            },
        }, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({ res, text: Buffer.concat(chunks).toString('utf8') }));
        });

        req.on('error', reject);
        req.end(body);
    });
}

async function loginTeacher(server, name, password) {
    const login = await postForm(server, '/login', new URLSearchParams({ name, password }));
    assert.equal(login.res.statusCode, 302);
    const rawCookie = login.res.headers['set-cookie']?.find(cookie => cookie.startsWith('teacher_access='));
    assert.ok(rawCookie, 'teacher_access cookie should be set after teacher login');
    return rawCookie.split(';')[0];
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

test('teacher turma list requires signed teacher session', async () => {
    service.addTeacher('Professor Seguro', 'senha');
    const server = http.createServer(app).listen(0);

    try {
        const direct = await request(server, '/turmas/Professor%20Seguro');
        assert.equal(direct.statusCode, 302);
        assert.match(direct.headers.location, /^\/\?message=/);

        const cookie = await loginTeacher(server, 'Professor Seguro', 'senha');
        const allowed = await getText(server, '/turmas/Professor%20Seguro', { Cookie: cookie });
        assert.equal(allowed.res.statusCode, 200);
        assert.match(allowed.text, /Selecione a Turma/);
    } finally {
        server.close();
    }
});

test('teacher session cannot be reused for another teacher URL', async () => {
    service.addTeacher('Professor A Seguro', 'senha-a');
    service.addTeacher('Professor B Seguro', 'senha-b');
    const server = http.createServer(app).listen(0);

    try {
        const cookie = await loginTeacher(server, 'Professor A Seguro', 'senha-a');
        const forged = await request(server, '/turmas/Professor%20B%20Seguro', { Cookie: cookie });
        assert.equal(forged.statusCode, 302);
        assert.match(forged.headers.location, /^\/\?message=/);
    } finally {
        server.close();
    }
});

test('turma access ignores forged evaluatorName and uses teacher session', async () => {
    service.addTeacher('Professor Dono', 'senha');
    const teacher = service.getTeacherList().find((row) => row.name === 'Professor Dono');
    service.createTurma('Turma Anti Spoof', teacher.id, 'senha-da-turma');
    const turma = service.getTurmas().find((row) => row.name === 'Turma Anti Spoof');

    const server = http.createServer(app).listen(0);

    try {
        const cookie = await loginTeacher(server, 'Professor Dono', 'senha');
        const access = await postJson(server, '/turmas/access', {
            evaluatorName: 'Outro Professor',
            turmaId: turma.id,
            password: 'senha-da-turma',
        }, { Cookie: cookie });

        assert.equal(access.json.success, true);
        assert.equal(access.json.redirectUrl, `/turmas/Professor%20Dono/${turma.id}`);
    } finally {
        server.close();
    }
});

test('teacher check API does not enumerate registered teachers', async () => {
    service.addTeacher('Professor Enumerado', 'senha');
    const server = http.createServer(app).listen(0);

    try {
        const known = await postJson(server, '/api/check-teacher', { name: 'Professor Enumerado' });
        const unknown = await postJson(server, '/api/check-teacher', { name: 'Professor Inexistente' });

        assert.equal(known.json.exists, true);
        assert.equal(unknown.json.exists, true);
    } finally {
        server.close();
    }
});

test('session SSE payload never exposes active PIN code', async () => {
    const server = http.createServer(app).listen(0);

    try {
        const { port } = server.address();
        const received = await new Promise((resolve, reject) => {
            const req = http.request({ port, path: '/events', method: 'GET' }, (res) => {
                res.setEncoding('utf8');
                res.on('data', (chunk) => {
                    if (!chunk.includes('session_started')) return;
                    resolve(chunk);
                    req.destroy();
                });
            });

            req.on('error', reject);
            req.end();

            setTimeout(() => {
                app.locals.serverEvents.emit('session', { event: 'session_started', turmaId: 99, code: '1234' });
            }, 20);
        });

        assert.match(received, /session_started/);
        assert.doesNotMatch(received, /1234/);
        assert.doesNotMatch(received, /code/);
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
        const cookie = await loginTeacher(server, 'Avaliador PIN', 'senha');
        const bad = await postJson(server, '/turmas/evaluate-access', {
            evaluatorName: 'Avaliador PIN',
            turmaId: turma.id,
            code: '0000',
        }, { Cookie: cookie });
        assert.equal(bad.json.success, false);

        const good = await postJson(server, '/turmas/evaluate-access', {
            evaluatorName: 'Avaliador PIN',
            turmaId: turma.id,
            code,
        }, { Cookie: cookie });
        assert.equal(good.json.success, true);
        assert.equal(good.json.redirectUrl, `/evaluate/Avaliador%20PIN?turmaId=${turma.id}`);
        assert.match(good.res.headers['set-cookie'][0], new RegExp(`evaluation_access_${turma.id}=`));
    } finally {
        server.close();
    }
});

test('evaluator heartbeat requires evaluation cookie and stops after session closes', async () => {
    service.addTeacher('Avaliador Online Seguro', 'senha');
    const teacher = service.getTeacherList().find((row) => row.name === 'Avaliador Online Seguro');
    service.createTurma('Turma Online Seguro', teacher.id, 'senha-da-turma');
    const turma = service.getTurmas().find((row) => row.name === 'Turma Online Seguro');
    service.createCandidate({ name: 'Aluno Online Seguro', gender: 'male', presence: '100%', status: 'Bolsista', turma_id: turma.id });
    const code = service.generateSessionCode(turma.id);

    const server = http.createServer(app).listen(0);

    try {
        const teacherCookie = await loginTeacher(server, teacher.name, 'senha');
        const unsigned = await getJson(
            server,
            `/api/evaluators/status?evaluatorName=${encodeURIComponent(teacher.name)}&turmaId=${turma.id}`
        );
        assert.equal(unsigned.json.sessionClosed, false);
        assert.equal(unsigned.json.activeCount, 0);

        const access = await postJson(server, '/turmas/evaluate-access', {
            evaluatorName: teacher.name,
            turmaId: turma.id,
            code,
        }, { Cookie: teacherCookie });
        const evaluationCookie = access.res.headers['set-cookie'][0].split(';')[0];
        const authCookies = `${teacherCookie}; ${evaluationCookie}`;

        const active = await getJson(
            server,
            `/api/evaluators/status?evaluatorName=${encodeURIComponent(teacher.name)}&turmaId=${turma.id}`,
            { Cookie: authCookies }
        );
        assert.equal(active.json.sessionClosed, false);
        assert.equal(active.json.activeCount, 1);
        assert.deepEqual(active.json.activeNames, [teacher.name]);

        const live = await getText(server, `/results?turmaId=${turma.id}`);
        assert.match(live.text, /Avaliadores ativos/);

        service.endSessionByTurma(turma.id);

        const closed = await getJson(
            server,
            `/api/evaluators/status?evaluatorName=${encodeURIComponent(teacher.name)}&turmaId=${turma.id}`,
            { Cookie: authCookies }
        );
        assert.equal(closed.json.sessionClosed, true);
        assert.equal(closed.json.activeCount, 0);

        const closedResults = await getText(server, `/results?turmaId=${turma.id}`);
        assert.match(closedResults.text, /Sessão encerrada/);
        assert.doesNotMatch(closedResults.text, /Avaliadores ativos: <strong>1<\/strong>/);
    } finally {
        server.close();
    }
});
