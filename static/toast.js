// Toast Notification System
(function () {
  'use strict';

  window.showToast = function (message, type = 'success', duration = 3000) {
    const colors = {
      success: '#166534',
      error:   '#b91c1c',
      warning: '#b45309',
      info:    '#1d4ed8',
    };

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      padding: 16px 24px;
      border-radius: var(--radius-sm, 10px);
      color: white;
      font-weight: 600;
      font-family: inherit;
      box-shadow: var(--shadow-lg, 0 8px 28px rgba(0, 0, 0, 0.6));
      z-index: 10000;
      min-width: 280px;
      background: ${colors[type] || colors.info};
    `;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.style.transition = 'opacity 0.25s ease, transform 0.25s ease';
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(-12px) scale(0.96)';
      setTimeout(() => toast.remove(), 260);
    }, duration);
  };
})();
