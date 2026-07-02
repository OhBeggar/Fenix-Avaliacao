const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avali-attendance-routes-'));
process.env.EVALUATIONS_DB_PATH = path.join(tempDir, 'evaluations.db');
process.env.ADMIN_PASSWORD = 'test-admin-password';
process.env.ADMIN_COOKIE_SECRET = 'test-cookie-secret';

const app = require('../app');
const config = require('../src/config');
const service = require('../src/services/evaluation-service');
const { db } = require('../src/db');
const { signAdminPayload } = require('../src/utils/admin-auth');

function postForm(server, pathname, form, cookie = '') {
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
                Cookie: cookie,
            },
        }, (res) => {
            res.resume();
            res.on('end', () => resolve(res));
        });

        req.on('error', reject);
        req.end(body);
    });
}

function getText(server, pathname, cookie = '') {
    const { port } = server.address();

    return new Promise((resolve, reject) => {
        const req = http.request({ port, path: pathname, method: 'GET', headers: { Cookie: cookie } }, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({ res, text: Buffer.concat(chunks).toString('utf8') }));
        });

        req.on('error', reject);
        req.end();
    });
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
    const match = html.match(/input\.value = "([^"]+)"/);
    assert.ok(match, 'admin page should include a CSRF token');
    return match[1];
}

test.after(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

test('rota de admin salva total de aulas e presença de cada aluno', async () => {
    service.addTeacher('Professor QA', 'senha');
    const teacher = service.getTeacherList().find((row) => row.name === 'Professor QA');
    service.createTurma('Turma QA', teacher.id, 'turma-senha');
    const turma = service.getTurmas().find((row) => row.name === 'Turma QA');

    service.createCandidate({ name: 'Aluno Presente', gender: 'male', presence: '0%', status: 'Bolsista', turma_id: turma.id });
    service.createCandidate({ name: 'Aluno Ausente', gender: 'female', presence: '0%', status: 'Bolsista', turma_id: turma.id });

    const candidates = service.getCandidatesByTurma(turma.id);
    const cookie = adminCookie();
    const form = new URLSearchParams();
    form.set('total_aulas', '10');
    form.set(`aulas_${candidates[0].id}`, '9');
    form.set(`aulas_${candidates[1].id}`, '2');

    const server = http.createServer(app).listen(0);

    try {
        const adminPage = await getText(server, `/admin/turma/${turma.id}`, cookie);
        form.set('_csrf', extractCsrfToken(adminPage.text));

        const res = await postForm(server, `/admin/turma/${turma.id}/aulas`, form, cookie);
        assert.equal(res.statusCode, 302);
        assert.ok(res.headers.location.startsWith(`/admin/turma/${turma.id}`));

        const summary = service.getAttendanceSummary(turma.id);
        assert.equal(summary[candidates[0].id].label, '90%');
        assert.equal(summary[candidates[1].id].label, '20%');
    } finally {
        server.close();
    }
});
