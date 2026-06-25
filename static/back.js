// back.js
// Centraliza comportamento dos botões "Voltar" (classe `nav-action back`).
// Ao clicar, navega para o destino explícito do link em vez de percorrer o histórico.
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

        const destination = el.dataset && el.dataset.backFallback ? el.dataset.backFallback : (el.getAttribute('href') || '/');

        try {
            window.location.href = destination;
        } catch (err) {
            window.location.href = destination;
        }
    }, false);
})();
