(function () {
  'use strict';

  var root = document.documentElement;
  var KEY = 'botapprove.theme';
  var darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  var SUN = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" '
    + 'stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/>'
    + '<path d="M12 2.4v2.3M12 19.3v2.3M4.2 4.2l1.7 1.7M18.1 18.1l1.7 1.7M2.4 12h2.3M19.3 12h2.3'
    + 'M4.2 19.8l1.7-1.7M18.1 5.9l1.7-1.7"/></svg>';
  var MOON = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" '
    + 'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M20.5 14.3A8.5 8.5 0 1 1 9.7 3.5a6.9 6.9 0 0 0 10.8 10.8z"/></svg>';

  function icon(id) {
    return '<svg aria-hidden="true"><use href="#' + id + '"></use></svg>';
  }

  function theme() {
    return root.getAttribute('data-theme') || (darkQuery && darkQuery.matches ? 'dark' : 'light');
  }

  function addThemeToggle(tools) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'icon-btn';

    function sync() {
      var dark = theme() === 'dark';
      btn.innerHTML = dark ? SUN : MOON;
      btn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
    }

    btn.addEventListener('click', function () {
      var next = theme() === 'dark' ? 'light' : 'dark';
      // The swap lands in one frame: with transitions running, parts of the
      // page fade to the new palette while the rest has already snapped.
      root.classList.add('theme-switching');
      root.setAttribute('data-theme', next);
      void root.offsetHeight;
      root.classList.remove('theme-switching');
      try { localStorage.setItem(KEY, next); } catch (e) { /* still switches for this visit */ }
      sync();
    });
    if (darkQuery && darkQuery.addEventListener) darkQuery.addEventListener('change', sync);

    sync();
    tools.appendChild(btn);
  }

  function disclosure(btn, panel, cls) {
    function setOpen(open) {
      btn.setAttribute('aria-expanded', String(open));
      panel.classList.toggle(cls, open);
    }
    btn.addEventListener('click', function () {
      setOpen(btn.getAttribute('aria-expanded') !== 'true');
    });
    panel.addEventListener('click', function (e) {
      if (e.target.closest('a')) setOpen(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && panel.classList.contains(cls)) {
        setOpen(false);
        btn.focus();
      }
    });
  }

  function addMenu(tools) {
    var nav = document.getElementById('site-nav');
    if (!nav) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'menu-btn';
    btn.textContent = 'Menu';
    btn.setAttribute('aria-controls', 'site-nav');
    btn.setAttribute('aria-expanded', 'false');
    disclosure(btn, nav, 'is-open');
    tools.appendChild(btn);
    root.classList.add('has-menu');
  }

  // On a phone the server tabs fold into one bar, which still names anything
  // waiting on any tab so a count is never hidden behind the menu.
  function addTabBar() {
    var nav = document.getElementById('tabnav');
    if (!nav) return;

    var current = nav.querySelector('a[aria-current="page"]');
    var summary = document.createElement('p');
    summary.className = 'tabbar-summary';
    var head = document.createElement('b');
    head.textContent = current ? current.getAttribute('data-label') : 'Sections';
    summary.appendChild(head);

    var notes = [];
    if (current && current.hasAttribute('data-urgent')) notes.push(current.getAttribute('data-urgent'));
    nav.querySelectorAll('a[data-urgent]').forEach(function (a) {
      if (a !== current) notes.push(a.getAttribute('data-label') + ': ' + a.getAttribute('data-urgent'));
    });
    if (notes.length) summary.appendChild(document.createTextNode(' · ' + notes.join(' · ')));

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tabbar-btn';
    btn.textContent = 'Tabs';
    btn.setAttribute('aria-controls', 'tabnav');
    btn.setAttribute('aria-expanded', 'false');
    disclosure(btn, nav, 'is-open');

    var bar = document.createElement('div');
    bar.className = 'tabbar';
    bar.appendChild(summary);
    bar.appendChild(btn);
    nav.parentNode.insertBefore(bar, nav);
    root.classList.add('has-tabbar');
  }

  // The example card on the homepage. The visitor plays the approver.
  var DECISIONS = [
    {
      key: 'approve',
      label: 'Approve & whitelist',
      stamp: 'Whitelisted',
      status: 'Approved · whitelisted',
      tone: 'ok',
      icon: 'i-ok',
      text: "Whitelisted. It doesn't come back by itself; someone re-invites it by hand.",
    },
    {
      key: 'deny',
      label: 'Deny',
      stamp: 'Denied',
      status: 'Denied · stays out',
      tone: 'neutral',
      icon: 'i-deny',
      text: 'Denied. It is not whitelisted, and BotApprove DMs whoever added it.',
    },
    {
      key: 'nuke',
      label: 'Deny + confirm nuke bot',
      stamp: 'Kicked on sight',
      status: 'Confirmed nuke bot',
      tone: 'crit',
      icon: 'i-crit',
      text: 'Kicked on sight from now on. Where auto-ban is on, BotApprove bans whoever invited it.',
    },
  ];

  function land(stamp) {
    stamp.hidden = false;
    void stamp.offsetWidth;
    stamp.classList.add('is-landing');
  }

  function addDecisions(card) {
    var figure = card.closest('.exhibit');
    var status = card.querySelector('[data-status]');
    var stamp = card.querySelector('.stamp');
    var controls = figure.querySelector('.ap-controls');
    var outcome = figure.querySelector('.ap-outcome');
    var caption = figure.querySelector('figcaption');
    var start = { className: status.className, html: status.innerHTML };

    var actions = document.createElement('div');
    actions.className = 'ap-actions';
    actions.setAttribute('role', 'group');
    actions.setAttribute('aria-label', 'Decide on this bot');

    var reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'btn btn-quiet';
    reset.textContent = 'Reset the example';
    reset.hidden = true;

    function decide(d) {
      card.setAttribute('data-state', d.key);
      status.className = 'badge ' + d.tone;
      status.innerHTML = icon(d.icon) + '<span>' + d.status + '</span>';
      stamp.className = 'stamp stamp-face' + (d.tone === 'crit' ? ' crit' : '');
      stamp.innerHTML = (d.tone === 'crit' ? icon('i-crit') : '') + '<span>' + d.stamp + '</span>';
      land(stamp);
      outcome.textContent = d.text;
      actions.hidden = true;
      reset.hidden = false;
      reset.focus();
    }

    DECISIONS.forEach(function (d) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn';
      b.textContent = d.label;
      b.addEventListener('click', function () { decide(d); });
      actions.appendChild(b);
    });

    reset.addEventListener('click', function () {
      card.setAttribute('data-state', 'awaiting');
      status.className = start.className;
      status.innerHTML = start.html;
      stamp.hidden = true;
      outcome.textContent = '';
      reset.hidden = true;
      actions.hidden = false;
      actions.querySelector('button').focus();
    });

    controls.insertBefore(actions, outcome);
    controls.appendChild(reset);
    if (caption) caption.appendChild(document.createTextNode(' Pick a decision on the card to see what happens next.'));
    figure.classList.add('demo-ready');
  }

  // The example report on the RaidProtector page: the same incident in report
  // mode, which is the default, and in act mode, where it can be undone.
  var MODES = {
    report: {
      label: 'Report mode (default)',
      title: 'Possible raid, incident #0',
      status: 'Possible raid · report only',
      tone: 'warn',
      icon: 'i-warn',
    },
    act: {
      label: 'Act mode',
      title: 'Raid response, incident #0',
      status: 'Raid response · 14 timed out',
      tone: 'danger',
      icon: 'i-danger',
    },
  };

  function addIncident(card) {
    var figure = card.closest('.exhibit');
    var title = card.querySelector('[data-title]');
    var status = card.querySelector('[data-status]');
    var stamp = card.querySelector('.stamp');
    var controls = figure.querySelector('.ap-controls');
    var outcome = figure.querySelector('.ap-outcome');

    var picker = document.createElement('div');
    picker.className = 'mode-pick';
    var label = document.createElement('span');
    label.className = 'form-label';
    label.id = 'mode-label';
    label.textContent = 'Show it in';
    var seg = document.createElement('div');
    seg.className = 'seg';
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-labelledby', 'mode-label');
    picker.appendChild(label);
    picker.appendChild(seg);

    var undoBtn = document.createElement('button');
    undoBtn.type = 'button';
    undoBtn.className = 'btn';

    var reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'btn btn-quiet';
    reset.textContent = 'Reset the example';
    reset.hidden = true;

    var modeButtons = {};

    function setMode(key) {
      var m = MODES[key];
      card.setAttribute('data-mode', key);
      title.textContent = m.title;
      status.className = 'badge ' + m.tone;
      status.innerHTML = icon(m.icon) + '<span>' + m.status + '</span>';
      Object.keys(modeButtons).forEach(function (k) {
        modeButtons[k].setAttribute('aria-pressed', String(k === key));
      });
      stamp.hidden = true;
      outcome.textContent = '';
      undoBtn.textContent = 'Undo this incident';
      undoBtn.disabled = false;
      undoBtn.hidden = key !== 'act';
      reset.hidden = true;
    }

    // The real button turns into a disabled "Undone", so this one does too.
    undoBtn.addEventListener('click', function () {
      status.className = 'badge ok';
      status.innerHTML = icon('i-ok') + '<span>Undone · timeouts lifted</span>';
      stamp.className = 'stamp stamp-face';
      stamp.innerHTML = '<span>Undone</span>';
      land(stamp);
      undoBtn.textContent = 'Undone';
      undoBtn.disabled = true;
      outcome.textContent = 'All 14 timeouts from this incident are lifted. RaidProtector kept a '
        + 'record of what it changed, so the whole incident reversed in one press.';
      reset.hidden = false;
      reset.focus();
    });

    Object.keys(MODES).forEach(function (key) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = MODES[key].label;
      b.addEventListener('click', function () { setMode(key); });
      modeButtons[key] = b;
      seg.appendChild(b);
    });
    reset.addEventListener('click', function () {
      setMode('act');
      undoBtn.focus();
    });

    figure.insertBefore(picker, card);
    controls.insertBefore(undoBtn, outcome);
    controls.appendChild(reset);
    figure.classList.add('demo-ready');
    setMode('report');
  }

  // The "the documents changed" bar. Shown until dismissed, once per version.
  function legalNotice() {
    var el = document.getElementById('legal-notice');
    if (!el) return;
    var seenKey = 'botapprove.legal-seen';
    var version = el.getAttribute('data-version');
    try {
      if (localStorage.getItem(seenKey) === version) return;
    } catch (e) { /* private mode: show it */ }
    el.hidden = false;
    var close = document.getElementById('legal-notice-close');
    if (!close) return;
    close.addEventListener('click', function () {
      el.hidden = true;
      try { localStorage.setItem(seenKey, version); } catch (e) { /* nothing to do */ }
    });
  }

  // Turning off the external app report is the one setting worth a second
  // thought, because that route is how people spam without inviting a bot.
  function warnOnRisk() {
    document.querySelectorAll('select[data-warn-on]').forEach(function (sel) {
      var risky = sel.getAttribute('data-warn-on');
      var last = sel.value;
      sel.addEventListener('change', function () {
        if (sel.value !== risky) { last = sel.value; return; }
        var ok = window.confirm(
          'Leaving this off means BotApprove will not tell you when someone posts with an app '
          + 'that never joined your server. That is the route people use to spam without '
          + 'inviting a bot. Recommended: keep it on at least Tell me. Turn it off anyway?',
        );
        if (!ok) sel.value = last; else last = sel.value;
      });
    });
  }

  var tools = document.getElementById('head-tools');
  if (tools) {
    addThemeToggle(tools);
    addMenu(tools);
  }
  addTabBar();
  legalNotice();
  warnOnRisk();

  var card = document.querySelector('[data-demo]');
  if (card) addDecisions(card);
  var incident = document.querySelector('[data-incident]');
  if (incident) addIncident(incident);
}());
