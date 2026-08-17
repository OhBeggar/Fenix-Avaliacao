(function () {
  const KEY = 'fenix-theme';

  function getPreferred() {
    try {
      const saved = localStorage.getItem(KEY);
      if (saved === 'light' || saved === 'dark') return saved;
    } catch (e) {}
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'dark';
    }
    return 'light';
  }

  function apply(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem(KEY, theme); } catch (e) {}

    document.querySelectorAll('.theme-switch-input').forEach(function (input) {
      input.checked = theme === 'dark';
    });
  }

  // Aplica imediatamente
  apply(getPreferred());

  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('.theme-switch-input').forEach(function (input) {
      input.checked = document.documentElement.getAttribute('data-theme') === 'dark';
      input.addEventListener('change', function () {
        apply(this.checked ? 'dark' : 'light');
      });
    });
  });
})();
