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
const { signAdminPayload } = require('../src/utils/admin-auth');
const config = require('../src/config');

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

function adminCookie() {
    const token = signAdminPayload({
        type: 'admin',
        iat: Date.now(),
        exp: Date.now() + (60 * 60 * 1000),
    });
    return `${config.adminCookieName}=${encodeURIComponent(token)}`;
}

function extractCsrfToken(html) {
    const match = html.match(/csrfToken\) %>;[\s\S]*?input\.value = "([^"]+)"/)
        || html.match(/"csrfToken":\s*"([^"]+)"/)
        || html.match(/name="_csrf" value="([^"]+)"/)
        || html.match(/input\.value = "([^"]+)"/);
    assert.ok(match, 'page should include a CSRF token');
    return match[1].replace(/\\u002F/g, '/');
}

async function getTeacherCsrf(server, teacherName, cookie) {
    const page = await getText(server, `/turmas/${encodeURIComponent(teacherName)}`, { Cookie: cookie });
    assert.equal(page.res.statusCode, 200);
    return extractCsrfToken(page.text);
}

test.after(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

test('results require an explicit active turma session', async () => {
    service.addTeacher('Professor Resultado Seguro', 'senha');
    const teacher = service.getTeacherList().find((row) => row.name === 'Professor Resultado Seguro');
    service.createTurma('Turma Resultado Seguro', teacher.id, 'senha-da-turma');
    const turma = service.getTurmas().find((row) => row.name === 'Turma Resultado Seguro');
    service.createCandidate({ name: 'Aluno Resultado Seguro', gender: 'male', presence: '100%', status: 'Bolsista', turma_id: turma.id });
    service.generateSessionCode(turma.id);

    const server = http.createServer(app).listen(0);

    try {
        const res = await request(server, '/results');
        assert.equal(res.statusCode, 302);
        assert.equal(res.headers.location, '/admin/login');

        const activeWithoutAdmin = await request(server, `/results?turmaId=${turma.id}`);
        assert.equal(activeWithoutAdmin.statusCode, 302);
        assert.equal(activeWithoutAdmin.headers.location, '/admin/login');

        const active = await getText(server, `/results?turmaId=${turma.id}`, { Cookie: adminCookie() });
        assert.equal(active.res.statusCode, 200);
        assert.match(active.text, /Resultados finais/);

        const adminPage = await getText(server, '/admin', { Cookie: adminCookie() });
        assert.equal(adminPage.res.statusCode, 200);
        assert.match(adminPage.text, new RegExp(`/results\\?turmaId=${turma.id}`));
        assert.match(adminPage.text, /Painel ao vivo/);

        service.endSessionByTurma(turma.id);
        const closed = await request(server, `/results?turmaId=${turma.id}`, { Cookie: adminCookie() });
        assert.equal(closed.statusCode, 302);
        assert.equal(closed.headers.location, '/results/history');
    } finally {
        server.close();
    }
});

test('landing is public and evaluation login moved to /avaliacao', async () => {
    const server = http.createServer(app).listen(0);

    try {
        const landing = await getText(server, '/');
        assert.equal(landing.res.statusCode, 200);
        assert.match(landing.text, /Acessar Salas/);
        assert.match(landing.text, /href="\/avaliacao"/);
        assert.match(landing.text, /href="#audicao"/);
        assert.match(landing.text, /href="#sistema"/);
        assert.match(landing.text, /href="\/admin\/login"/);
        assert.doesNotMatch(landing.text, /href="\/?index\.ejs"/);
        assert.doesNotMatch(landing.text, /href="\/results"/);

        const login = await getText(server, '/avaliacao');
        assert.equal(login.res.statusCode, 200);
        assert.match(login.text, /Entrar na Avalia/);
        assert.doesNotMatch(login.text, /href="\/results"/);
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
        assert.match(direct.headers.location, /^\/avaliacao\?message=/);

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
        assert.equal(forged.headers.location, '/turmas/Professor%20A%20Seguro');
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
        const csrfToken = await getTeacherCsrf(server, 'Professor Dono', cookie);
        const access = await postJson(server, '/turmas/access', {
            evaluatorName: 'Outro Professor',
            turmaId: turma.id,
            password: 'senha-da-turma',
        }, { Cookie: cookie, 'X-CSRF-Token': csrfToken });

        assert.equal(access.json.success, true);
        assert.equal(access.json.redirectUrl, `/turmas/Professor%20Dono/${turma.id}`);
    } finally {
        server.close();
    }
});

test('teacher can view a turma without password but only the responsible teacher can edit attendance', async () => {
    service.addTeacher('Professor Responsavel', 'senha-responsavel');
    service.addTeacher('Professor Observador', 'senha-observador');
    const responsible = service.getTeacherList().find((row) => row.name === 'Professor Responsavel');
    service.createTurma('Turma Sem PIN', responsible.id, 'senha-que-nao-deve-ser-pedida');
    const turma = service.getTurmas().find((row) => row.name === 'Turma Sem PIN');
    service.createCandidate({ name: 'Aluno Sem PIN', gender: 'male', presence: '0%', status: 'Bolsista', turma_id: turma.id });

    const server = http.createServer(app).listen(0);

    try {
        const observerCookie = await loginTeacher(server, 'Professor Observador', 'senha-observador');
        const observerPage = await getText(server, `/turmas/Professor%20Observador/${turma.id}`, { Cookie: observerCookie });
        assert.equal(observerPage.res.statusCode, 200);
        assert.match(observerPage.text, /Turma Sem PIN/);

        const observerCsrf = extractCsrfToken(observerPage.text);
        const observerForm = new URLSearchParams({ _csrf: observerCsrf, total_aulas: '10' });
        const blocked = await postForm(
            server,
            `/turmas/Professor%20Observador/${turma.id}/aulas`,
            observerForm,
            { Cookie: observerCookie }
        );
        assert.equal(blocked.res.statusCode, 403);

        const responsibleCookie = await loginTeacher(server, 'Professor Responsavel', 'senha-responsavel');
        const responsiblePage = await getText(server, `/turmas/Professor%20Responsavel/${turma.id}`, { Cookie: responsibleCookie });
        assert.equal(responsiblePage.res.statusCode, 200);

        const responsibleCsrf = extractCsrfToken(responsiblePage.text);
        const saved = await postForm(
            server,
            `/turmas/Professor%20Responsavel/${turma.id}/aulas`,
            new URLSearchParams({ _csrf: responsibleCsrf, total_aulas: '10' }),
            { Cookie: responsibleCookie }
        );
        assert.equal(saved.res.statusCode, 302);
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
        const partial = await postJson(server, '/api/check-teacher', { name: 'Professor' });
        const short = await postJson(server, '/api/check-teacher', { name: 'Be' });

        assert.equal(known.json.exists, true);
        assert.equal(unknown.json.exists, false);
        assert.equal(partial.json.exists, false);
        assert.equal(short.json.exists, false);
    } finally {
        server.close();
    }
});

test('teacher logout clears teacher session', async () => {
    service.addTeacher('Professor Troca', 'senha');
    const server = http.createServer(app).listen(0);

    try {
        const cookie = await loginTeacher(server, 'Professor Troca', 'senha');
        const page = await getText(server, '/turmas/Professor%20Troca', { Cookie: cookie });
        assert.equal(page.res.statusCode, 200);
        assert.match(page.text, /Sair/);

        const csrfToken = extractCsrfToken(page.text);
        const logout = await postForm(
            server,
            '/teacher/logout',
            new URLSearchParams({ _csrf: csrfToken }),
            { Cookie: cookie }
        );
        assert.equal(logout.res.statusCode, 302);
        assert.equal(logout.res.headers.location, '/avaliacao');
        assert.match(logout.res.headers['set-cookie'].join(';'), /teacher_access=;/);

        const blocked = await request(server, '/turmas/Professor%20Troca');
        assert.equal(blocked.statusCode, 302);
        assert.match(blocked.headers.location, /^\/avaliacao\?message=/);
    } finally {
        server.close();
    }
});

test('back navigation script uses explicit href instead of history back', () => {
    const script = fs.readFileSync(path.join(__dirname, '..', 'static', 'back.js'), 'utf8');
    assert.doesNotMatch(script, /history\.back/);
    assert.match(script, /window\.location\.href = destination/);
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
        const csrfToken = await getTeacherCsrf(server, 'Avaliador PIN', cookie);
        const bad = await postJson(server, '/turmas/evaluate-access', {
            evaluatorName: 'Avaliador PIN',
            turmaId: turma.id,
            code: '0000',
        }, { Cookie: cookie, 'X-CSRF-Token': csrfToken });
        assert.equal(bad.json.success, false);

        const good = await postJson(server, '/turmas/evaluate-access', {
            evaluatorName: 'Avaliador PIN',
            turmaId: turma.id,
            code,
        }, { Cookie: cookie, 'X-CSRF-Token': csrfToken });
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
        const csrfToken = await getTeacherCsrf(server, teacher.name, teacherCookie);
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
        }, { Cookie: teacherCookie, 'X-CSRF-Token': csrfToken });
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

        const live = await getText(server, `/results?turmaId=${turma.id}`, { Cookie: adminCookie() });
        assert.match(live.text, /Avaliadores ativos/);

        service.endSessionByTurma(turma.id);

        const closed = await getJson(
            server,
            `/api/evaluators/status?evaluatorName=${encodeURIComponent(teacher.name)}&turmaId=${turma.id}`,
            { Cookie: authCookies }
        );
        assert.equal(closed.json.sessionClosed, true);
        assert.equal(closed.json.activeCount, 0);

        const closedResults = await getText(server, `/results?turmaId=${turma.id}`, { Cookie: adminCookie() });
        assert.equal(closedResults.res.statusCode, 302);
        assert.equal(closedResults.res.headers.location, '/results/history');
    } finally {
        server.close();
    }
});

test('tampered admin cookie is rejected', async () => {
    const server = http.createServer(app).listen(0);

    try {
        const forged = `${config.adminCookieName}=${encodeURIComponent(config.adminCookieValue)}`;
        const res = await request(server, '/admin', { Cookie: forged });
        assert.equal(res.statusCode, 302);
        assert.equal(res.headers.location, '/admin/login');
    } finally {
        server.close();
    }
});

test('sensitive authenticated POSTs require CSRF', async () => {
    service.addTeacher('Professor CSRF', 'senha');
    const server = http.createServer(app).listen(0);

    try {
        const cookie = await loginTeacher(server, 'Professor CSRF', 'senha');
        const res = await postJson(server, '/turmas/access', {
            turmaId: 1,
            password: 'qualquer',
        }, { Cookie: cookie });

        assert.equal(res.res.statusCode, 403);
        assert.equal(res.json.success, false);
    } finally {
        server.close();
    }
});

test('evaluation POST ignores candidate scores outside the authorized turma', async () => {
    service.addTeacher('Professor Escopo', 'senha');
    const teacher = service.getTeacherList().find((row) => row.name === 'Professor Escopo');
    service.createTurma('Turma Permitida', teacher.id, 'senha-a');
    service.createTurma('Turma Bloqueada', teacher.id, 'senha-b');
    const allowedTurma = service.getTurmas().find((row) => row.name === 'Turma Permitida');
    const blockedTurma = service.getTurmas().find((row) => row.name === 'Turma Bloqueada');
    service.createCandidate({ name: 'Aluno Permitido', gender: 'male', presence: '100%', status: 'Bolsista', turma_id: allowedTurma.id });
    service.createCandidate({ name: 'Aluno Bloqueado', gender: 'male', presence: '100%', status: 'Bolsista', turma_id: blockedTurma.id });
    const allowedCandidate = service.getCandidatesByTurma(allowedTurma.id)[0];
    const blockedCandidate = service.getCandidatesByTurma(blockedTurma.id)[0];
    const code = service.generateSessionCode(allowedTurma.id);

    const server = http.createServer(app).listen(0);

    try {
        const teacherCookie = await loginTeacher(server, teacher.name, 'senha');
        const turmaCsrf = await getTeacherCsrf(server, teacher.name, teacherCookie);
        const access = await postJson(server, '/turmas/evaluate-access', {
            turmaId: allowedTurma.id,
            code,
        }, { Cookie: teacherCookie, 'X-CSRF-Token': turmaCsrf });
        const evaluationCookie = access.res.headers['set-cookie'][0].split(';')[0];
        const authCookies = `${teacherCookie}; ${evaluationCookie}`;

        const evaluatePage = await getText(
            server,
            `/evaluate/${encodeURIComponent(teacher.name)}?turmaId=${allowedTurma.id}`,
            { Cookie: authCookies }
        );
        const csrfToken = extractCsrfToken(evaluatePage.text);
        const form = new URLSearchParams({
            _csrf: csrfToken,
            [`${allowedCandidate.id}_presenca_auxilios`]: '8',
            [`${allowedCandidate.id}_comprometimento_eventos`]: '8',
            [`${allowedCandidate.id}_abraco_postura`]: '9',
            [`${blockedCandidate.id}_presenca_auxilios`]: '10',
        });

        const save = await postForm(
            server,
            `/evaluate/${encodeURIComponent(teacher.name)}?turmaId=${allowedTurma.id}`,
            form,
            { Cookie: authCookies }
        );
        assert.equal(save.res.statusCode, 302);

        const allowedScores = service.getEvaluatorScores(teacher.id, allowedTurma.id);
        const blockedScores = service.getEvaluatorScores(teacher.id, blockedTurma.id);
        assert.equal(allowedScores[allowedCandidate.id].presenca_auxilios, '8');
        assert.equal(allowedScores[allowedCandidate.id].comprometimento_eventos, '8');
        assert.equal(allowedScores[allowedCandidate.id].abraco_postura, '9');
        assert.equal(blockedScores[blockedCandidate.id], undefined);
    } finally {
        server.close();
    }
});
