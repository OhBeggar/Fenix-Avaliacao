const crypto = require('crypto');

const port = Number.parseInt(process.env.PORT || '5000', 10);
const host = process.env.HOST || '0.0.0.0';
const adminPassword = process.env.ADMIN_PASSWORD || '';
const adminCookieSecret = process.env.ADMIN_COOKIE_SECRET || 'avali-admin-cookie-secret';
const evaluatorOnlineWindowMinutes = Number.parseInt(
    process.env.EVALUATOR_ONLINE_WINDOW_MINUTES || '30',
    10
);
const publicBaseUrl = process.env.PUBLIC_BASE_URL || '';

function hashValue(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

module.exports = {
    port: Number.isNaN(port) ? 5000 : port,
    host,
    publicBaseUrl,
    adminPassword,
    adminCookieName: 'avali_admin',
    adminCookieValue: hashValue(`${adminCookieSecret}:${adminPassword || 'disabled'}`),
    evaluatorOnlineWindowMinutes: Number.isNaN(evaluatorOnlineWindowMinutes)
        ? 30
        : evaluatorOnlineWindowMinutes,
};
