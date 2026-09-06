(function () {
  'use strict';

  var KEY = 'botapprove.theme';
  var root = document.documentElement;

  function stored() {
    try {
      var v = localStorage.getItem(KEY);
      return v === 'light' || v === 'dark' ? v : null;
    } catch (e) {
      return null;
    }
  }

  function systemTheme() {
    return window.matchMedia
      && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function current() {
    return root.getAttribute('data-theme') || systemTheme();
  }

  var saved = stored();
  if (saved) root.setAttribute('data-theme', saved);

  // Repaint the whole page on one frame. Without suppressing transitions the
  // elements named in the stylesheet's transition list fade to the new palette
  // while everything else has already snapped to it, and the mismatch is
  // visible for the length of the transition.
  function apply(next) {
    root.classList.add('theme-switching');
    root.setAttribute('data-theme', next);
    void root.offsetHeight;
    root.classList.remove('theme-switching');
  }

  function paintButton(btn) {
    var next = current() === 'dark' ? 'light' : 'dark';
    btn.setAttribute('aria-label', 'Switch to ' + next + ' theme');
    btn.setAttribute('title', 'Switch to ' + next + ' theme');
  }

  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.getElementById('theme-toggle');
    if (!btn) return;

    paintButton(btn);

    btn.addEventListener('click', function () {
      var next = current() === 'dark' ? 'light' : 'dark';
      apply(next);
      try {
        localStorage.setItem(KEY, next);
      } catch (e) {
      }
      paintButton(btn);
    });

    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      var onChange = function () {
        if (!stored()) paintButton(btn);
      };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }
  });
}());
