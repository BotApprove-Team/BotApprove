#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

if (!process.env.DATABASE_PATH) {
  console.error('Refusing to run against the default database. Set DATABASE_PATH.');
  process.exit(1);
}

const { config } = await import('../src/config.js');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(config.db.path + suffix, { force: true });
fs.mkdirSync(path.dirname(config.db.path), { recursive: true });

const { measure, compare, readSeal, summarise, SEAL_PATH } =
  await import('../src/services/integrity.js');
const { enforceIntegrity } = await import('../src/services/integrityWatch.js');
const safeMode = await import('../src/services/safeMode.js');
const { securityLog } = await import('../src/db/queries.js');

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}` +
    (ok ? '' : `\n         expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`));
};

const had = fs.existsSync(SEAL_PATH) ? fs.readFileSync(SEAL_PATH) : null;
const restore = () => {
  fs.rmSync(SEAL_PATH, { force: true });
  if (had) fs.writeFileSync(SEAL_PATH, had, { mode: 0o444 });
};

const writeSeal = (seal) => {
  fs.rmSync(SEAL_PATH, { force: true });
  fs.writeFileSync(SEAL_PATH, JSON.stringify(seal), { mode: 0o444 });
};

try {
  console.log('\n- measuring -');
  const a = measure();
  const b = measure();
  check('the same tree measures the same twice', a.root, b.root);
  check('it covers a real number of files', Object.keys(a.files).length > 30, true);
  check('the bot source is in it', 'src/bot/client.js' in a.files, true);
  check('the gate is in it', 'src/services/botJoinPipeline.js' in a.files, true);
  check('so are the views', Object.keys(a.files).some((f) => f.endsWith('.ejs')), true);
  check('and package.json', 'package.json' in a.files, true);
  check('the backup script is in it too, it reads the whole database',
    'scripts/backup.js' in a.files, true);
  check('the lockfile is deliberately not, npm rewrites it per machine and it is '
    + 'not what runs', 'package-lock.json' in a.files, false);
  check('the data directory is not', Object.keys(a.files).some((f) => f.startsWith('data/')), false);

  console.log('\n- spotting a difference -');
  const edited = { root: 'x', files: { ...a.files } };
  edited.files['src/bot/client.js'] = 'f'.repeat(64);
  check('an edited file is reported', compare(edited, a).changed, ['src/bot/client.js']);

  const gone = { root: 'x', files: { ...a.files } };
  delete gone.files['src/services/safeMode.js'];
  check('a file that appeared is reported', compare(gone, a).added, ['src/services/safeMode.js']);

  const extra = { root: 'x', files: { ...a.files, 'src/backdoor.js': 'a'.repeat(64) } };
  check('a file that vanished is reported', compare(extra, a).removed, ['src/backdoor.js']);

  check('an identical tree is clean', compare({ root: a.root, files: a.files }, a).ok, true);
  check('the summary reads plainly',
    summarise({ changed: ['a'], added: ['b', 'c'], removed: [] }), '1 changed, 2 added');

  console.log('\n- an unsealed instance is not punished -');
  fs.rmSync(SEAL_PATH, { force: true });
  const unsealed = await enforceIntegrity('startup');
  check('it reports that it is unsealed', unsealed.sealed, false);
  check('and does not enter safe mode', safeMode.isActive(), false);

  console.log('\n- a matching seal passes -');
  writeSeal({ root: a.root, sealedAt: Date.now(), files: a.files });
  check('the seal reads back', readSeal().root, a.root);
  const good = await enforceIntegrity('startup');
  check('it verifies', good.ok, true);
  check('and stays out of safe mode', safeMode.isActive(), false);

  console.log('\n- a mismatch trips it -');
  const tampered = { ...a.files };
  tampered['src/services/botJoinPipeline.js'] = '0'.repeat(64);
  writeSeal({ root: 'a-root-that-will-not-match', sealedAt: Date.now(), files: tampered });

  const bad = await enforceIntegrity('startup');
  check('it fails the check', bad.ok, false);
  check('it names the file', bad.changed, ['src/services/botJoinPipeline.js']);
  check('it entered safe mode', safeMode.isActive(), true);
  check('and said why', safeMode.state().source, 'integrity');
  check('naming the file in the reason',
    safeMode.state().reason.includes('botJoinPipeline.js'), true);
  check('it is on the instance audit trail',
    securityLog.instance(20).some((r) => r.action === 'safe_mode_entered'), true);

  console.log('\n- but the gate itself keeps running -');
  check('approvals were never a capability it can refuse',
    safeMode.CAPABILITIES.includes('approvals'), false);
  check('while everything that touches a person is', safeMode.allows('act_on_member'), false);

  console.log('\n- a second sweep does not stack -');
  const again = await enforceIntegrity('periodic');
  check('it notices it is already safe', again.alreadySafe, true);
  check('the original reason is untouched', safeMode.state().source, 'integrity');
  check('only one entry was written',
    securityLog.instance(20).filter((r) => r.action === 'safe_mode_entered').length, 1);

  console.log('\n- a corrupt seal is treated as no seal -');
  await safeMode.leave('test');
  fs.rmSync(SEAL_PATH, { force: true });
  fs.writeFileSync(SEAL_PATH, 'not json');
  check('it reads as absent', readSeal(), null);
  check('and does not trip safe mode', (await enforceIntegrity('startup')).sealed, false);
  check('so the instance keeps working', safeMode.isActive(), false);
} finally {
  restore();
}

console.log(`\n${failures ? `${failures} check(s) failed` : 'all checks passed'}\n`);
process.exit(failures ? 1 : 0);
