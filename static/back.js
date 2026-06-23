// back.js
// Centraliza comportamento dos botões "Voltar" (classe `nav-action back`).
// Ao clicar, tenta usar history.back(); se não houver histórico, usa `href` ou `data-back-fallback`.
(function(){
    'use strict';

    function isModifiedClick(e) {
        return e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;
    }

    document.addEventListener('click', function (e) {
        if (!e.target) return;
        const el = e.target.closest && e.target.closest('.nav-action.back');
        if (!el) return;

        // Allow middle-click / modified clicks and explicit new-tab targets
        if (isModifiedClick(e)) return;
        const targetAttr = el.getAttribute && el.getAttribute('target');
        if (targetAttr && targetAttr.toLowerCase() === '_blank') return;

        e.preventDefault();

        const fallback = el.dataset && el.dataset.backFallback ? el.dataset.backFallback : (el.getAttribute('href') || '/');

        try {
            if (window.history && window.history.length > 1) {
                window.history.back();
                return;
            }

            if (document.referrer) {
                try {
                    const ref = new URL(document.referrer, location.href);
                    if (ref.origin === location.origin) {
                        window.location.href = document.referrer;
                        return;
                    }
                } catch (err) {
                    // fallthrough to fallback
                }
            }

            window.location.href = fallback;
        } catch (err) {
            window.location.href = fallback;
        }
    }, false);
})();
