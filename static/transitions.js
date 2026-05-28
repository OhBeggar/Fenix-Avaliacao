// Page Transitions System v2 - Clean
(function () {
  'use strict';

  document.addEventListener('DOMContentLoaded', () => {
    document.body.classList.add('page-loaded');
  });

  window.addEventListener('beforeunload', () => {
    document.body.classList.remove('page-loaded');
  });
})();
 