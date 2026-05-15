// Page Transitions System
(function () {
  'use strict';

  document.addEventListener('DOMContentLoaded', () => {
    document.body.classList.add('page-loaded');

    // Smooth transition on internal navigation
    document.querySelectorAll('a[href^="/"]').forEach(link => {
      link.addEventListener('click', () => {
        const href = link.getAttribute('href');
        if (href !== '#' && !href.startsWith('/#')) {
          document.body.classList.add('page-transitioning');
        }
      });
    });
  });

  window.addEventListener('beforeunload', () => {
    document.body.classList.remove('page-loaded');
  });
})();
