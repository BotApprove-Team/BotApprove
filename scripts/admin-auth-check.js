#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

if (!process.env.DATABASE_PATH) {
  console.error('Refusing to run against the default database. Set DATABASE_PATH.');
  process.exit(1);
}

const P1 = 'first-password-here';
const P2 = 'second-password-here';
const hash = (pw) => {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
};
process.env.ADMIN_PASSWORD_HASH = hash(P1);
process.env.ADMIN_PASSWORD_HASH_2 = hash(P2);

const { config } = await import('../src/config.js');
for (const suffix of ['', '-wal', '-shm']) {
  fs.rmSync(config.db.path + suffix, { force: true });
}
fs.mkdirSync(path.dirname(config.db.path), { recursive: true });

const auth = await import('../src/web/adminAuth.js');

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}` +
    (ok ? '' : `\n         expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`));
}

let sessionSeq = 0;
const newReq = () => ({
  sessionID: `sess-${(sessionSeq += 1)}`,
  session: { user: { id: '333333333333333333' } },
  ip: '127.0.0.1',
});

console.log('\n- configuration -');
check('both hashes present means configured', auth.isConfigured(), true);
const saved = config.admin.passwordHash2;
config.admin.passwordHash2 = '';
check('one hash alone is not configured', auth.isConfigured(), false);
const halfConfigured = await auth.attemptUnlock(newReq(), P1);
check('and elevation refuses outright', halfConfigured.reason, 'not_configured');
config.admin.passwordHash2 = saved;

console.log('\n- the happy path -');
const req = newReq();
check('starts at the first password', auth.currentStage(req), 1);
const one = await auth.attemptUnlock(req, P1);
check('first password does not elevate on its own', one.ok, false);
check('it advances to the second', one.reason, 'stage_two');
check('not unlocked yet', auth.isAdminUnlocked(req), false);
check('now asking for the second', auth.currentStage(req), 2);
const two = await auth.attemptUnlock(req, P2);
check('second password elevates', two.ok, true);
check('and the session is unlocked', auth.isAdminUnlocked(req), true);
check('stage state is cleared afterwards', req.session.adminStage1At, undefined);

console.log('\n- one password is never enough -');
const onlyFirst = newReq();
await auth.attemptUnlock(onlyFirst, P1);
check('first password twice does not elevate',
  (await auth.attemptUnlock(onlyFirst, P1)).ok, false);
check('still locked', auth.isAdminUnlocked(onlyFirst), false);

const secondFirst = newReq();
const wrongOrder = await auth.attemptUnlock(secondFirst, P2);
check('the second password will not open the first step', wrongOrder.ok, false);
check('and it is rejected as wrong', wrongOrder.reason, 'wrong_password');
check('order cannot be swapped', auth.currentStage(secondFirst), 1);

console.log('\n- a wrong second password costs the first -');
const grind = newReq();
await auth.attemptUnlock(grind, P1);
check('at the second step', auth.currentStage(grind), 2);
const missed = await auth.attemptUnlock(grind, 'not-it');
check('rejected', missed.ok, false);
check('and says the sequence restarted', missed.restarted, true);
check('back to the first step', auth.currentStage(grind), 1);
check('a second guess is answered by the FIRST password check',
  (await auth.attemptUnlock(grind, P2)).reason, 'wrong_password');

console.log('\n- the lockout is shared across both steps -');
const lock = newReq();
for (let i = 0; i < 4; i += 1) {
  await auth.attemptUnlock(lock, P1);
  await auth.attemptUnlock(lock, 'wrong');
}
check('four failures leave one attempt', (await auth.attemptUnlock(lock, 'wrong')).reason,
  'locked_out');
const afterLockout = await auth.attemptUnlock(lock, P1);
check('the correct password is refused while locked out', afterLockout.reason, 'locked_out');
check('and no elevation was granted', auth.isAdminUnlocked(lock), false);

console.log('\n- expiry -');
const stale = newReq();
await auth.attemptUnlock(stale, P1);
check('second step is live', auth.currentStage(stale), 2);
stale.session.adminStage1At = Date.now() - config.admin.stageTtlMs - 1;
check('a stale first step expires back to the start', auth.currentStage(stale), 1);

const expired = newReq();
await auth.attemptUnlock(expired, P1);
await auth.attemptUnlock(expired, P2);
check('unlocked', auth.isAdminUnlocked(expired), true);
expired.session.adminUnlockedUntil = Date.now() - 1;
check('elevation expires on its own', auth.isAdminUnlocked(expired), false);

const relocked = newReq();
await auth.attemptUnlock(relocked, P1);
await auth.attemptUnlock(relocked, P2);
await auth.lock(relocked);
check('locking clears elevation', auth.isAdminUnlocked(relocked), false);
check('and clears any half-finished sequence', relocked.session.adminStage1At, undefined);

console.log(`\n${failures ? `${failures} check(s) failed` : 'all checks passed'}\n`);
process.exit(failures ? 1 : 0);
