#!/usr/bin/env node
/**
 * Regressions for three fixes that are easy to undo by accident.
 *
 *   DATABASE_PATH=./data/sec.db node scripts/security-check.js
 *
 * Each one looks like a harmless simplification from the inside: a leading
 * slash looks like enough to keep a redirect local, a session id looks like a
 * reasonable rate-limit key, and passing a downloaded buffer straight to a
 * parser looks like what the parser is for.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

if (!process.env.DATABASE_PATH) {
  console.error('Refusing to run against the default database. Set DATABASE_PATH.');
  process.exit(1);
}

const salt = 'testsalt';
const hash = (p) => `${salt}:${crypto.scryptSync(p, salt, 64).toString('hex')}`;
process.env.ADMIN_PASSWORD_HASH = hash('first-password');
process.env.ADMIN_PASSWORD_HASH_2 = hash('second-password');

const { config } = await import('../src/config.js');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(config.db.path + suffix, { force: true });
fs.mkdirSync(path.dirname(config.db.path), { recursive: true });

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}` +
    (ok ? '' : `\n         expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`));
};

// These two helpers are module-private, so they are lifted out of the source
// rather than exported purely for the sake of a test.
async function lift(file, from, to, name) {
  const src = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
  const start = src.indexOf(from);
  const end = src.indexOf(to);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(`could not lift ${name} from ${file}; has it been renamed?`);
  }
  const tmp = path.join(path.dirname(config.db.path), `lifted-${name}.mjs`);
  fs.writeFileSync(tmp, `${src.slice(start, end)}\nexport { ${name} };\n`);
  return import(pathToFileURL(tmp).href);
}

console.log('\n- login redirects stay on this site -');
const { safeReturnTo } = await lift(
  '../src/web/auth.js', 'function safeReturnTo', "router.get('/login'", 'safeReturnTo',
);

check('a normal path is kept', safeReturnTo('/g/123'), '/g/123');
// A leading slash alone is not enough: a browser reads these as another host.
check('protocol-relative is refused', safeReturnTo('//evil.example.com'), '/guilds');
check('and with a path on it', safeReturnTo('//evil.example.com/phish'), '/guilds');
check('extra slashes do not help', safeReturnTo('////evil.example.com'), '/guilds');
check('nor does a backslash', safeReturnTo('/\\evil.example.com'), '/guilds');
check('an absolute url is refused', safeReturnTo('https://evil.example.com'), '/guilds');
check('so is a bare scheme', safeReturnTo('javascript:alert(1)'), '/guilds');
check('a missing value falls back', safeReturnTo(undefined), '/guilds');

console.log('\n- the unlock limit follows the account, not the session -');
const { attemptUnlock } = await import('../src/web/adminAuth.js');

const req = (sessionID) => ({
  sessionID,
  session: { user: { id: 'operator' } },
  ip: '198.51.100.4',
});

const guesses = [];
for (let round = 1; round <= 3; round += 1) {
  for (let i = 0; i < 5; i += 1) {
    // A new session id every round, which is what an attacker who already holds
    // the Discord account gets for free: signing in again is a silent redirect.
    guesses.push((await attemptUnlock(req(`session-${round}`), `guess-${i}`)).reason);
  }
}
const wrong = guesses.filter((r) => r === 'wrong_password').length;
const locked = guesses.filter((r) => r === 'locked_out').length;

check('only the first few guesses are checked', wrong, 4);
check('every later one is refused', locked, 11);
check('a fresh session does not reset the count', guesses[5], 'locked_out');

console.log('\n- the correct password still works from a clean identity -');
const clean = { sessionID: 's', session: { user: { id: 'other-operator' } }, ip: '198.51.100.9' };
check('first password advances a stage', (await attemptUnlock(clean, 'first-password')).reason, 'stage_two');
check('second password unlocks', (await attemptUnlock(clean, 'second-password')).ok, true);

console.log('\n- only formats Discord serves reach the image parser -');
const { recognised } = await lift(
  '../src/services/imageProbe.js', 'const SIGNATURES', 'export async function probeAsset', 'recognised',
);

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]);

check('png is parsed', recognised(png), 'png');
check('jpeg is parsed', recognised(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'jpg');
check('gif is parsed', recognised(Buffer.from('GIF89a')), 'gif');
check('webp is parsed', recognised(webp), 'webp');

// image-size has open infinite-loop advisories in these three parsers, and it
// chooses a parser from the bytes rather than the extension that was requested.
// A hang here would stop the bot screening at all, so they never get that far.
check('icns is not parsed', recognised(Buffer.from('icns'.padEnd(20, '\0'))), null);
check('heif is not parsed', recognised(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypheic')])), null);
check('jxl is not parsed', recognised(Buffer.from([0xff, 0x0a, 0, 0])), null);
check('an empty buffer is not parsed', recognised(Buffer.alloc(0)), null);

console.log(`\n${failures ? `${failures} check(s) failed` : 'all checks passed'}\n`);
process.exit(failures ? 1 : 0);
