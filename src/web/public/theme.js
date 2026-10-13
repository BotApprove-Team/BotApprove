// Loaded in <head> before the stylesheet, so a saved theme is in place before
// the first paint and the page never flashes the other one. Everything that
// can wait for the document lives in site.js.
(function () {
  'use strict';
  try {
    var saved = localStorage.getItem('botapprove.theme');
    if (saved === 'light' || saved === 'dark') {
      document.documentElement.setAttribute('data-theme', saved);
    }
  } catch (e) {
    // Storage can be blocked. The page then follows the system setting.
  }
}());
