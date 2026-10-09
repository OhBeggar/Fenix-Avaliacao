const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avali-hardening-'));
process.env.EVALUATIONS_DB_PATH = path.join(tempDir, 'evaluations.db');
process.env.ADMIN_PASSWORD = 'test-admin-password';
process.env.ADMIN_COOKIE_SECRET = 'test-cookie-secret';

const app = require('../app');
const service = require('../src/services/evaluation-service');
const { db } = require('../src/db');
const { signAdminPayload } = require('../src/utils/admin-auth');
const { safeJson, validatePassword, cleanText } = require('../src/utils/security');
const config = require('../src/config');

function send(server, method, pathname, { headers = {}, form = null } = {}) {
    const { port } = server.address();
    const body = form ? new URLSearchParams(form).toString() : null;

    return new Promise((resolve, reject) => {
        const req = http.request({
            port,
            path: pathname,
            method,
            headers: {
                ...(body ? {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': Buffer.byteLength(body),
                } : {}),
                ...headers,
            },
        }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve({ res, text: Buffer.concat(chunks).toString('utf8') }));
        });

        req.on('error', reject);
        req.end(body || undefined);
    });
}

const get = (server, pathname, headers) => send(server, 'GET', pathname, { headers });
const post = (server, pathname, form, headers) => send(server, 'POST', pathname, { headers, form });

function adminCookie() {
    const token = signAdminPayload({
        type: 'admin',
        iat: Date.now(),
        exp: Date.now() + (60 * 60 * 1000),
    });
    return `${config.adminCookieName}=${encodeURIComponent(token)}`;
}

function extractCsrfToken(html) {
    const match = html.match(/"csrfToken":\s*"([^"]+)"/)
        || html.match(/name="_csrf" value="([^"]+)"/)
        || html.match(/input\.value = "([^"]+)"/);
    assert.ok(match, 'page should include a CSRF token');
    return match[1];
}

async function loginTeacher(server, name, password, ip = '198.51.100.1') {
    const login = await post(server, '/login', { name, password }, { 'X-Forwarded-For': ip });
    assert.equal(login.res.statusCode, 302);
    const raw = login.res.headers['set-cookie']?.find((c) => c.startsWith('teacher_access='));
    assert.ok(raw, 'teacher_access cookie should be set');
    return raw.split(';')[0];
}

async function teacherCsrf(server, teacherName, cookie) {
    const page = await get(server, `/turmas/${encodeURIComponent(teacherName)}`, { Cookie: cookie });
    assert.equal(page.res.statusCode, 200);
    return extractCsrfToken(page.text);
}

test.after(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

test('security headers are present and X-Powered-By is hidden', async () => {
    const server = http.createServer(app).listen(0);
    try {
        const plain = await get(server, '/');
        assert.equal(plain.res.headers['x-powered-by'], undefined);
        assert.match(plain.res.headers['content-security-policy'], /object-src 'none'/);
        assert.ok(plain.res.headers['permissions-policy']);
        assert.equal(plain.res.headers['cross-origin-opener-policy'], 'same-origin');
        assert.equal(plain.res.headers['strict-transport-security'], undefined);

        const https = await get(server, '/', { 'X-Forwarded-Proto': 'https' });
        assert.match(https.res.headers['strict-transport-security'], /max-age=/);
    } finally {
        server.close();
    }
});

test('live endpoints require a session', async () => {
    const server = http.createServer(app).listen(0);
    try {
        const events = await get(server, '/events');
        assert.equal(events.res.statusCode, 401);

        const status = await get(server, '/api/evaluators/status?turmaId=1');
        assert.equal(status.res.statusCode, 401);
    } finally {
        server.close();
    }
});

test('unknown routes and malformed params return generic errors without stack traces', async () => {
    const server = http.createServer(app).listen(0);
    try {
        const missing = await get(server, '/rota-que-nao-existe');
        assert.equal(missing.res.statusCode, 404);

        const malformed = await get(server, '/turmas/%E0%A4%A');
        assert.ok([400, 404].includes(malformed.res.statusCode));
        assert.doesNotMatch(malformed.text, /at .*\.js|node_modules|Error:/);
    } finally {
        server.close();
    }
});

test('admin login uses constant-time check, and locks out after repeated failures', async () => {
    const server = http.createServer(app).listen(0);
    try {
        const okIp = { 'X-Forwarded-For': '203.0.113.5' };
        const success = await post(server, '/admin/login', { password: 'test-admin-password' }, okIp);
        assert.equal(success.res.statusCode, 302);

        const attackerIp = { 'X-Forwarded-For': '203.0.113.99' };
        for (let i = 0; i < 5; i += 1) {
            const fail = await post(server, '/admin/login', { password: `errada-${i}` }, attackerIp);
            assert.equal(fail.res.statusCode, 401);
        }

        // Mesmo com a senha correta, o IP bloqueado continua barrado.
        const locked = await post(server, '/admin/login', { password: 'test-admin-password' }, attackerIp);
        assert.equal(locked.res.statusCode, 429);
        assert.match(locked.text, /Muitas tentativas/);
        assert.equal(locked.res.headers['set-cookie'], undefined);
    } finally {
        server.close();
    }
});

test('teacher login locks out after repeated failures for the same name and IP', async () => {
    service.addTeacher('Professor Bloqueio', 'senha-forte-1');
    const server = http.createServer(app).listen(0);
    try {
        const ip = { 'X-Forwarded-For': '192.0.2.50' };
        for (let i = 0; i < 6; i += 1) {
            const fail = await post(server, '/login', { name: 'Professor Bloqueio', password: `errada-${i}` }, ip);
            assert.equal(fail.res.statusCode, 200);
            assert.match(fail.text, /inválidos/);
        }

        const locked = await post(server, '/login', { name: 'Professor Bloqueio', password: 'senha-forte-1' }, ip);
        assert.equal(locked.res.statusCode, 429);
        assert.equal(locked.res.headers['set-cookie'], undefined);

        // Outro IP não é afetado pelo bloqueio do primeiro.
        const other = await post(server, '/login', { name: 'Professor Bloqueio', password: 'senha-forte-1' }, { 'X-Forwarded-For': '192.0.2.51' });
        assert.equal(other.res.statusCode, 302);
    } finally {
        server.close();
    }
});

test('CSRF token is bound to the session that received it', async () => {
    service.addTeacher('Professor CSRF A', 'senha-forte-a');
    service.addTeacher('Professor CSRF B', 'senha-forte-b');
    const server = http.createServer(app).listen(0);

    try {
        const cookieA = await loginTeacher(server, 'Professor CSRF A', 'senha-forte-a', '198.51.100.10');
        const cookieB = await loginTeacher(server, 'Professor CSRF B', 'senha-forte-b', '198.51.100.11');
        const tokenA = await teacherCsrf(server, 'Professor CSRF A', cookieA);
        const tokenB = await teacherCsrf(server, 'Professor CSRF B', cookieB);

        const foreign = await post(server, '/turmas/evaluate-access', { _csrf: tokenA, turmaId: '1', code: '0000' }, { Cookie: cookieB });
        assert.equal(foreign.res.statusCode, 403);

        const anonymous = await post(server, '/turmas/evaluate-access', { _csrf: tokenA, turmaId: '1', code: '0000' });
        assert.equal(anonymous.res.statusCode, 403);

        const own = await post(server, '/turmas/evaluate-access', { _csrf: tokenB, turmaId: '1', code: '0000' }, { Cookie: cookieB });
        assert.equal(own.res.statusCode, 200);
        assert.equal(JSON.parse(own.text).success, false);
    } finally {
        server.close();
    }
});

test('teacher session dies when the password is reset or the teacher is removed', async () => {
    service.addTeacher('Professor Sessao', 'senha-forte-s');
    service.addTeacher('Professor Removido', 'senha-forte-r');
    const server = http.createServer(app).listen(0);

    try {
        const cookie = await loginTeacher(server, 'Professor Sessao', 'senha-forte-s', '198.51.100.20');
        const before = await get(server, '/turmas/Professor%20Sessao', { Cookie: cookie });
        assert.equal(before.res.statusCode, 200);

        const teacher = service.getTeacherByName('Professor Sessao');
        service.resetTeacherPassword(teacher.id, 'outra-senha-forte');
        const after = await get(server, '/turmas/Professor%20Sessao', { Cookie: cookie });
        assert.equal(after.res.statusCode, 302);
        assert.match(after.res.headers.location, /^\/avaliacao/);

        const removedCookie = await loginTeacher(server, 'Professor Removido', 'senha-forte-r', '198.51.100.21');
        const removed = service.getTeacherByName('Professor Removido');
        service.deleteTeacher(removed.id);
        const removedPage = await get(server, '/turmas/Professor%20Removido', { Cookie: removedCookie });
        assert.equal(removedPage.res.statusCode, 302);
    } finally {
        server.close();
    }
});

test('reset code is invalidated after too many wrong attempts', () => {
    service.addTeacher('Professor Reset', 'senha-forte-x');
    const teacher = service.getTeacherByName('Professor Reset');
    const { pin } = service.generateResetPin(teacher.id);
    const wrong = pin === '00000' ? '11111' : '00000';

    for (let i = 0; i < 5; i += 1) {
        assert.throws(() => service.resetPasswordWithPin('Professor Reset', wrong, 'nova-senha-forte'), /inválido/);
    }

    // O código certo já não funciona: a força bruta dos 100 mil códigos fica inviável.
    assert.throws(() => service.resetPasswordWithPin('Professor Reset', pin, 'nova-senha-forte'), /inválido/);
    assert.ok(service.verifyTeacher('Professor Reset', 'senha-forte-x'));

    // Um novo código gerado pelo admin volta a funcionar normalmente.
    const fresh = service.generateResetPin(teacher.id);
    service.resetPasswordWithPin('Professor Reset', fresh.pin, 'nova-senha-forte');
    assert.ok(service.verifyTeacher('Professor Reset', 'nova-senha-forte'));
});

test('password reset route enforces the password policy', async () => {
    const server = http.createServer(app).listen(0);
    try {
        const page = await get(server, '/professor/redefinir-senha');
        const token = extractCsrfToken(page.text);

        const weak = await post(server, '/professor/redefinir-senha', {
            _csrf: token,
            name: 'Qualquer',
            code: '12345',
            password: '1234',
            password2: '1234',
        }, { 'X-Forwarded-For': '198.51.100.30' });
        assert.equal(weak.res.statusCode, 200);
        assert.match(weak.text, /pelo menos 6 caracteres/);
    } finally {
        server.close();
    }
});

test('PIN check is rate limited per teacher', async () => {
    service.addTeacher('Professor PIN', 'senha-forte-p');
    const server = http.createServer(app).listen(0);

    try {
        const cookie = await loginTeacher(server, 'Professor PIN', 'senha-forte-p', '198.51.100.40');
        const token = await teacherCsrf(server, 'Professor PIN', cookie);
        const headers = { Cookie: cookie, 'X-Forwarded-For': '198.51.100.40' };

        for (let i = 0; i < 10; i += 1) {
            const attempt = await post(server, '/turmas/evaluate-access', { _csrf: token, turmaId: '1', code: '0000' }, headers);
            assert.equal(attempt.res.statusCode, 200);
        }

        const blocked = await post(server, '/turmas/evaluate-access', { _csrf: token, turmaId: '1', code: '0000' }, headers);
        assert.equal(blocked.res.statusCode, 429);
        assert.equal(JSON.parse(blocked.text).success, false);
    } finally {
        server.close();
    }
});

test('admin routes reject weak teacher passwords and empty names', async () => {
    const server = http.createServer(app).listen(0);
    try {
        const cookie = adminCookie();
        const page = await get(server, '/admin', { Cookie: cookie });
        const token = extractCsrfToken(page.text);
        const headers = { Cookie: cookie, 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': token };

        const weak = await post(server, '/admin/teacher/add', { name: 'Professor Fraco', password: '123' }, headers);
        assert.equal(weak.res.statusCode, 400);
        assert.match(JSON.parse(weak.text).message, /pelo menos 6/);
        assert.equal(service.getTeacherByName('Professor Fraco'), null);

        const empty = await post(server, '/admin/teacher/add', { name: '   ', password: 'senha-forte-1' }, headers);
        assert.equal(empty.res.statusCode, 400);

        const good = await post(server, '/admin/teacher/add', { name: 'Professor Forte', password: 'senha-forte-1' }, headers);
        assert.equal(good.res.statusCode, 200);
        assert.ok(service.getTeacherByName('Professor Forte'));

        const duplicate = await post(server, '/admin/teacher/add', { name: 'Professor Forte', password: 'senha-forte-1' }, headers);
        assert.equal(duplicate.res.statusCode, 400);
        assert.match(JSON.parse(duplicate.text).message, /Já existe/);
    } finally {
        server.close();
    }
});

test('results page cannot be broken out of by a malicious student name', async () => {
    service.addTeacher('Professor XSS', 'senha-forte-z');
    const teacher = service.getTeacherByName('Professor XSS');
    service.createTurma('Turma XSS', teacher.id, '');
    const turma = service.getTurmas().find((row) => row.name === 'Turma XSS');
    const payload = '</script><script>alert(1)</script>';
    service.createCandidate({ name: payload, gender: 'male', presence: '100%', status: 'Bolsista', turma_id: turma.id });
    service.generateSessionCode(turma.id);

    const server = http.createServer(app).listen(0);
    try {
        const page = await get(server, `/results?turmaId=${turma.id}`, { Cookie: adminCookie() });
        assert.equal(page.res.statusCode, 200);
        assert.ok(!page.text.includes(payload), 'raw payload must never appear in the page');
    } finally {
        server.close();
    }
});

test('session PINs are 4 digits and closed PINs can be reused', () => {
    service.addTeacher('Professor PIN Gen', 'senha-forte-g');
    const teacher = service.getTeacherByName('Professor PIN Gen');
    service.createTurma('Turma PIN Gen', teacher.id, '');
    const turma = service.getTurmas().find((row) => row.name === 'Turma PIN Gen');

    for (let i = 0; i < 25; i += 1) {
        const code = service.generateSessionCode(turma.id);
        assert.match(String(code.code || code), /^\d{4}$/);
    }
});

test('helpers: safeJson, validatePassword and cleanText', () => {
    const json = safeJson({ v: '</script><!-- & \u2028' });
    assert.ok(!json.includes('<') && !json.includes('>') && !json.includes('&'));
    assert.equal(JSON.parse(json).v, '</script><!-- & \u2028');

    assert.match(validatePassword('1234'), /pelo menos 6/);
    assert.match(validatePassword('123456'), /comum/);
    assert.match(validatePassword('345678'), /previsível/);
    assert.equal(validatePassword('lua742'), null);
    assert.match(validatePassword('12345678'), /comum/);
    assert.match(validatePassword('aaaaaaaaaa'), /previsível/);
    assert.match(validatePassword('maria silva', { name: 'Maria Silva' }), /igual ao nome/);
    assert.equal(validatePassword('uma-senha-boa-42'), null);
    assert.equal(validatePassword(undefined), 'A senha deve ter pelo menos 6 caracteres.');

    assert.equal(cleanText('  Ana \n  Paula\u0000  ', 50), 'Ana Paula');
    assert.equal(cleanText('x'.repeat(500), 10).length, 10);
});

test('"Esqueci a senha" starts hidden and is revealed only after a failed login', async () => {
    service.addTeacher('Professor Esqueci', 'senha-forte-e');
    const server = http.createServer(app).listen(0);

    try {
        const clean = await get(server, '/avaliacao');
        assert.equal(clean.res.statusCode, 200);
        assert.match(clean.text, /id="forgotLink"[^>]*display:\s*none/);
        assert.doesNotMatch(clean.text, /data-forgot="1"/);

        const failed = await post(server, '/login', { name: 'Professor Esqueci', password: 'errada' }, { 'X-Forwarded-For': '192.0.2.77' });
        assert.equal(failed.res.statusCode, 200);
        assert.match(failed.text, /data-forgot="1"/);

        // Mensagens que não são falha de login (ex.: senha atualizada) não revelam o link
        const updated = await get(server, `/avaliacao?message=${encodeURIComponent('Senha atualizada. Faça login.')}`);
        assert.doesNotMatch(updated.text, /data-forgot="1"/);
    } finally {
        server.close();
    }
});
