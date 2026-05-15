const config = require('../config');

const ADMIN_COOKIE_NAME = config.adminCookieName;

function parseCookies(req) {
    const rawCookie = req.headers.cookie || '';

    return rawCookie
        .split(';')
        .map((item) => item.trim())
        .filter(Boolean)
        .reduce((acc, item) => {
            const separatorIndex = item.indexOf('=');

            if (separatorIndex === -1) {
                return acc;
            }

            const key = item.slice(0, separatorIndex);
            const value = item.slice(separatorIndex + 1);
            acc[key] = decodeURIComponent(value);
            return acc;
        }, {});
}

function isAdminAuthenticated(req) {
    if (!config.adminPassword) {
        return false;
    }

    const cookies = parseCookies(req);
    return cookies[ADMIN_COOKIE_NAME] === config.adminCookieValue;
}

function setAdminCookie(res) {
    const maxAge = 1000 * 60 * 60 * 8;
    res.setHeader(
        'Set-Cookie',
        `${ADMIN_COOKIE_NAME}=${encodeURIComponent(config.adminCookieValue)}; HttpOnly; Path=/; Max-Age=${maxAge / 1000}; SameSite=Lax`
    );
}

function clearAdminCookie(res) {
    res.setHeader(
        'Set-Cookie',
        `${ADMIN_COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`
    );
}

module.exports = {
    ADMIN_COOKIE_NAME,
    isAdminAuthenticated,
    setAdminCookie,
    clearAdminCookie,
};
