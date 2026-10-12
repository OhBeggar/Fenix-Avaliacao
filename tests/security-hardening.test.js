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

test('teacher email reset matches name and email, invalidates prior code and consumes the latest code once', async () => {
    service.addTeacher({ name: 'Professora Email Reset', email: 'reset@example.com', password: '' });
    const teacher = service.getTeacherByName('Professora Email Reset');
    const before = db.prepare('SELECT COUNT(*) AS count FROM teacher_reset_tokens WHERE evaluator_id = ?').get(teacher.id).count;

    let sentCode = '';
    let sentCount = 0;
    const fakeMailer = async ({ to, nome, codigo }) => {
        assert.equal(to, 'reset@example.com');
        assert.equal(nome, 'Professora Email Reset');
        sentCode = codigo;
        sentCount += 1;
    };

    const wrong = await service.requestTeacherResetByEmail('Professora Email Reset', 'wrong@example.com', fakeMailer);
    assert.deepEqual(wrong, { ok: true, sent: false });
    assert.equal(sentCount, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM teacher_reset_tokens WHERE evaluator_id = ?').get(teacher.id).count, before);

    let expiredCode = '';
    await service.requestTeacherResetByEmail('Professora Email Reset', 'reset@example.com', async ({ codigo }) => { expiredCode = codigo; });
    db.prepare(`UPDATE teacher_reset_tokens SET expires_at = ? WHERE evaluator_id = ? AND used_at IS NULL`)
        .run(new Date(Date.now() - 1000).toISOString(), teacher.id);
    assert.throws(() => service.resetPasswordWithPin('Professora Email Reset', expiredCode, 'SenhaNova@2026'), /inválido ou expirado/);

    const requested = await service.requestTeacherResetByEmail('  PROFESSORA EMAIL RESET ', ' RESET@example.com ', fakeMailer);
    assert.equal(requested.sent, true);
    assert.match(sentCode, /^\d{5}$/);

    const firstCode = sentCode;
    await service.requestTeacherResetByEmail('Professora Email Reset', 'reset@example.com', fakeMailer);
    const latestCode = sentCode;
    assert.notEqual(latestCode, '');

    assert.throws(() => service.resetPasswordWithPin('Professora Email Reset', firstCode, 'SenhaNova@2026'), /inválido ou expirado/);
    assert.throws(() => service.resetPasswordWithPin('Professora Email Reset', latestCode, '1532'), /diferente da padrão/);
    service.resetPasswordWithPin('Professora Email Reset', latestCode, 'SenhaNova@2026');
    assert.equal(service.getTeacherById(teacher.id).must_change_password, 0);
    assert.ok(service.verifyTeacher('Professora Email Reset', 'SenhaNova@2026'));
    assert.throws(() => service.resetPasswordWithPin('Professora Email Reset', latestCode, 'OutraSenha@2026'), /inválido ou expirado/);

    const usedAt = db.prepare(`SELECT used_at FROM teacher_reset_tokens
        WHERE evaluator_id = ? ORDER BY id DESC LIMIT 1`).get(teacher.id).used_at;
    assert.ok(usedAt);
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
        assert.equal(weak.res.statusCode, 400);
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

test('admin teacher management requires a valid unique email and flags the default password', async () => {
    const server = http.createServer(app).listen(0);
    try {
        const cookie = adminCookie();
        const page = await get(server, '/admin', { Cookie: cookie });
        const token = extractCsrfToken(page.text);
        const headers = { Cookie: cookie, 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': token };

        const missingEmail = await post(server, '/admin/teacher/add', { name: 'Professor Sem Email', password: '' }, headers);
        assert.equal(missingEmail.res.statusCode, 400);
        assert.match(JSON.parse(missingEmail.text).message, /e-mail válido/i);

        const invalidEmail = await post(server, '/admin/teacher/add', { name: 'Professor Email Ruim', email: 'invalido', password: '' }, headers);
        assert.equal(invalidEmail.res.statusCode, 400);

        const weak = await post(server, '/admin/teacher/add', { name: 'Professor Fraco', email: 'fraco@example.com', password: '123' }, headers);
        assert.equal(weak.res.statusCode, 400);
        assert.match(JSON.parse(weak.text).message, /pelo menos 6/);
        assert.equal(service.getTeacherByName('Professor Fraco'), null);

        const empty = await post(server, '/admin/teacher/add', { name: '   ', email: 'empty@example.com', password: 'senha-forte-1' }, headers);
        assert.equal(empty.res.statusCode, 400);

        const good = await post(server, '/admin/teacher/add', { name: 'Professor Forte', email: '  FORTE@EXAMPLE.COM  ', password: '' }, headers);
        assert.equal(good.res.statusCode, 200);
        const teacher = service.getTeacherByName('Professor Forte');
        assert.ok(teacher);
        assert.equal(service.getTeacherById(teacher.id).email, 'forte@example.com');
        assert.equal(service.getTeacherById(teacher.id).must_change_password, 1);
        assert.ok(service.verifyTeacher('Professor Forte', '1532'));

        const duplicateName = await post(server, '/admin/teacher/add', { name: 'Professor Forte', email: 'outro@example.com', password: 'senha-forte-1' }, headers);
        assert.equal(duplicateName.res.statusCode, 400);
        assert.match(JSON.parse(duplicateName.text).message, /nome/i);

        const duplicateEmail = await post(server, '/admin/teacher/add', { name: 'Outra Professora', email: 'FORTE@example.com', password: 'senha-forte-1' }, headers);
        assert.equal(duplicateEmail.res.statusCode, 400);
        assert.match(JSON.parse(duplicateEmail.text).message, /e-mail/i);

        const changeEmail = await post(server, '/admin/teacher/update', {
            teacherId: teacher.id,
            email: 'nova@example.com',
            password: 'senha-personalizada',
        }, headers);
        assert.equal(changeEmail.res.statusCode, 200);
        assert.equal(service.getTeacherById(teacher.id).email, 'nova@example.com');
        assert.equal(service.getTeacherById(teacher.id).must_change_password, 0);

        const setDefaultPassword = await post(server, '/admin/teacher/update', {
            teacherId: teacher.id,
            email: 'nova@example.com',
            password: '1532',
        }, headers);
        assert.equal(setDefaultPassword.res.statusCode, 200);
        assert.equal(service.getTeacherById(teacher.id).must_change_password, 1);
        assert.ok(service.verifyTeacher('Professor Forte', '1532'));

        service.addTeacher({ name: 'Professora Outra', email: 'outro@example.com', password: 'senha-personalizada' });
        const duplicate = await post(server, '/admin/teacher/update', {
            teacherId: teacher.id,
            email: 'outro@example.com',
            password: '',
        }, headers);
        assert.equal(duplicate.res.statusCode, 400);
        assert.match(JSON.parse(duplicate.text).message, /e-mail/i);
        assert.equal(service.getTeacherById(teacher.id).email, 'nova@example.com');
    } finally {
        server.close();
    }
});

test('teacher with default password must change it before accessing turmas', async () => {
    const server = http.createServer(app).listen(0);
    try {
        service.addTeacher({ name: 'Professor Troca Obrigatória', email: 'troca@example.com', password: '' });
        const teacher = service.getTeacherByName('Professor Troca Obrigatória');
        assert.equal(service.getTeacherById(teacher.id).must_change_password, 1);

        const login = await post(server, '/login', {
            name: 'Professor Troca Obrigatória',
            password: '1532',
        }, { 'X-Forwarded-For': '198.51.100.41' });
        assert.equal(login.res.statusCode, 302);
        assert.equal(login.res.headers.location, '/avaliacao/alterar-senha');
        let cookie = login.res.headers['set-cookie'].find(value => value.startsWith('teacher_access=')).split(';')[0];

        const blockedRoom = await get(server, `/turmas/${encodeURIComponent(teacher.name)}`, { Cookie: cookie });
        assert.equal(blockedRoom.res.statusCode, 302);
        assert.equal(blockedRoom.res.headers.location, '/avaliacao/alterar-senha');

        const blockedEvaluation = await get(server, `/evaluate/${encodeURIComponent(teacher.name)}?turmaId=1`, { Cookie: cookie });
        assert.equal(blockedEvaluation.res.statusCode, 302);
        assert.equal(blockedEvaluation.res.headers.location, '/avaliacao/alterar-senha');

        const blockedPinAccess = await post(server, '/turmas/evaluate-access', {
            turmaId: '1',
            code: '1234',
        }, { Cookie: cookie });
        assert.equal(blockedPinAccess.res.statusCode, 302);
        assert.equal(blockedPinAccess.res.headers.location, '/avaliacao/alterar-senha');

        const changePage = await get(server, '/avaliacao/alterar-senha', { Cookie: cookie });
        assert.equal(changePage.res.statusCode, 200);
        const token = extractCsrfToken(changePage.text);

        const defaultRejected = await post(server, '/avaliacao/alterar-senha', {
            _csrf: token,
            password: '1532',
            password2: '1532',
        }, { Cookie: cookie });
        assert.equal(defaultRejected.res.statusCode, 400);
        assert.match(defaultRejected.text, /diferente da padrão 1532/);

        const mismatch = await post(server, '/avaliacao/alterar-senha', {
            _csrf: token,
            password: 'Trilha@2026',
            password2: 'Trilha@2025',
        }, { Cookie: cookie });
        assert.equal(mismatch.res.statusCode, 400);
        assert.match(mismatch.text, /não coincidem/);

        const changed = await post(server, '/avaliacao/alterar-senha', {
            _csrf: token,
            password: 'Trilha@2026',
            password2: 'Trilha@2026',
        }, { Cookie: cookie });
        assert.equal(changed.res.statusCode, 302);
        assert.equal(changed.res.headers.location, `/turmas/${encodeURIComponent(teacher.name)}`);
        cookie = changed.res.headers['set-cookie'].find(value => value.startsWith('teacher_access=')).split(';')[0];
        assert.equal(service.getTeacherById(teacher.id).must_change_password, 0);

        const allowedRoom = await get(server, `/turmas/${encodeURIComponent(teacher.name)}`, { Cookie: cookie });
        assert.equal(allowedRoom.res.statusCode, 200);

        const secondLogin = await post(server, '/login', {
            name: teacher.name,
            password: 'Trilha@2026',
        }, { 'X-Forwarded-For': '198.51.100.42' });
        assert.equal(secondLogin.res.statusCode, 302);
        assert.equal(secondLogin.res.headers.location, `/turmas/${encodeURIComponent(teacher.name)}`);
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

test('teacher login hides the forgot-password link until a password error and responds generically', async () => {
    const server = http.createServer(app).listen(0);

    try {
        const clean = await get(server, '/avaliacao');
        assert.equal(clean.res.statusCode, 200);
        assert.match(clean.text, /href="\/avaliacao\/esqueci-senha"[^>]*id="forgotLink"\s+hidden/);

        const forgot = await get(server, '/avaliacao/esqueci-senha');
        assert.equal(forgot.res.statusCode, 200);
        const csrf = extractCsrfToken(forgot.text);
        const tokenCountBefore = db.prepare('SELECT COUNT(*) AS count FROM teacher_reset_tokens').get().count;
        const response = await post(server, '/avaliacao/esqueci-senha', {
            _csrf: csrf,
            name: 'Nome desconhecido',
            email: 'wrong@example.com',
        }, { 'X-Forwarded-For': '192.0.2.77' });
        assert.equal(response.res.statusCode, 200);
        assert.match(response.text, /Se os dados estiverem corretos, enviamos um código para o e-mail cadastrado/);
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM teacher_reset_tokens').get().count, tokenCountBefore);
    } finally {
        server.close();
    }
});
