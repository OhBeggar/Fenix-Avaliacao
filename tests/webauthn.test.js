const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avali-webauthn-'));
process.env.EVALUATIONS_DB_PATH = path.join(tempDir, 'evaluations.db');
process.env.ADMIN_PASSWORD = 'test-admin-password';
process.env.ADMIN_COOKIE_SECRET = 'test-cookie-secret';
process.env.PUBLIC_BASE_URL = 'https://avali.example';

const app = require('../app');
const service = require('../src/services/evaluation-service');
const webauthn = require('../src/services/webauthn-service');
const { db } = require('../src/db');
const { signAdminPayload } = require('../src/utils/admin-auth');
const config = require('../src/config');

const enabled = webauthn.isEnabled();
const ORIGIN = 'https://avali.example';
const RP_ID = 'avali.example';

let isoCBOR = null;
if (enabled) {
    ({ isoCBOR } = require('@simplewebauthn/server/helpers'));
}

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest();
const b64u = (buffer) => Buffer.from(buffer).toString('base64url');

// Simula o celular: guarda a chave privada e assina como um autenticador de verdade faria.
class FakeAuthenticator {
    constructor({ synced = false } = {}) {
        const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
        this.privateKey = privateKey;
        this.jwk = publicKey.export({ format: 'jwk' });
        this.credentialId = crypto.randomBytes(32);
        this.counter = 0;
        this.synced = synced;
        this.userHandle = null;
    }

    coseKey() {
        return Buffer.from(isoCBOR.encode(new Map([
            [1, 2],
            [3, -7],
            [-1, 1],
            [-2, Buffer.from(this.jwk.x, 'base64url')],
            [-3, Buffer.from(this.jwk.y, 'base64url')],
        ])));
    }

    createCredential(options, { origin = ORIGIN, uv = true } = {}) {
        this.userHandle = options.user.id;

        let flags = 0x01 | 0x40;
        if (uv) flags |= 0x04;
        if (this.synced) flags |= 0x08 | 0x10;

        const counter = Buffer.alloc(4);
        counter.writeUInt32BE(this.counter);
        const idLength = Buffer.alloc(2);
        idLength.writeUInt16BE(this.credentialId.length);

        const authData = Buffer.concat([
            sha256(RP_ID),
            Buffer.from([flags]),
            counter,
            Buffer.alloc(16),
            idLength,
            this.credentialId,
            this.coseKey(),
        ]);

        const attestationObject = Buffer.from(isoCBOR.encode(new Map([
            ['fmt', 'none'],
            ['attStmt', new Map()],
            ['authData', authData],
        ])));

        const clientDataJSON = Buffer.from(JSON.stringify({
            type: 'webauthn.create',
            challenge: options.challenge,
            origin,
            crossOrigin: false,
        }));

        return {
            id: b64u(this.credentialId),
            rawId: b64u(this.credentialId),
            type: 'public-key',
            clientExtensionResults: {},
            authenticatorAttachment: 'platform',
            response: {
                clientDataJSON: b64u(clientDataJSON),
                attestationObject: b64u(attestationObject),
                transports: ['internal'],
            },
        };
    }

    getAssertion(options, {
        origin = ORIGIN,
        uv = true,
        counter = null,
        userHandle = this.userHandle,
        tamper = false,
        credentialId = this.credentialId,
    } = {}) {
        if (counter === null) this.counter += 1;
        const signCount = counter === null ? this.counter : counter;

        let flags = 0x01;
        if (uv) flags |= 0x04;
        if (this.synced) flags |= 0x08 | 0x10;

        const counterBuffer = Buffer.alloc(4);
        counterBuffer.writeUInt32BE(signCount);
        const authData = Buffer.concat([sha256(RP_ID), Buffer.from([flags]), counterBuffer]);

        const clientDataJSON = Buffer.from(JSON.stringify({
            type: 'webauthn.get',
            challenge: options.challenge,
            origin,
            crossOrigin: false,
        }));

        const signature = crypto.sign(
            'sha256',
            Buffer.concat([authData, sha256(clientDataJSON)]),
            this.privateKey
        );
        if (tamper) signature[signature.length - 1] ^= 0xff;

        return {
            id: b64u(credentialId),
            rawId: b64u(credentialId),
            type: 'public-key',
            clientExtensionResults: {},
            authenticatorAttachment: 'platform',
            response: {
                clientDataJSON: b64u(clientDataJSON),
                authenticatorData: b64u(authData),
                signature: b64u(signature),
                userHandle: userHandle || undefined,
            },
        };
    }
}

function request(server, method, pathname, { headers = {}, json = null, form = null } = {}) {
    const { port } = server.address();
    let body = null;
    let contentType = null;
    if (json !== null) {
        body = JSON.stringify(json);
        contentType = 'application/json';
    } else if (form !== null) {
        body = new URLSearchParams(form).toString();
        contentType = 'application/x-www-form-urlencoded';
    }

    return new Promise((resolve, reject) => {
        const req = http.request({
            port,
            path: pathname,
            method,
            headers: {
                Accept: 'application/json',
                ...(body ? { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body) } : {}),
                ...headers,
            },
        }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let parsed = null;
                try { parsed = JSON.parse(text); } catch { /* html */ }
                resolve({ res, text, body: parsed });
            });
        });
        req.on('error', reject);
        req.end(body || undefined);
    });
}

function adminCookie() {
    const token = signAdminPayload({ type: 'admin', iat: Date.now(), exp: Date.now() + 3600000 });
    return `${config.adminCookieName}=${encodeURIComponent(token)}`;
}

function extractCsrfToken(html) {
    const match = html.match(/"csrfToken":\s*"([^"]+)"/)
        || html.match(/input\.value = "([^"]+)"/)
        || html.match(/name="_csrf"\s+value="([^"]+)"/);
    assert.ok(match, 'page should include a CSRF token');
    return match[1];
}

async function loginByPassword(server, name, password, ip) {
    const login = await request(server, 'POST', '/login', {
        form: { name, password },
        headers: { 'X-Forwarded-For': ip, Accept: 'text/html' },
    });
    assert.equal(login.res.statusCode, 302);
    const raw = login.res.headers['set-cookie'].find((c) => c.startsWith('teacher_access='));
    const cookie = raw.split(';')[0];
    const page = await request(server, 'GET', `/turmas/${encodeURIComponent(name)}`, {
        headers: { Cookie: cookie, Accept: 'text/html' },
    });
    return { cookie, csrf: extractCsrfToken(page.text) };
}

async function registerDevice(server, { cookie, csrf, ip, authenticator, label = 'Meu celular', createOpts }) {
    const headers = { Cookie: cookie, 'X-CSRF-Token': csrf, 'X-Forwarded-For': ip };
    const options = await request(server, 'POST', '/webauthn/register/options', { json: {}, headers });
    if (options.res.statusCode !== 200) return options;
    const credential = authenticator.createCredential(options.body.options, createOpts);
    return request(server, 'POST', '/webauthn/register/verify', { json: { credential, label }, headers });
}

async function loginWithPasskey(server, { ip, authenticator, assertionOpts, mutate }) {
    const headers = { 'X-Forwarded-For': ip };
    const options = await request(server, 'POST', '/webauthn/login/options', { json: {}, headers });
    assert.equal(options.res.statusCode, 200);
    let credential = authenticator.getAssertion(options.body.options, assertionOpts);
    if (mutate) credential = mutate(credential);
    const result = await request(server, 'POST', '/webauthn/login/verify', {
        json: { challengeId: options.body.challengeId, credential },
        headers,
    });
    return { options, credential, result };
}

test.after(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

const opts = { skip: !enabled && 'pacote @simplewebauthn/server não instalado (rode npm install)' };

test('webauthn is enabled from PUBLIC_BASE_URL and exposes the RP ID', opts, () => {
    assert.equal(webauthn.isEnabled(), true);
    assert.deepEqual(webauthn.publicConfig(), { enabled: true, rpID: RP_ID });
});

test('a teacher can enable biometrics and then log in without typing anything', opts, async () => {
    service.addTeacher('Professor Bio', 'senha-bio-1');
    const server = http.createServer(app).listen(0);
    try {
        const phone = new FakeAuthenticator();
        const session = await loginByPassword(server, 'Professor Bio', 'senha-bio-1', '198.51.100.1');

        const registered = await registerDevice(server, { ...session, ip: '198.51.100.1', authenticator: phone, label: 'Meu Android' });
        assert.equal(registered.res.statusCode, 200);
        assert.equal(registered.body.credentials.length, 1);
        assert.equal(registered.body.credentials[0].label, 'Meu Android');

        const listed = await request(server, 'GET', '/webauthn/credentials', { headers: { Cookie: session.cookie } });
        assert.equal(listed.body.credentials.length, 1);
        assert.ok(!('publicKey' in listed.body.credentials[0]), 'lista nunca expõe a chave');

        const { result } = await loginWithPasskey(server, { ip: '198.51.100.2', authenticator: phone });
        assert.equal(result.res.statusCode, 200);
        assert.equal(result.body.redirectUrl, '/turmas/Professor%20Bio');
        assert.equal(result.body.name, 'Professor Bio');

        const rawCookie = result.res.headers['set-cookie'].find((c) => c.startsWith('teacher_access='));
        assert.ok(rawCookie, 'login por biometria emite o mesmo cookie de sessão');
        assert.match(rawCookie, /HttpOnly/);

        const page = await request(server, 'GET', '/turmas/Professor%20Bio', {
            headers: { Cookie: rawCookie.split(';')[0], Accept: 'text/html' },
        });
        assert.equal(page.res.statusCode, 200);

        const row = db.prepare('SELECT counter, last_used_at FROM webauthn_credentials').get();
        assert.equal(row.counter, 1);
        assert.ok(row.last_used_at);
    } finally {
        server.close();
    }
});

test('login rejects replays, wrong origin, bad signatures, missing biometrics and unknown keys', opts, async () => {
    service.addTeacher('Professor Ataque', 'senha-ataque-1');
    const server = http.createServer(app).listen(0);
    try {
        const phone = new FakeAuthenticator();
        const session = await loginByPassword(server, 'Professor Ataque', 'senha-ataque-1', '198.51.100.10');
        await registerDevice(server, { ...session, ip: '198.51.100.10', authenticator: phone });

        // 1) Reaproveitar o mesmo desafio (replay)
        const first = await loginWithPasskey(server, { ip: '198.51.100.11', authenticator: phone });
        assert.equal(first.result.res.statusCode, 200);
        const replay = await request(server, 'POST', '/webauthn/login/verify', {
            json: { challengeId: first.options.body.challengeId, credential: first.credential },
            headers: { 'X-Forwarded-For': '198.51.100.11' },
        });
        assert.equal(replay.res.statusCode, 401);
        assert.equal(replay.res.headers['set-cookie'], undefined);

        // 2) Origem errada (site falso)
        const wrongOrigin = await loginWithPasskey(server, {
            ip: '198.51.100.12', authenticator: phone, assertionOpts: { origin: 'https://phishing.example' },
        });
        assert.equal(wrongOrigin.result.res.statusCode, 401);

        // 3) Assinatura adulterada
        const tampered = await loginWithPasskey(server, {
            ip: '198.51.100.13', authenticator: phone, assertionOpts: { tamper: true },
        });
        assert.equal(tampered.result.res.statusCode, 401);

        // 4) Sem verificação biométrica (só presença)
        const noUv = await loginWithPasskey(server, {
            ip: '198.51.100.14', authenticator: phone, assertionOpts: { uv: false },
        });
        assert.equal(noUv.result.res.statusCode, 401);

        // 5) Contador que não avança (chave clonada)
        const stale = await loginWithPasskey(server, {
            ip: '198.51.100.15', authenticator: phone, assertionOpts: { counter: 1 },
        });
        assert.equal(stale.result.res.statusCode, 401);

        // 6) Chave que o servidor nunca viu
        const stranger = new FakeAuthenticator();
        const unknown = await loginWithPasskey(server, { ip: '198.51.100.16', authenticator: stranger });
        assert.equal(unknown.result.res.statusCode, 401);

        // 7) userHandle de outra pessoa
        const wrongHandle = await loginWithPasskey(server, {
            ip: '198.51.100.17',
            authenticator: phone,
            assertionOpts: { userHandle: b64u(crypto.randomBytes(32)) },
        });
        assert.equal(wrongHandle.result.res.statusCode, 401);

        // 8) Desafio inexistente
        const bogus = await request(server, 'POST', '/webauthn/login/verify', {
            json: { challengeId: 'nao-existe', credential: first.credential },
            headers: { 'X-Forwarded-For': '198.51.100.18' },
        });
        assert.equal(bogus.res.statusCode, 401);

        // Depois de tudo isso, a chave verdadeira continua funcionando.
        const good = await loginWithPasskey(server, { ip: '198.51.100.19', authenticator: phone });
        assert.equal(good.result.res.statusCode, 200);
    } finally {
        server.close();
    }
});

test('passkeys synced across devices (counter always 0) keep working', opts, async () => {
    service.addTeacher('Professor Sync', 'senha-sync-1');
    const server = http.createServer(app).listen(0);
    try {
        const synced = new FakeAuthenticator({ synced: true });
        const session = await loginByPassword(server, 'Professor Sync', 'senha-sync-1', '198.51.100.20');
        const reg = await registerDevice(server, { ...session, ip: '198.51.100.20', authenticator: synced });
        assert.equal(reg.res.statusCode, 200);
        assert.equal(reg.body.credentials[0].synced, true);

        for (const ip of ['198.51.100.21', '198.51.100.22']) {
            const { result } = await loginWithPasskey(server, { ip, authenticator: synced, assertionOpts: { counter: 0 } });
            assert.equal(result.res.statusCode, 200);
        }
    } finally {
        server.close();
    }
});

test('registration needs a logged-in teacher, a session-bound CSRF token, biometrics and the right origin', opts, async () => {
    service.addTeacher('Professor Cadastro', 'senha-cad-1');
    const server = http.createServer(app).listen(0);
    try {
        const noToken = await request(server, 'POST', '/webauthn/register/options', {
            json: {}, headers: { 'X-Forwarded-For': '198.51.100.30' },
        });
        assert.equal(noToken.res.statusCode, 403);

        const anonymousPage = await request(server, 'GET', '/professor/redefinir-senha', { headers: { Accept: 'text/html' } });
        const anonymousToken = extractCsrfToken(anonymousPage.text);
        const notLogged = await request(server, 'POST', '/webauthn/register/options', {
            json: {}, headers: { 'X-CSRF-Token': anonymousToken, 'X-Forwarded-For': '198.51.100.30' },
        });
        assert.equal(notLogged.res.statusCode, 401);

        const session = await loginByPassword(server, 'Professor Cadastro', 'senha-cad-1', '198.51.100.31');

        const noUv = await registerDevice(server, {
            ...session, ip: '198.51.100.31', authenticator: new FakeAuthenticator(), createOpts: { uv: false },
        });
        assert.equal(noUv.res.statusCode, 400);

        const wrongOrigin = await registerDevice(server, {
            ...session, ip: '198.51.100.31', authenticator: new FakeAuthenticator(), createOpts: { origin: 'https://phishing.example' },
        });
        assert.equal(wrongOrigin.res.statusCode, 400);

        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM webauthn_credentials WHERE evaluator_id = ?')
            .get(service.getTeacherByName('Professor Cadastro').id).n, 0);
    } finally {
        server.close();
    }
});

test('a teacher cannot remove someone else\'s device, and is limited to 5 devices', opts, async () => {
    service.addTeacher('Professor Dono', 'senha-dono-1');
    service.addTeacher('Professor Intruso', 'senha-intruso-1');
    const server = http.createServer(app).listen(0);
    try {
        const owner = await loginByPassword(server, 'Professor Dono', 'senha-dono-1', '198.51.100.40');
        const intruder = await loginByPassword(server, 'Professor Intruso', 'senha-intruso-1', '198.51.100.41');

        const reg = await registerDevice(server, { ...owner, ip: '198.51.100.40', authenticator: new FakeAuthenticator() });
        const deviceId = reg.body.credentials[0].id;

        const steal = await request(server, 'POST', `/webauthn/credentials/${deviceId}/delete`, {
            json: {}, headers: { Cookie: intruder.cookie, 'X-CSRF-Token': intruder.csrf, 'X-Forwarded-For': '198.51.100.41' },
        });
        assert.equal(steal.res.statusCode, 404);

        for (let i = 0; i < 4; i += 1) {
            const more = await registerDevice(server, { ...owner, ip: `198.51.100.${50 + i}`, authenticator: new FakeAuthenticator() });
            assert.equal(more.res.statusCode, 200);
        }
        const sixth = await request(server, 'POST', '/webauthn/register/options', {
            json: {}, headers: { Cookie: owner.cookie, 'X-CSRF-Token': owner.csrf, 'X-Forwarded-For': '198.51.100.60' },
        });
        assert.equal(sixth.res.statusCode, 400);
        assert.match(sixth.body.message, /Limite/);

        const removed = await request(server, 'POST', `/webauthn/credentials/${deviceId}/delete`, {
            json: {}, headers: { Cookie: owner.cookie, 'X-CSRF-Token': owner.csrf, 'X-Forwarded-For': '198.51.100.40' },
        });
        assert.equal(removed.res.statusCode, 200);
        assert.equal(removed.body.credentials.length, 4);
    } finally {
        server.close();
    }
});

test('admin can revoke a teacher\'s devices, and removing the teacher deletes the keys', opts, async () => {
    service.addTeacher('Professor Perdeu', 'senha-perdeu-1');
    service.addTeacher('Professor Saiu', 'senha-saiu-1');
    const server = http.createServer(app).listen(0);
    try {
        const lostPhone = new FakeAuthenticator();
        const lost = await loginByPassword(server, 'Professor Perdeu', 'senha-perdeu-1', '198.51.100.70');
        await registerDevice(server, { ...lost, ip: '198.51.100.70', authenticator: lostPhone });
        assert.equal((await loginWithPasskey(server, { ip: '198.51.100.71', authenticator: lostPhone })).result.res.statusCode, 200);

        const anonymous = await request(server, 'POST', '/admin/teacher/webauthn/revoke', {
            json: { teacherId: 1 }, headers: { 'X-Forwarded-For': '198.51.100.72' },
        });
        assert.ok([302, 401, 403].includes(anonymous.res.statusCode));

        const cookie = adminCookie();
        const adminPage = await request(server, 'GET', '/admin', { headers: { Cookie: cookie, Accept: 'text/html' } });
        assert.match(adminPage.text, /Revogar biometria \(1\)/);
        const csrf = extractCsrfToken(adminPage.text);

        const teacherId = service.getTeacherByName('Professor Perdeu').id;
        const revoked = await request(server, 'POST', '/admin/teacher/webauthn/revoke', {
            json: { teacherId }, headers: { Cookie: cookie, 'X-CSRF-Token': csrf, 'X-Forwarded-For': '198.51.100.73' },
        });
        assert.equal(revoked.res.statusCode, 200);
        assert.equal(revoked.body.removed, 1);
        assert.equal((await loginWithPasskey(server, { ip: '198.51.100.74', authenticator: lostPhone })).result.res.statusCode, 401);

        // Removendo o professor, as chaves dele somem do banco
        const leaverPhone = new FakeAuthenticator();
        const leaver = await loginByPassword(server, 'Professor Saiu', 'senha-saiu-1', '198.51.100.75');
        await registerDevice(server, { ...leaver, ip: '198.51.100.75', authenticator: leaverPhone });
        const leaverId = service.getTeacherByName('Professor Saiu').id;
        service.deleteTeacher(leaverId);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM webauthn_credentials WHERE evaluator_id = ?').get(leaverId).n, 0);
        assert.equal((await loginWithPasskey(server, { ip: '198.51.100.76', authenticator: leaverPhone })).result.res.statusCode, 401);
    } finally {
        server.close();
    }
});

test('repeated failed biometric logins from one IP get blocked', opts, async () => {
    const server = http.createServer(app).listen(0);
    try {
        const headers = { 'X-Forwarded-For': '203.0.113.200' };
        for (let i = 0; i < 10; i += 1) {
            const bad = await request(server, 'POST', '/webauthn/login/verify', {
                json: { challengeId: `x${i}`, credential: { id: 'abc' } }, headers,
            });
            assert.equal(bad.res.statusCode, 401);
        }
        const blocked = await request(server, 'POST', '/webauthn/login/options', { json: {}, headers });
        assert.equal(blocked.res.statusCode, 429);
    } finally {
        server.close();
    }
});

test('login and teacher pages only offer biometrics when enabled, without cluttering the UI', opts, async () => {
    service.addTeacher('Professor Limpo', 'senha-limpa-1');
    const server = http.createServer(app).listen(0);
    try {
        // Login: o painel de biometria começa escondido (só aparece se o aparelho tiver a chave do nome digitado)
        const login = await request(server, 'GET', '/avaliacao', { headers: { Accept: 'text/html' } });
        assert.match(login.text, /id="bioPanel"[^>]*display:none/);
        assert.match(login.text, /id="bioUsePassword"/);
        assert.match(login.text, /\/webauthn\.js/);
        assert.match(login.text, /"avali\.example"/);
        assert.doesNotMatch(login.text, /class="action-link" id="bioLoginBtn"/);

        // Turmas: sem cartão fixo; só um link discreto no rodapé e a janela (aviso único)
        const session = await loginByPassword(server, 'Professor Limpo', 'senha-limpa-1', '198.51.100.90');
        const turmas = await request(server, 'GET', '/turmas/Professor%20Limpo', {
            headers: { Cookie: session.cookie, Accept: 'text/html' },
        });
        assert.equal(turmas.res.statusCode, 200);
        assert.doesNotMatch(turmas.text, /id="bioCard"/);
        assert.match(turmas.text, /id="bioFooter"[^>]*display:none/);
        assert.match(turmas.text, /id="bioModal"/);
        assert.match(turmas.text, /Gerenciar biometria/);
    } finally {
        server.close();
    }
});

// ============================================================
// Biometria do ADMIN
// ============================================================

async function adminSession(server, ip) {
    const cookie = adminCookie();
    const page = await request(server, 'GET', '/admin', { headers: { Cookie: cookie, Accept: 'text/html', 'X-Forwarded-For': ip } });
    assert.equal(page.res.statusCode, 200);
    return { cookie, csrf: extractCsrfToken(page.text), page };
}

async function registerAdminDevice(server, { cookie, csrf, ip, authenticator, label = 'Celular do admin', createOpts }) {
    const headers = { Cookie: cookie, 'X-CSRF-Token': csrf, 'X-Forwarded-For': ip };
    const options = await request(server, 'POST', '/admin/webauthn/register/options', { json: {}, headers });
    if (options.res.statusCode !== 200) return options;
    const credential = authenticator.createCredential(options.body.options, createOpts);
    return request(server, 'POST', '/admin/webauthn/register/verify', { json: { credential, label }, headers });
}

async function loginAdminWithPasskey(server, { ip, authenticator, assertionOpts }) {
    const headers = { 'X-Forwarded-For': ip };
    const options = await request(server, 'POST', '/admin/webauthn/login/options', { json: {}, headers });
    assert.equal(options.res.statusCode, 200);
    const credential = authenticator.getAssertion(options.body.options, assertionOpts);
    const result = await request(server, 'POST', '/admin/webauthn/login/verify', {
        json: { challengeId: options.body.challengeId, credential },
        headers,
    });
    return { options, credential, result };
}

test('admin can enable biometrics and then enter the panel with it', opts, async () => {
    db.prepare('DELETE FROM webauthn_admin_credentials').run();
    const server = http.createServer(app).listen(0);
    try {
        const phone = new FakeAuthenticator();
        const session = await adminSession(server, '198.51.100.100');

        const registered = await registerAdminDevice(server, { ...session, ip: '198.51.100.100', authenticator: phone });
        assert.equal(registered.res.statusCode, 200);
        assert.equal(registered.body.credentials.length, 1);

        const listed = await request(server, 'GET', '/admin/webauthn/credentials', { headers: { Cookie: session.cookie } });
        assert.equal(listed.body.credentials.length, 1);
        assert.ok(!('publicKey' in listed.body.credentials[0]));
        const anonymousList = await request(server, 'GET', '/admin/webauthn/credentials', {});
        assert.equal(anonymousList.res.statusCode, 401);

        const { result } = await loginAdminWithPasskey(server, { ip: '198.51.100.101', authenticator: phone });
        assert.equal(result.res.statusCode, 200);
        assert.equal(result.body.redirectUrl, '/admin');

        const rawCookie = result.res.headers['set-cookie'].find((c) => c.startsWith(`${config.adminCookieName}=`));
        assert.ok(rawCookie, 'login por biometria emite o mesmo cookie de sessão do admin');
        assert.match(rawCookie, /HttpOnly/);

        const panel = await request(server, 'GET', '/admin', { headers: { Cookie: rawCookie.split(';')[0], Accept: 'text/html' } });
        assert.equal(panel.res.statusCode, 200);
        assert.equal(db.prepare('SELECT counter FROM webauthn_admin_credentials').get().counter, 1);
    } finally {
        server.close();
    }
});

test('only the logged-in admin can enroll or manage admin devices', opts, async () => {
    db.prepare('DELETE FROM webauthn_admin_credentials').run();
    service.addTeacher('Professor Curioso', 'senha-curioso-1');
    const server = http.createServer(app).listen(0);
    try {
        const anonymous = await request(server, 'POST', '/admin/webauthn/register/options', {
            json: {}, headers: { 'X-Forwarded-For': '198.51.100.110' },
        });
        assert.equal(anonymous.res.statusCode, 401);

        const teacher = await loginByPassword(server, 'Professor Curioso', 'senha-curioso-1', '198.51.100.111');
        const asTeacher = await request(server, 'POST', '/admin/webauthn/register/options', {
            json: {}, headers: { Cookie: teacher.cookie, 'X-CSRF-Token': teacher.csrf, 'X-Forwarded-For': '198.51.100.111' },
        });
        assert.equal(asTeacher.res.statusCode, 401);

        const session = await adminSession(server, '198.51.100.112');
        const noToken = await request(server, 'POST', '/admin/webauthn/register/options', {
            json: {}, headers: { Cookie: session.cookie, 'X-Forwarded-For': '198.51.100.112' },
        });
        assert.equal(noToken.res.statusCode, 403);

        const noUv = await registerAdminDevice(server, {
            ...session, ip: '198.51.100.112', authenticator: new FakeAuthenticator(), createOpts: { uv: false },
        });
        assert.equal(noUv.res.statusCode, 400);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM webauthn_admin_credentials').get().n, 0);
    } finally {
        server.close();
    }
});

test('admin login rejects attacks, and teacher and admin keys are not interchangeable', opts, async () => {
    db.prepare('DELETE FROM webauthn_admin_credentials').run();
    service.addTeacher('Professor Trocado', 'senha-trocado-1');
    const server = http.createServer(app).listen(0);
    try {
        const adminPhone = new FakeAuthenticator();
        const session = await adminSession(server, '198.51.100.120');
        await registerAdminDevice(server, { ...session, ip: '198.51.100.120', authenticator: adminPhone });

        const first = await loginAdminWithPasskey(server, { ip: '198.51.100.121', authenticator: adminPhone });
        assert.equal(first.result.res.statusCode, 200);

        const replay = await request(server, 'POST', '/admin/webauthn/login/verify', {
            json: { challengeId: first.options.body.challengeId, credential: first.credential },
            headers: { 'X-Forwarded-For': '198.51.100.121' },
        });
        assert.equal(replay.res.statusCode, 401);

        const badCases = [
            { origin: 'https://phishing.example' },
            { tamper: true },
            { uv: false },
            { counter: 1 },
            { userHandle: b64u(crypto.randomBytes(32)) },
        ];
        for (let i = 0; i < badCases.length; i += 1) {
            const attempt = await loginAdminWithPasskey(server, {
                ip: `198.51.100.${130 + i}`, authenticator: adminPhone, assertionOpts: badCases[i],
            });
            assert.equal(attempt.result.res.statusCode, 401, `caso ${JSON.stringify(badCases[i])} deveria falhar`);
            assert.equal(attempt.result.res.headers['set-cookie'], undefined);
        }

        // Chave de PROFESSOR não entra no painel do admin
        const teacherPhone = new FakeAuthenticator();
        const teacher = await loginByPassword(server, 'Professor Trocado', 'senha-trocado-1', '198.51.100.140');
        await registerDevice(server, { ...teacher, ip: '198.51.100.140', authenticator: teacherPhone });
        const teacherOnAdmin = await loginAdminWithPasskey(server, { ip: '198.51.100.141', authenticator: teacherPhone });
        assert.equal(teacherOnAdmin.result.res.statusCode, 401);

        // Chave do ADMIN não entra como professor
        const adminOnTeacher = await loginWithPasskey(server, { ip: '198.51.100.142', authenticator: adminPhone });
        assert.equal(adminOnTeacher.result.res.statusCode, 401);

        // A chave verdadeira continua valendo
        const good = await loginAdminWithPasskey(server, { ip: '198.51.100.143', authenticator: adminPhone });
        assert.equal(good.result.res.statusCode, 200);
    } finally {
        server.close();
    }
});

test('changing the admin secret automatically invalidates admin biometrics', opts, async () => {
    db.prepare('DELETE FROM webauthn_admin_credentials').run();
    const server = http.createServer(app).listen(0);
    try {
        const phone = new FakeAuthenticator();
        const session = await adminSession(server, '198.51.100.150');
        await registerAdminDevice(server, { ...session, ip: '198.51.100.150', authenticator: phone });
        assert.equal((await loginAdminWithPasskey(server, { ip: '198.51.100.151', authenticator: phone })).result.res.statusCode, 200);

        // Simula a troca de ADMIN_PASSWORD/ADMIN_COOKIE_SECRET: a impressão digital gravada deixa de bater
        db.prepare("UPDATE webauthn_admin_credentials SET fingerprint = 'segredo-antigo'").run();

        const afterRotation = await loginAdminWithPasskey(server, { ip: '198.51.100.152', authenticator: phone });
        assert.equal(afterRotation.result.res.statusCode, 401);

        const listed = await request(server, 'GET', '/admin/webauthn/credentials', { headers: { Cookie: session.cookie } });
        assert.equal(listed.body.credentials.length, 0);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM webauthn_admin_credentials').get().n, 0);
    } finally {
        server.close();
    }
});

test('admin can remove devices and is limited to 5', opts, async () => {
    db.prepare('DELETE FROM webauthn_admin_credentials').run();
    const server = http.createServer(app).listen(0);
    try {
        const session = await adminSession(server, '198.51.100.160');
        const firstPhone = new FakeAuthenticator();
        const first = await registerAdminDevice(server, { ...session, ip: '198.51.100.160', authenticator: firstPhone });
        const firstId = first.body.credentials[0].id;

        for (let i = 0; i < 4; i += 1) {
            const more = await registerAdminDevice(server, { ...session, ip: `198.51.100.${161 + i}`, authenticator: new FakeAuthenticator() });
            assert.equal(more.res.statusCode, 200);
        }
        const sixth = await request(server, 'POST', '/admin/webauthn/register/options', {
            json: {}, headers: { Cookie: session.cookie, 'X-CSRF-Token': session.csrf, 'X-Forwarded-For': '198.51.100.170' },
        });
        assert.equal(sixth.res.statusCode, 400);
        assert.match(sixth.body.message, /Limite/);

        const removed = await request(server, 'POST', `/admin/webauthn/credentials/${firstId}/delete`, {
            json: {}, headers: { Cookie: session.cookie, 'X-CSRF-Token': session.csrf, 'X-Forwarded-For': '198.51.100.171' },
        });
        assert.equal(removed.res.statusCode, 200);
        assert.equal(removed.body.credentials.length, 4);
        assert.equal((await loginAdminWithPasskey(server, { ip: '198.51.100.172', authenticator: firstPhone })).result.res.statusCode, 401);
    } finally {
        server.close();
    }
});

test('admin login and panel pages only offer biometrics when enabled', opts, async () => {
    const server = http.createServer(app).listen(0);
    try {
        const login = await request(server, 'GET', '/admin/login', { headers: { Accept: 'text/html' } });
        assert.equal(login.res.statusCode, 200);
        assert.match(login.text, /id="adminBioPanel"[^>]*display:none/);
        assert.match(login.text, /\/webauthn\.js/);

        const panel = await adminSession(server, '198.51.100.180');
        assert.match(panel.page.text, /id="adminBioLink"[^>]*display:none/);
        assert.match(panel.page.text, /id="adminBioModal"/);
    } finally {
        server.close();
    }
});
