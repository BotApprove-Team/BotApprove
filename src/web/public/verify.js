// The checkpoint page. Reads the link's code from after the #, asks for a
// challenge bound to it, finds the answer, and hands it back.
(() => {
  const $ = (id) => document.getElementById(id);
  const label = $('cp-label');
  const fill = $('cp-fill');
  const detail = $('cp-detail');
  const result = $('cp-result');
  const stamp = $('cp-stamp');
  const message = $('cp-message');
  if (!label) return;

  const token = location.hash.slice(1);
  // Out of the address bar, so it is not copied along with a screenshot or a
  // shared link. It is still in memory for the two requests below.
  if (token) history.replaceState(null, '', location.pathname);

  const fmt = new Intl.NumberFormat();
  const setState = (text, kind) => {
    label.textContent = text;
    label.className = `st ${kind}`;
  };

  const finish = (ok, text) => {
    setState(ok ? 'Done' : 'Not finished', ok ? 'ok' : 'danger');
    result.hidden = false;
    message.textContent = text;
    if (ok) {
      stamp.hidden = false;
      if (!matchMedia('(prefers-reduced-motion: reduce)').matches) stamp.classList.add('is-landing');
      fill.style.width = '100%';
    }
  };

  const post = async (url, body) => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'omit',
      });
      return (await res.json()) ?? {};
    } catch {
      return { ok: false, message: 'The site did not answer. Check your connection and reload the page.' };
    }
  };

  const toBytes = (hex) => new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16)));
  const equal = (buf, want) => {
    const got = new Uint8Array(buf);
    for (let i = 0; i < want.length; i += 1) if (got[i] !== want[i]) return false;
    return true;
  };

  async function solve(c) {
    const want = toBytes(c.challenge);
    const enc = new TextEncoder();
    const batch = 2000;
    for (let start = 0; start <= c.maxnumber; start += batch) {
      const end = Math.min(start + batch, c.maxnumber + 1);
      const tries = [];
      for (let n = start; n < end; n += 1) tries.push(crypto.subtle.digest('SHA-256', enc.encode(c.salt + n)));
      const hashes = await Promise.all(tries);
      for (let i = 0; i < hashes.length; i += 1) if (equal(hashes[i], want)) return start + i;
      fill.style.width = `${Math.min(96, (end / c.maxnumber) * 100)}%`;
      detail.textContent = `${fmt.format(end)} of up to ${fmt.format(c.maxnumber)} guesses`;
    }
    return null;
  }

  async function run() {
    if (!token) {
      finish(false, 'Open this from the link RaidProtector gave you in Discord. Press Verify in your server to get one.');
      return;
    }
    if (!window.crypto?.subtle) {
      finish(false, 'This browser cannot run the check. Try another browser, or ask a moderator to let you in.');
      return;
    }

    setState('Getting the check', 'warn');
    const issued = await post('/verify/challenge', { token });
    if (!issued.ok) { finish(false, issued.message); return; }

    setState('Working', 'warn');
    const started = performance.now();
    const number = await solve(issued.challenge);
    if (number === null) { finish(false, 'That did not check out. Reload the page and let it run again.'); return; }
    detail.textContent = `Found after ${fmt.format(number + 1)} guesses in ${((performance.now() - started) / 1000).toFixed(1)}s`;

    setState('Checking', 'warn');
    const done = await post('/verify/solve', { token, ...issued.challenge, number });
    if (!done.ok) { finish(false, done.message); return; }
    finish(true, done.server
      ? `You are in ${done.server}. Go back to Discord, the channels are open to you now.`
      : 'You are in. Go back to Discord, the channels are open to you now.');
  }

  run();
})();
