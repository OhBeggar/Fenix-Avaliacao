'use strict';

// Limitadores em memória (sem dependências externas).
// Suficiente para uma instância única (PM2 em modo fork), que é o caso do projeto.

const sweepables = new Set();
let sweepTimer = null;

function registerForSweep(target) {
    sweepables.add(target);
    if (sweepTimer) return;

    sweepTimer = setInterval(() => {
        sweepables.forEach((item) => item.sweep());
    }, 5 * 60 * 1000);
    if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
}

/**
 * Conta tentativas FALHAS por chave. Ao atingir o limite dentro da janela,
 * a chave fica bloqueada por `lockMs`.
 */
class AttemptTracker {
    constructor({ maxAttempts = 5, windowMs = 15 * 60 * 1000, lockMs = 15 * 60 * 1000 } = {}) {
        this.maxAttempts = maxAttempts;
        this.windowMs = windowMs;
        this.lockMs = lockMs;
        this.entries = new Map();
        registerForSweep(this);
    }

    // Retorna quantos ms faltam para o desbloqueio (0 = livre).
    lockedFor(key) {
        const entry = this.entries.get(key);
        if (!entry || !entry.lockedUntil) return 0;

        const remaining = entry.lockedUntil - Date.now();
        if (remaining > 0) return remaining;

        this.entries.delete(key);
        return 0;
    }

    fail(key) {
        const now = Date.now();
        let entry = this.entries.get(key);

        if (!entry || (!entry.lockedUntil && now - entry.first > this.windowMs)) {
            entry = { count: 0, first: now, lockedUntil: 0 };
        }

        entry.count += 1;
        if (entry.count >= this.maxAttempts) {
            entry.lockedUntil = now + this.lockMs;
            entry.count = 0;
            entry.first = now;
        }

        this.entries.set(key, entry);
        return this.lockedFor(key);
    }

    clear(key) {
        this.entries.delete(key);
    }

    sweep() {
        const now = Date.now();
        for (const [key, entry] of this.entries) {
            const lockExpired = entry.lockedUntil && entry.lockedUntil <= now;
            const windowExpired = !entry.lockedUntil && now - entry.first > this.windowMs;
            if (lockExpired || windowExpired) this.entries.delete(key);
        }
    }
}

// pares = [[tracker, chave], ...]
function lockedForAny(pairs) {
    return pairs.reduce((max, [tracker, key]) => Math.max(max, tracker.lockedFor(key)), 0);
}

function failAll(pairs) {
    pairs.forEach(([tracker, key]) => tracker.fail(key));
}

function clearAll(pairs) {
    pairs.forEach(([tracker, key]) => tracker.clear(key));
}

function formatWait(ms) {
    const minutes = Math.max(1, Math.ceil(ms / 60000));
    return minutes === 1 ? '1 minuto' : `${minutes} minutos`;
}

function tooManyAttemptsMessage(ms) {
    return `Muitas tentativas. Aguarde ${formatWait(ms)} e tente novamente.`;
}

/**
 * Limite geral de requisições por chave (padrão: IP) numa janela fixa.
 */
function requestLimiter({
    windowMs = 60 * 1000,
    max = 120,
    keyFn = (req) => String(req.ip || 'unknown'),
    message = 'Muitas requisições. Aguarde um instante e tente novamente.',
} = {}) {
    const hits = new Map();

    registerForSweep({
        sweep() {
            const now = Date.now();
            for (const [key, entry] of hits) {
                if (now >= entry.reset) hits.delete(key);
            }
        },
    });

    return function limiter(req, res, next) {
        const key = keyFn(req);
        const now = Date.now();
        let entry = hits.get(key);

        if (!entry || now >= entry.reset) {
            entry = { count: 0, reset: now + windowMs };
            hits.set(key, entry);
        }

        entry.count += 1;
        if (entry.count <= max) return next();

        res.setHeader('Retry-After', String(Math.max(1, Math.ceil((entry.reset - now) / 1000))));

        const wantsJson = req.is('application/json')
            || (req.accepts(['html', 'json']) === 'json');
        if (wantsJson) {
            return res.status(429).json({ ok: false, success: false, exists: false, message });
        }
        return res.status(429).send(message);
    };
}

module.exports = {
    AttemptTracker,
    lockedForAny,
    failAll,
    clearAll,
    formatWait,
    tooManyAttemptsMessage,
    requestLimiter,
};
