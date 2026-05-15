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
    toast.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      padding: 16px 24px;
      border-radius: 12px;
      color: white;
      font-weight: 600;
      font-family: "Segoe UI", Arial, sans-serif;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
      z-index: 10000;
      min-width: 280px;
      animation: slideInRight 0.4s ease-out;
      background: ${colors[type] || colors.info};
    `;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.style.animation = 'fadeOut 0.3s ease-out forwards';
      setTimeout(() => toast.remove(), 320);
    }, duration);
  };
})();
