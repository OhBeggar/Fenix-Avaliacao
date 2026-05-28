(function () {
    'use strict';

    const storageKey = 'fenix-theme';
    const root = document.documentElement;
    const media = window.matchMedia('(prefers-color-scheme: dark)');

    function storedTheme() {
        try {
            return localStorage.getItem(storageKey);
        } catch {
            return null;
        }
    }

    function preferredTheme() {
        const saved = storedTheme();
        if (saved === 'dark' || saved === 'light') return saved;
        return media.matches ? 'dark' : 'light';
    }

    function applyTheme(theme, persist) {
        root.dataset.theme = theme;
        root.style.colorScheme = theme;

        document.querySelectorAll('[data-theme-toggle]').forEach((button) => {
            const isDark = theme === 'dark';
            button.setAttribute('aria-pressed', isDark ? 'true' : 'false');
            button.setAttribute('aria-label', isDark ? 'Ativar modo claro' : 'Ativar modo escuro');
            const label = button.querySelector('[data-theme-label]');
            if (label) label.textContent = isDark ? 'Escuro' : 'Claro';
        });

        if (persist) {
            try {
                localStorage.setItem(storageKey, theme);
            } catch {}
        }
    }

    applyTheme(preferredTheme(), false);

    document.addEventListener('DOMContentLoaded', () => {
        applyTheme(preferredTheme(), false);

        document.querySelectorAll('[data-theme-toggle]').forEach((button) => {
            button.addEventListener('click', () => {
                const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
                applyTheme(next, true);
            });
        });
    });

    media.addEventListener?.('change', () => {
        if (!storedTheme()) applyTheme(preferredTheme(), false);
    });
})();
