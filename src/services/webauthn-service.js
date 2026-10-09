'use strict';

// Login por biometria (WebAuthn / passkeys).
//
// O celular guarda a chave privada e libera o uso com digital/rosto/PIN do aparelho.
// O servidor guarda só a chave pública e confere a assinatura.
// A biblioteca @simplewebauthn/server é carregada de forma tardia: se o pacote ainda não
// foi instalado (npm install), o app continua funcionando e a biometria fica desligada.

const crypto = require('crypto');
const config = require('../config');
const { db } = require('../db');
const { deriveKey, cleanText } = require('../utils/security');
const evaluationService = require('./evaluation-service');

let lib = null;
try {
    lib = require('@simplewebauthn/server');
} catch {
    lib = null;
}

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING_CHALLENGES = 2000;
const MAX_CREDENTIALS_PER_TEACHER = 5;

const USER_HANDLE_KEY = deriveKey(
    config.adminCookieValue || config.adminPassword || 'avali-webauthn',
    'webauthn-user'
);

// Desafios em memória (vivem 5 min e valem uma única vez).
const challenges = new Map();

class WebauthnError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.name = 'WebauthnError';
        this.status = status;
    }
}

function isEnabled() {
    return Boolean(lib && config.webauthn.enabled);
}

function publicConfig() {
    return {
        enabled: isEnabled(),
        rpID: isEnabled() ? config.webauthn.rpID : '',
    };
}

function ensureEnabled() {
    if (!isEnabled()) {
        throw new WebauthnError('Login por biometria indisponível neste servidor.', 503);
    }
}

function pruneChallenges() {
    const now = Date.now();
    for (const [key, entry] of challenges) {
        if (entry.expires <= now) challenges.delete(key);
    }
    while (challenges.size >= MAX_PENDING_CHALLENGES) {
        const oldest = challenges.keys().next().value;
        challenges.delete(oldest);
    }
}

function storeChallenge(key, data) {
    pruneChallenges();
    challenges.set(key, { ...data, expires: Date.now() + CHALLENGE_TTL_MS });
}

// Uso único: ler já apaga.
function takeChallenge(key, purpose) {
    const entry = challenges.get(key);
    challenges.delete(key);
    if (!entry || entry.expires <= Date.now() || entry.purpose !== purpose) return null;
    return entry;
}

// Identificador estável do professor para o aparelho (não expõe o id interno).
function userHandleFor(evaluatorId) {
    return crypto.createHmac('sha256', USER_HANDLE_KEY).update(`user:${evaluatorId}`).digest();
}

function parseTransports(value) {
    try {
        const parsed = JSON.parse(value || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

// --- Consultas ---

function listCredentials(evaluatorId) {
    return db.prepare(`SELECT id, credential_id, transports, device_type, backed_up, label, created_at, last_used_at
      FROM webauthn_credentials WHERE evaluator_id = ? ORDER BY id ASC`).all(evaluatorId);
}

function listCredentialsForClient(evaluatorId) {
    return listCredentials(evaluatorId).map((row) => ({
        id: row.id,
        label: row.label,
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at,
        synced: Boolean(row.backed_up),
    }));
}

function countByTeacher() {
    const counts = {};
    db.prepare('SELECT evaluator_id, COUNT(*) AS total FROM webauthn_credentials GROUP BY evaluator_id')
        .all()
        .forEach((row) => {
            counts[row.evaluator_id] = row.total;
        });
    return counts;
}

function deleteCredential(evaluatorId, credentialRowId) {
    const result = db
        .prepare('DELETE FROM webauthn_credentials WHERE id = ? AND evaluator_id = ?')
        .run(Number.parseInt(credentialRowId, 10), evaluatorId);
    return Number(result.changes) > 0;
}

function revokeAll(evaluatorId) {
    const result = db.prepare('DELETE FROM webauthn_credentials WHERE evaluator_id = ?').run(evaluatorId);
    return Number(result.changes);
}

// --- Cadastro de um aparelho (professor já logado) ---

async function beginRegistration(teacher) {
    ensureEnabled();

    const existing = listCredentials(teacher.id);
    if (existing.length >= MAX_CREDENTIALS_PER_TEACHER) {
        throw new WebauthnError(`Limite de ${MAX_CREDENTIALS_PER_TEACHER} aparelhos atingido. Remova um para adicionar outro.`);
    }

    const options = await lib.generateRegistrationOptions({
        rpName: config.webauthn.rpName,
        rpID: config.webauthn.rpID,
        userName: teacher.name,
        userDisplayName: teacher.name,
        userID: userHandleFor(teacher.id),
        attestationType: 'none',
        excludeCredentials: existing.map((row) => ({
            id: row.credential_id,
            transports: parseTransports(row.transports),
        })),
        authenticatorSelection: {
            residentKey: 'required',
            userVerification: 'required',
            authenticatorAttachment: 'platform',
        },
        timeout: 120000,
    });

    storeChallenge(`reg:${teacher.id}`, {
        purpose: 'register',
        challenge: options.challenge,
        evaluatorId: teacher.id,
    });

    return options;
}

async function completeRegistration(teacher, credentialJson, label) {
    ensureEnabled();

    const pending = takeChallenge(`reg:${teacher.id}`, 'register');
    if (!pending) {
        throw new WebauthnError('O pedido expirou. Tente ativar a biometria de novo.');
    }

    if (listCredentials(teacher.id).length >= MAX_CREDENTIALS_PER_TEACHER) {
        throw new WebauthnError(`Limite de ${MAX_CREDENTIALS_PER_TEACHER} aparelhos atingido.`);
    }

    let verification;
    try {
        verification = await lib.verifyRegistrationResponse({
            response: credentialJson,
            expectedChallenge: pending.challenge,
            expectedOrigin: config.webauthn.origins,
            expectedRPID: config.webauthn.rpID,
            requireUserVerification: true,
        });
    } catch {
        throw new WebauthnError('Não foi possível confirmar a biometria deste aparelho.');
    }

    if (!verification.verified || !verification.registrationInfo) {
        throw new WebauthnError('Não foi possível confirmar a biometria deste aparelho.');
    }

    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
    const transports = credential.transports
        || (credentialJson.response && credentialJson.response.transports)
        || [];

    try {
        db.prepare(`INSERT INTO webauthn_credentials
          (evaluator_id, credential_id, public_key, counter, transports, device_type, backed_up, label)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
            teacher.id,
            credential.id,
            Buffer.from(credential.publicKey),
            credential.counter || 0,
            JSON.stringify(transports),
            credentialDeviceType || null,
            credentialBackedUp ? 1 : 0,
            cleanText(label, 60) || 'Meu aparelho'
        );
    } catch {
        throw new WebauthnError('Este aparelho já está cadastrado.');
    }

    return listCredentialsForClient(teacher.id);
}

// --- Login (sem digitar nada; o aparelho informa quem é o professor) ---

async function beginLogin() {
    ensureEnabled();

    const options = await lib.generateAuthenticationOptions({
        rpID: config.webauthn.rpID,
        userVerification: 'required',
        timeout: 120000,
    });

    const challengeId = crypto.randomBytes(18).toString('base64url');
    storeChallenge(`login:${challengeId}`, {
        purpose: 'login',
        challenge: options.challenge,
    });

    return { options, challengeId };
}

// Retorna o professor ({ id, name }) quando a assinatura é válida; lança WebauthnError se não.
async function completeLogin(challengeId, credentialJson) {
    ensureEnabled();

    const fail = () => new WebauthnError('Não foi possível entrar com biometria. Use sua senha.', 401);

    const pending = takeChallenge(`login:${String(challengeId || '')}`, 'login');
    if (!pending) throw fail();

    const credentialId = credentialJson && typeof credentialJson.id === 'string' ? credentialJson.id : '';
    const row = credentialId
        ? db.prepare('SELECT * FROM webauthn_credentials WHERE credential_id = ?').get(credentialId)
        : null;
    if (!row) throw fail();

    const teacher = evaluationService.getTeacherById(row.evaluator_id);
    if (!teacher) throw fail();

    // O aparelho devolve o "userHandle": precisa ser o do dono da chave.
    const userHandle = credentialJson.response && credentialJson.response.userHandle;
    if (userHandle) {
        const expected = userHandleFor(teacher.id).toString('base64url');
        const a = Buffer.from(String(userHandle));
        const b = Buffer.from(expected);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw fail();
    }

    let verification;
    try {
        verification = await lib.verifyAuthenticationResponse({
            response: credentialJson,
            expectedChallenge: pending.challenge,
            expectedOrigin: config.webauthn.origins,
            expectedRPID: config.webauthn.rpID,
            credential: {
                id: row.credential_id,
                publicKey: new Uint8Array(row.public_key),
                counter: Number(row.counter) || 0,
                transports: parseTransports(row.transports),
            },
            requireUserVerification: true,
        });
    } catch {
        throw fail();
    }

    if (!verification.verified) throw fail();

    db.prepare("UPDATE webauthn_credentials SET counter = ?, last_used_at = datetime('now') WHERE id = ?")
        .run(verification.authenticationInfo.newCounter || 0, row.id);

    return teacher;
}

// ============================================================
// Admin (senha única do painel): mesma tecnologia, tabela separada.
// ============================================================

const ADMIN_KEY = deriveKey(
    config.adminCookieValue || config.adminPassword || 'avali-webauthn',
    'webauthn-admin'
);
const ADMIN_USER_HANDLE = crypto.createHmac('sha256', ADMIN_KEY).update('admin-user').digest();

// Impressão digital do segredo do admin. Trocar ADMIN_PASSWORD ou ADMIN_COOKIE_SECRET muda esse valor
// e, com isso, invalida automaticamente todas as biometrias do admin (rotação de credenciais).
function adminFingerprint() {
    return crypto.createHmac('sha256', ADMIN_KEY).update('admin-passkey-fingerprint').digest('hex').slice(0, 32);
}

function purgeStaleAdminCredentials() {
    db.prepare('DELETE FROM webauthn_admin_credentials WHERE fingerprint != ?').run(adminFingerprint());
}

function listAdminCredentials() {
    purgeStaleAdminCredentials();
    return db.prepare(`SELECT id, credential_id, transports, device_type, backed_up, label, created_at, last_used_at
      FROM webauthn_admin_credentials ORDER BY id ASC`).all();
}

function listAdminCredentialsForClient() {
    return listAdminCredentials().map((row) => ({
        id: row.id,
        label: row.label,
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at,
        synced: Boolean(row.backed_up),
    }));
}

function deleteAdminCredential(credentialRowId) {
    const result = db
        .prepare('DELETE FROM webauthn_admin_credentials WHERE id = ?')
        .run(Number.parseInt(credentialRowId, 10));
    return Number(result.changes) > 0;
}

function revokeAllAdmin() {
    return Number(db.prepare('DELETE FROM webauthn_admin_credentials').run().changes);
}

async function beginAdminRegistration() {
    ensureEnabled();

    const existing = listAdminCredentials();
    if (existing.length >= MAX_CREDENTIALS_PER_TEACHER) {
        throw new WebauthnError(`Limite de ${MAX_CREDENTIALS_PER_TEACHER} aparelhos atingido. Remova um para adicionar outro.`);
    }

    const options = await lib.generateRegistrationOptions({
        rpName: config.webauthn.rpName,
        rpID: config.webauthn.rpID,
        userName: 'Administrador',
        userDisplayName: 'Administrador',
        userID: ADMIN_USER_HANDLE,
        attestationType: 'none',
        excludeCredentials: existing.map((row) => ({
            id: row.credential_id,
            transports: parseTransports(row.transports),
        })),
        authenticatorSelection: {
            residentKey: 'required',
            userVerification: 'required',
            authenticatorAttachment: 'platform',
        },
        timeout: 120000,
    });

    storeChallenge('reg:admin', { purpose: 'admin-register', challenge: options.challenge });
    return options;
}

async function completeAdminRegistration(credentialJson, label) {
    ensureEnabled();

    const pending = takeChallenge('reg:admin', 'admin-register');
    if (!pending) {
        throw new WebauthnError('O pedido expirou. Tente ativar a biometria de novo.');
    }
    if (listAdminCredentials().length >= MAX_CREDENTIALS_PER_TEACHER) {
        throw new WebauthnError(`Limite de ${MAX_CREDENTIALS_PER_TEACHER} aparelhos atingido.`);
    }

    let verification;
    try {
        verification = await lib.verifyRegistrationResponse({
            response: credentialJson,
            expectedChallenge: pending.challenge,
            expectedOrigin: config.webauthn.origins,
            expectedRPID: config.webauthn.rpID,
            requireUserVerification: true,
        });
    } catch {
        throw new WebauthnError('Não foi possível confirmar a biometria deste aparelho.');
    }

    if (!verification.verified || !verification.registrationInfo) {
        throw new WebauthnError('Não foi possível confirmar a biometria deste aparelho.');
    }

    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
    const transports = credential.transports
        || (credentialJson.response && credentialJson.response.transports)
        || [];

    try {
        db.prepare(`INSERT INTO webauthn_admin_credentials
          (credential_id, public_key, counter, transports, device_type, backed_up, label, fingerprint)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
            credential.id,
            Buffer.from(credential.publicKey),
            credential.counter || 0,
            JSON.stringify(transports),
            credentialDeviceType || null,
            credentialBackedUp ? 1 : 0,
            cleanText(label, 60) || 'Meu aparelho',
            adminFingerprint()
        );
    } catch {
        throw new WebauthnError('Este aparelho já está cadastrado.');
    }

    return listAdminCredentialsForClient();
}

async function beginAdminLogin() {
    ensureEnabled();

    const options = await lib.generateAuthenticationOptions({
        rpID: config.webauthn.rpID,
        userVerification: 'required',
        timeout: 120000,
    });

    const challengeId = crypto.randomBytes(18).toString('base64url');
    storeChallenge(`admin-login:${challengeId}`, { purpose: 'admin-login', challenge: options.challenge });
    return { options, challengeId };
}

// Lança WebauthnError(401) se a assinatura não for válida; retorna true se for.
async function completeAdminLogin(challengeId, credentialJson) {
    ensureEnabled();

    const fail = () => new WebauthnError('Não foi possível entrar com biometria. Use a senha.', 401);

    const pending = takeChallenge(`admin-login:${String(challengeId || '')}`, 'admin-login');
    if (!pending) throw fail();

    const credentialId = credentialJson && typeof credentialJson.id === 'string' ? credentialJson.id : '';
    const row = credentialId
        ? db.prepare('SELECT * FROM webauthn_admin_credentials WHERE credential_id = ? AND fingerprint = ?')
            .get(credentialId, adminFingerprint())
        : null;
    if (!row) throw fail();

    const userHandle = credentialJson.response && credentialJson.response.userHandle;
    if (userHandle) {
        const expected = ADMIN_USER_HANDLE.toString('base64url');
        const a = Buffer.from(String(userHandle));
        const b = Buffer.from(expected);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw fail();
    }

    let verification;
    try {
        verification = await lib.verifyAuthenticationResponse({
            response: credentialJson,
            expectedChallenge: pending.challenge,
            expectedOrigin: config.webauthn.origins,
            expectedRPID: config.webauthn.rpID,
            credential: {
                id: row.credential_id,
                publicKey: new Uint8Array(row.public_key),
                counter: Number(row.counter) || 0,
                transports: parseTransports(row.transports),
            },
            requireUserVerification: true,
        });
    } catch {
        throw fail();
    }

    if (!verification.verified) throw fail();

    db.prepare("UPDATE webauthn_admin_credentials SET counter = ?, last_used_at = datetime('now') WHERE id = ?")
        .run(verification.authenticationInfo.newCounter || 0, row.id);

    return true;
}

module.exports = {
    listAdminCredentialsForClient,
    beginAdminRegistration,
    completeAdminRegistration,
    beginAdminLogin,
    completeAdminLogin,
    deleteAdminCredential,
    revokeAllAdmin,
    WebauthnError,
    MAX_CREDENTIALS_PER_TEACHER,
    isEnabled,
    publicConfig,
    countByTeacher,
    listCredentialsForClient,
    deleteCredential,
    revokeAll,
    beginRegistration,
    completeRegistration,
    beginLogin,
    completeLogin,
};
