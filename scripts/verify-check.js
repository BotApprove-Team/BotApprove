#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

if (!process.env.DATABASE_PATH) {
  console.error('Refusing to run against the default database. Set DATABASE_PATH.');
  process.exit(1);
}
const SECRET = 'shared-test-secret';
process.env.RAIDPROTECTOR_TOKEN = SECRET;

// A stand-in for RaidProtector's API, recording what it was asked.
const asked = [];
const rp = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    asked.push({ auth: req.headers.authorization, path: req.url, body: JSON.parse(raw || '{}') });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, guildName: 'test server' }));
  });
});
await new Promise((resolve) => rp.listen(0, '127.0.0.1', resolve));
process.env.RAIDPROTECTOR_URL = `http://127.0.0.1:${rp.address().port}`;

const { config } = await import('../src/config.js');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(config.db.path + suffix, { force: true });
fs.mkdirSync(path.dirname(config.db.path), { recursive: true });

const link = await import('../src/services/verifyLink.js');
const { createApp } = await import('../src/web/server.js');
const { db } = await import('../src/db/index.js');

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}`
    + (ok ? '' : `\n         expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`));
};

const G = '100000000000000001';
const U = '200000000000000001';
const NOW = 1_800_000_000_000;

// Built the way RaidProtector's verify.sign() builds it. The finished example
// below is also in RaidProtector's verify-check.js.
const sign = ({ guildId, userId, expires }) => {
  const body = Buffer.from(JSON.stringify({ g: guildId, u: userId, e: expires })).toString('base64url');
  const key = crypto.createHash('sha256').update(`rp-verify-link:${SECRET}`).digest();
  return `${body}.${crypto.createHmac('sha256', key).update(body).digest('base64url')}`;
};
const GOLDEN = 'eyJnIjoiMTAwMDAwMDAwMDAwMDAwMDAxIiwidSI6IjIwMDAwMDAwMDAwMDAwMDAwMSIsImUiOjE4MDAwMDAwMDAwMDB9.'
  + 'brZGPuIDKMsdyUlE9-ueD6L06F6CakiISLQKPtdhXVE';

console.log('\n- reading the link RaidProtector hands out -');
check('the example both repos hold is built the same way here', sign({ guildId: G, userId: U, expires: NOW }), GOLDEN);
const opened = link.openLink(GOLDEN, { now: NOW - 1 });
check('it opens', [opened.ok, opened.guildId, opened.userId], [true, G, U]);
check('not once expired', link.openLink(GOLDEN, { now: NOW + 1 }).reason, 'expired');
check('not with another secret', link.openLink(GOLDEN, { now: NOW - 1, key: 'other' }).reason, 'bad_token');
check('not when half of it is missing', link.openLink(GOLDEN.split('.')[0], { now: NOW - 1 }).reason, 'bad_token');

console.log('\n- the proof of work -');
const solve = (c) => {
  for (let n = 0; n <= c.maxnumber; n += 1) {
    if (crypto.createHash('sha256').update(c.salt + n).digest('hex') === c.challenge) return n;
  }
  return -1;
};
const token = sign({ guildId: G, userId: U, expires: Date.now() + 60_000 });
const other = sign({ guildId: G, userId: '200000000000000002', expires: Date.now() + 60_000 });
const c = link.challenge(token);
const n = solve(c);
check('a challenge can be solved', n >= 0, true);
check('the right answer passes', link.checkWork(token, { ...c, number: n }).ok, true);
check('a wrong answer does not', link.checkWork(token, { ...c, number: (n + 1) % c.maxnumber }).reason, 'wrong_answer');
check('work done for one link does not count for another', link.checkWork(other, { ...c, number: n }).reason, 'other_link');
check('a challenge someone wrote themselves is refused', link.checkWork(token, {
  ...c, challenge: crypto.createHash('sha256').update(`${c.salt}0`).digest('hex'), number: 0,
}).reason, 'forged');
check('an old one is refused', link.checkWork(token, { ...c, number: n }, { now: Date.now() + 11 * 60_000 }).reason, 'expired');
check('a number out of range is refused', link.checkWork(token, { ...c, number: -1 }).reason, 'malformed');

console.log('\n- the page and its two requests -');
const app = createApp();
const web = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const base = `http://127.0.0.1:${web.address().port}`;
const post = async (url, body) => {
  const res = await fetch(base + url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, cookie: res.headers.get('set-cookie'), json: await res.json().catch(() => null) };
};

const page = await fetch(`${base}/verify`);
const html = await page.text();
check('the page loads', page.status, 200);
check('and sets no cookie', page.headers.get('set-cookie'), null);
check('and stays out of search', page.headers.get('x-robots-tag'), 'noindex, nofollow');
check('it says it never asks for a login', html.includes('never asks you to log in'), true);
check('it loads its script from this site only', html.includes('src="/static/verify.js'), true);

const sessionsBefore = db.prepare('SELECT COUNT(*) n FROM web_sessions').get().n;
const issued = await post('/verify/challenge', { token });
check('a good link gets a challenge', [issued.status, issued.json?.ok], [200, true]);
check('without a cookie', issued.cookie, null);
check('a bad link gets none', (await post('/verify/challenge', { token: 'nope.nope' })).status, 400);

const wrong = await post('/verify/solve', { token, ...issued.json.challenge, number: -1 });
check('a wrong answer is not passed on', [wrong.status, asked.length], [400, 0]);
const right = await post('/verify/solve', { token, ...issued.json.challenge, number: solve(issued.json.challenge) });
check('the right answer is passed on', right.json, { ok: true, server: 'test server' });
check('with the shared token and the link', [asked[0]?.auth, asked[0]?.path, asked[0]?.body.token],
  [`Bearer ${SECRET}`, '/v1/verify', token]);
check('and no cookie or session along the way', [right.cookie,
  db.prepare('SELECT COUNT(*) n FROM web_sessions').get().n - sessionsBefore], [null, 0]);
check('solved work cannot be reused for another account',
  (await post('/verify/solve', { token: other, ...issued.json.challenge, number: solve(issued.json.challenge) })).status, 400);
check('a form post to it is not mistaken for the dashboard', (await fetch(`${base}/verify/solve`, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'token=x',
})).status, 400);

web.closeAllConnections();
await new Promise((resolve) => web.close(resolve));
rp.closeAllConnections();
await new Promise((resolve) => rp.close(resolve));

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exitCode = failures ? 1 : 0;
