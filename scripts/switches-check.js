#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

if (!process.env.DATABASE_PATH) {
  console.error('Refusing to run against the default database. Set DATABASE_PATH.');
  process.exit(1);
}

process.env.PAYWALL_ENABLED = 'true';

const { config } = await import('../src/config.js');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(config.db.path + suffix, { force: true });
fs.mkdirSync(path.dirname(config.db.path), { recursive: true });

const { entitlements, guildFeatures, guildConfig } = await import('../src/db/queries.js');
const {
  hasFeature, isEntitled, setFeature, featureSwitches, dormantCount, premiumKeys,
} = await import('../src/services/featureService.js');

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}` +
    (ok ? '' : `\n         expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`));
};

const LICENSED = '111111111111111111';
const FREE = '222222222222222222';

guildConfig.ensure(LICENSED);
guildConfig.ensure(FREE);
entitlements.upsert(LICENSED, {
  tier: 'pro', status: 'active', expiresAt: null, source: 'manual',
});

console.log('\n- buying premium switches nothing on -');
check('entitled to the feature', isEntitled(LICENSED, 'approval_quorum'), true);
check('but it is not active', hasFeature(LICENSED, 'approval_quorum'), false);
check('every premium feature is dormant', dormantCount(LICENSED), premiumKeys.length);
check('and none report as enabled',
  featureSwitches(LICENSED).some((f) => f.enabled), false);

console.log('\n- the free gate is never affected -');
for (const key of ['core_gate', 'keyword_block', 'audit_trail', 'tamper_detection']) {
  check(`${key} is on for a licensed server`, hasFeature(LICENSED, key), true);
  check(`${key} is on for a free server`, hasFeature(FREE, key), true);
}
check('a free feature cannot be switched off',
  setFeature(LICENSED, 'core_gate', false).reason, 'always_on');
check('and stays on after trying', hasFeature(LICENSED, 'core_gate'), true);

console.log('\n- switching one on -');
check('the switch takes', setFeature(LICENSED, 'approval_quorum', true, 'u1').ok, true);
check('the feature is now live', hasFeature(LICENSED, 'approval_quorum'), true);
check('one fewer dormant', dormantCount(LICENSED), premiumKeys.length - 1);
check('the others are untouched', hasFeature(LICENSED, 'known_nuke_db'), false);

console.log('\n- and off again -');
setFeature(LICENSED, 'approval_quorum', false, 'u1');
check('back off', hasFeature(LICENSED, 'approval_quorum'), false);
check('still entitled', isEntitled(LICENSED, 'approval_quorum'), true);

console.log('\n- without a licence -');
check('not entitled', isEntitled(FREE, 'approval_quorum'), false);
check('cannot switch it on', setFeature(FREE, 'approval_quorum', true).reason, 'not_entitled');
check('and it stays off', hasFeature(FREE, 'approval_quorum'), false);

console.log('\n- a switch outlives the licence lapsing -');
setFeature(LICENSED, 'known_nuke_db', true, 'u1');
check('live while licensed', hasFeature(LICENSED, 'known_nuke_db'), true);
entitlements.upsert(LICENSED, {
  tier: 'pro', status: 'active', expiresAt: Date.now() - 1000, source: 'manual',
});
check('gone when the licence expires', hasFeature(LICENSED, 'known_nuke_db'), false);
check('the switch itself is remembered',
  guildFeatures.isEnabled(LICENSED, 'known_nuke_db'), true);
entitlements.upsert(LICENSED, {
  tier: 'pro', status: 'active', expiresAt: null, source: 'manual',
});
check('and comes straight back on renewal', hasFeature(LICENSED, 'known_nuke_db'), true);

console.log('\n- unknown keys are refused -');
check('unknown feature', setFeature(LICENSED, 'not_a_feature', true).reason, 'unknown_feature');
check('and never reports enabled', hasFeature(LICENSED, 'not_a_feature'), false);

console.log(`\n${failures ? `${failures} check(s) failed` : 'all checks passed'}\n`);
process.exit(failures ? 1 : 0);
