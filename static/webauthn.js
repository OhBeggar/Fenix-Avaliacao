/*
 * Login por biometria (WebAuthn / passkeys) — lado do navegador.
 * Sem dependências. Expõe window.AvaliWebAuthn (professores) e window.AvaliWebAuthn.admin (painel).
 */
(function () {
    'use strict';

    var LEGACY_FLAG_KEY = 'avaliPasskey';

    function b64urlToBuffer(value) {
        var base64 = String(value).replace(/-/g, '+').replace(/_/g, '/');
        var pad = base64.length % 4 ? '='.repeat(4 - (base64.length % 4)) : '';
        var binary = atob(base64 + pad);
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        return bytes.buffer;
    }

    function bufferToB64url(buffer) {
        var bytes = new Uint8Array(buffer);
        var binary = '';
        for (var i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
        return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    // O navegador precisa suportar WebAuthn, estar em HTTPS (ou localhost)
    // e o endereço precisa ser o do domínio configurado no servidor (rpID).
    function isUsableHere(rpID) {
        if (!window.PublicKeyCredential || !navigator.credentials || !window.isSecureContext) return false;
        if (!rpID) return false;
        var host = location.hostname;
        return host === rpID || host.endsWith('.' + rpID);
    }

    // Sinalizador da versão anterior (um só para o aparelho todo). Hoje é só limpado.
    function clearLegacyFlag() {
        try { localStorage.removeItem(LEGACY_FLAG_KEY); } catch (e) { /* ignore */ }
    }

    // --- Armazenamento local: quem tem biometria NESTE aparelho ---
    var NAMES_KEY = 'avaliPasskeyNames';
    var ASK_PREFIX = 'avaliPasskeyAsk:';
    var ADMIN_ID_KEY = 'avaliAdminCredId';
    var ADMIN_ASK_KEY = 'avaliAdminPasskeyAsk';
    var SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

    function storageGet(key) {
        try { return localStorage.getItem(key); } catch (e) { return null; }
    }

    function storageSet(key, value) {
        try { localStorage.setItem(key, value); } catch (e) { /* ignore */ }
    }

    function storageRemove(key) {
        try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
    }

    function askAllowed(key) {
        var value = storageGet(key);
        if (value === 'never') return false;
        if (value && Date.now() < Number(value)) return false;
        return true;
    }

    // Professores: a lista de nomes com biometria neste aparelho
    function normalizeName(name) {
        return String(name || '').trim().toLowerCase();
    }

    function readNames() {
        try {
            var value = JSON.parse(storageGet(NAMES_KEY) || '[]');
            return Array.isArray(value) ? value : [];
        } catch (e) { return []; }
    }

    function writeNames(list) {
        storageSet(NAMES_KEY, JSON.stringify(list.slice(0, 20)));
    }

    function hasName(name) {
        var normalized = normalizeName(name);
        return Boolean(normalized) && readNames().indexOf(normalized) !== -1;
    }

    function addName(name) {
        var normalized = normalizeName(name);
        if (!normalized) return;
        var list = readNames();
        if (list.indexOf(normalized) === -1) {
            list.push(normalized);
            writeNames(list);
        }
        storageRemove(ASK_PREFIX + normalized);
    }

    function removeName(name) {
        var normalized = normalizeName(name);
        writeNames(readNames().filter(function (item) { return item !== normalized; }));
    }

    function shouldAsk(name) { return askAllowed(ASK_PREFIX + normalizeName(name)); }
    function snoozeAsk(name) { storageSet(ASK_PREFIX + normalizeName(name), String(Date.now() + SNOOZE_MS)); }
    function neverAsk(name) { storageSet(ASK_PREFIX + normalizeName(name), 'never'); }

    // --- Rede ---
    function postJson(url, body, csrfToken) {
        var headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
        if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
        return fetch(url, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(body || {}),
            credentials: 'same-origin',
        }).then(function (response) {
            return response.json().catch(function () { return {}; }).then(function (data) {
                if (!response.ok || data.ok === false) {
                    var error = new Error(data.message || 'Não foi possível concluir. Tente de novo.');
                    error.serverSide = true;
                    error.status = response.status;
                    throw error;
                }
                return data;
            });
        });
    }

    function friendlyError(error) {
        if (!error) return 'Não foi possível concluir.';
        if (error.serverSide) return error.message;
        if (error.name === 'NotAllowedError' || error.name === 'AbortError') {
            return 'Operação cancelada ou expirada. Tente de novo.';
        }
        if (error.name === 'InvalidStateError') return 'Este aparelho já está cadastrado.';
        if (error.name === 'NotSupportedError') return 'Este aparelho não oferece biometria compatível.';
        if (error.name === 'SecurityError') return 'Use o endereço oficial do sistema (https).';
        return 'Não foi possível concluir. Tente de novo.';
    }

    function guessDeviceLabel() {
        var ua = navigator.userAgent || '';
        if (/iPhone/i.test(ua)) return 'iPhone';
        if (/iPad/i.test(ua)) return 'iPad';
        if (/Android/i.test(ua)) return 'Celular Android';
        if (/Windows/i.test(ua)) return 'Computador Windows';
        if (/Mac/i.test(ua)) return 'Mac';
        if (/Linux/i.test(ua)) return 'Computador Linux';
        return 'Meu aparelho';
    }

    function listDevices(base) {
        return fetch(base + '/credentials', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
            .then(function (response) { return response.json(); })
            .then(function (data) {
                if (!data.ok) throw new Error(data.message || 'Não foi possível carregar.');
                return data;
            });
    }

    function removeDevice(base, id, csrfToken) {
        return postJson(base + '/credentials/' + encodeURIComponent(id) + '/delete', {}, csrfToken)
            .then(function (data) { return data.credentials; });
    }

    // --- Cadastro de um aparelho (já logado). base = '/webauthn' ou '/admin/webauthn' ---
    function createCredential(base, csrfToken, label) {
        var credentialId = null;

        return postJson(base + '/register/options', {}, csrfToken).then(function (data) {
            var opts = data.options;
            var publicKey = {
                rp: opts.rp,
                challenge: b64urlToBuffer(opts.challenge),
                user: {
                    id: b64urlToBuffer(opts.user.id),
                    name: opts.user.name,
                    displayName: opts.user.displayName,
                },
                pubKeyCredParams: opts.pubKeyCredParams,
                timeout: opts.timeout,
                attestation: opts.attestation,
                authenticatorSelection: opts.authenticatorSelection,
                excludeCredentials: (opts.excludeCredentials || []).map(function (item) {
                    return { id: b64urlToBuffer(item.id), type: 'public-key', transports: item.transports };
                }),
            };

            return navigator.credentials.create({ publicKey: publicKey });
        }).then(function (credential) {
            if (!credential) throw new Error('Operação cancelada.');
            credentialId = credential.id;
            var response = credential.response;
            var payload = {
                id: credential.id,
                rawId: bufferToB64url(credential.rawId),
                type: credential.type,
                clientExtensionResults: credential.getClientExtensionResults ? credential.getClientExtensionResults() : {},
                authenticatorAttachment: credential.authenticatorAttachment || undefined,
                response: {
                    clientDataJSON: bufferToB64url(response.clientDataJSON),
                    attestationObject: bufferToB64url(response.attestationObject),
                    transports: response.getTransports ? response.getTransports() : [],
                },
            };
            return postJson(base + '/register/verify', { credential: payload, label: label || guessDeviceLabel() }, csrfToken);
        }).then(function (data) {
            return { credentials: data.credentials, credentialId: credentialId };
        });
    }

    // --- Login com biometria. allowIds (opcional) restringe a chaves conhecidas deste aparelho ---
    function getCredential(base, allowIds) {
        return postJson(base + '/login/options', {}).then(function (data) {
            var opts = data.options;
            var publicKey = {
                challenge: b64urlToBuffer(opts.challenge),
                rpId: opts.rpId,
                timeout: opts.timeout,
                userVerification: opts.userVerification,
                allowCredentials: (allowIds || []).map(function (id) {
                    return { id: b64urlToBuffer(id), type: 'public-key' };
                }),
            };

            return navigator.credentials.get({ publicKey: publicKey }).then(function (credential) {
                if (!credential) throw new Error('Operação cancelada.');
                var response = credential.response;
                var payload = {
                    id: credential.id,
                    rawId: bufferToB64url(credential.rawId),
                    type: credential.type,
                    clientExtensionResults: credential.getClientExtensionResults ? credential.getClientExtensionResults() : {},
                    authenticatorAttachment: credential.authenticatorAttachment || undefined,
                    response: {
                        clientDataJSON: bufferToB64url(response.clientDataJSON),
                        authenticatorData: bufferToB64url(response.authenticatorData),
                        signature: bufferToB64url(response.signature),
                        userHandle: response.userHandle ? bufferToB64url(response.userHandle) : undefined,
                    },
                };
                return postJson(base + '/login/verify', { challengeId: data.challengeId, credential: payload }).then(function (result) {
                    result.credentialId = credential.id;
                    return result;
                });
            });
        });
    }

    // ===== Professores =====

    function register(csrfToken, label, teacherName) {
        return createCredential('/webauthn', csrfToken, label).then(function (result) {
            if (teacherName) addName(teacherName);
            return result.credentials;
        });
    }

    // Entra com biometria (o aparelho informa quem é o professor). Resolve com a URL de destino.
    function login() {
        return getCredential('/webauthn', []).then(function (result) {
            if (result.name) addName(result.name);
            return result.redirectUrl;
        });
    }

    // ===== Admin (painel) =====

    var admin = {
        // Este aparelho lembra o id da chave do admin: o login só mostra a biometria onde ela foi ativada.
        hasDevice: function () { return Boolean(storageGet(ADMIN_ID_KEY)); },
        forget: function () { storageRemove(ADMIN_ID_KEY); },
        register: function (csrfToken, label) {
            return createCredential('/admin/webauthn', csrfToken, label).then(function (result) {
                if (result.credentialId) storageSet(ADMIN_ID_KEY, result.credentialId);
                storageRemove(ADMIN_ASK_KEY);
                return result.credentials;
            });
        },
        // Pede só a chave do admin deste aparelho (não mostra as chaves dos professores)
        login: function () {
            var id = storageGet(ADMIN_ID_KEY);
            return getCredential('/admin/webauthn', id ? [id] : []).then(function (result) {
                if (result.credentialId) storageSet(ADMIN_ID_KEY, result.credentialId);
                return result.redirectUrl;
            });
        },
        listDevices: function () { return listDevices('/admin/webauthn'); },
        removeDevice: function (id, csrfToken) { return removeDevice('/admin/webauthn', id, csrfToken); },
        shouldAsk: function () { return askAllowed(ADMIN_ASK_KEY); },
        snoozeAsk: function () { storageSet(ADMIN_ASK_KEY, String(Date.now() + SNOOZE_MS)); },
        neverAsk: function () { storageSet(ADMIN_ASK_KEY, 'never'); },
    };

    window.AvaliWebAuthn = {
        isUsableHere: isUsableHere,
        clearLegacyFlag: clearLegacyFlag,
        hasName: hasName,
        addName: addName,
        removeName: removeName,
        shouldAsk: shouldAsk,
        snoozeAsk: snoozeAsk,
        neverAsk: neverAsk,
        register: register,
        login: login,
        listDevices: function () { return listDevices('/webauthn'); },
        removeDevice: function (id, csrfToken) { return removeDevice('/webauthn', id, csrfToken); },
        friendlyError: friendlyError,
        admin: admin,
    };
})();
