'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avali-admin-reset-'));
process.env.EVALUATIONS_DB_PATH = path.join(tempDir, 'admin-reset.db');
process.env.ADMIN_PASSWORD = 'test-admin-password';
process.env.ADMIN_COOKIE_SECRET = 'test-admin-cookie-secret-which-is-long-enough';
process.env.ADMIN_EMAIL = 'admin@example.test';

const app = require('../app');
const service = require('../src/services/evaluation-service');
const { db } = require('../src/db');
const { ADMIN_COOKIE_NAME, setAdminCookie } = require('../src/utils/admin-auth');

function makeServer() {
  const server = http.createServer(app);
  return new Promise(resolve => server.listen(0, () => resolve(server)));
}

function request(server, pathname, { method = 'GET', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      port: server.address().port,
      path: pathname,
      method,
      headers: {
        ...(body ? {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        } : {}),
        ...headers,
      },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function csrfFrom(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match, 'expected a CSRF token in rendered form');
  return match[1];
}

function formBody(values) {
  return new URLSearchParams(values).toString();
}

test('admin reset code is generic, expires, is single-use, and creates a six-hour emergency session', async () => {
  let sentCode = '';
  let sentCount = 0;
  const fakeMailer = async ({ to, nome, codigo }) => {
    assert.equal(to, 'admin@example.test');
    assert.equal(nome, 'Administrador');
    sentCode = codigo;
    sentCount += 1;
  };

  const wrongRequest = await service.requestAdminResetCode('someone@example.test', fakeMailer);
  assert.deepEqual(wrongRequest, { ok: true, sent: false });
  assert.equal(sentCount, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM admin_reset_tokens').get().count, 0);

  let genericCode = '';
  const server = await makeServer();
  try {
    const forgotPage = await request(server, '/admin/forgot');
    const forgotToken = csrfFrom(forgotPage.text);
    const forgotResponse = await request(server, '/admin/forgot', {
      method: 'POST',
      body: formBody({ _csrf: forgotToken, email: 'wrong@example.test' }),
    });
    assert.equal(forgotResponse.status, 200);
    assert.match(forgotResponse.text, /Se o e-mail estiver cadastrado, enviaremos um código válido por 30 minutos\./);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM admin_reset_tokens').get().count, 0);

    const expiredRequest = await service.requestAdminResetCode('ADMIN@example.test', async ({ codigo }) => { genericCode = codigo; });
    assert.equal(expiredRequest.sent, true);
    assert.match(genericCode, /^\d{5}$/);
    db.prepare(`UPDATE admin_reset_tokens SET expires_at = ? WHERE used_at IS NULL`)
      .run(new Date(Date.now() - 1000).toISOString());
    assert.deepEqual(service.consumeAdminResetCode('admin@example.test', genericCode), { ok: false });

    const liveRequest = await service.requestAdminResetCode('admin@example.test', fakeMailer);
    assert.equal(liveRequest.sent, true);
    assert.match(sentCode, /^\d{5}$/);

    const emergencyPage = await request(server, '/admin/emergency-login');
    const emergencyToken = csrfFrom(emergencyPage.text);
    const login = await request(server, '/admin/emergency-login', {
      method: 'POST',
      body: formBody({ _csrf: emergencyToken, email: 'admin@example.test', code: sentCode }),
    });
    assert.equal(login.status, 302);
    assert.equal(login.headers.location, '/admin');

    const cookie = login.headers['set-cookie'][0].split(';')[0];
    const maxAge = Number(login.headers['set-cookie'][0].match(/Max-Age=(\d+)/)?.[1]);
    assert.ok(maxAge > 0 && maxAge <= 6 * 60 * 60);

    const dashboard = await request(server, '/admin', { headers: { Cookie: cookie } });
    assert.equal(dashboard.status, 200);
    assert.match(dashboard.text, /Sessão de emergência/);

    const replayPage = await request(server, '/admin/emergency-login');
    const replayToken = csrfFrom(replayPage.text);
    const replay = await request(server, '/admin/emergency-login', {
      method: 'POST',
      body: formBody({ _csrf: replayToken, email: 'admin@example.test', code: sentCode }),
    });
    assert.equal(replay.status, 401);
    assert.match(replay.text, /inválido ou expirado/);

    const logoutPage = await request(server, '/admin', { headers: { Cookie: cookie } });
    const logoutToken = csrfFrom(logoutPage.text);
    const logout = await request(server, '/admin/logout', {
      method: 'POST',
      headers: { Cookie: cookie },
      body: formBody({ _csrf: logoutToken }),
    });
    assert.equal(logout.status, 302);
    assert.match(logout.headers['set-cookie'][0], /Max-Age=0/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('expired emergency admin cookie is rejected by protected routes', async () => {
  const server = await makeServer();
  try {
    const responseStub = {
      headers: {},
      setHeader(name, value) { this.headers[name] = value; },
    };
    setAdminCookie(responseStub, false, {
      adminAuthMode: 'emergency',
      adminEmergencyUntil: Date.now() - 1000,
    });
    const cookie = responseStub.headers['Set-Cookie'].split(';')[0];
    assert.ok(cookie.startsWith(`${ADMIN_COOKIE_NAME}=`));

    const protectedPage = await request(server, '/admin', { headers: { Cookie: cookie } });
    assert.equal(protectedPage.status, 302);
    assert.equal(protectedPage.headers.location, '/admin/login?erro=sessao_expirada');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
