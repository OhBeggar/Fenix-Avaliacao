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
