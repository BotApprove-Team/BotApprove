#!/usr/bin/env node
/**
 * Complimentary licence acceptance.
 *
 *   DATABASE_PATH=./data/terms.db node scripts/terms-check.js
 *
 * The rule: a perpetual key is only ever given away, so redeeming one requires
 * accepting the complimentary terms. A key with a duration was sold, and a
 * keyless perpetual bought through Stripe never touches this path at all.
 */
import fs from 'node:fs';
import path from 'node:path';

if (!process.env.DATABASE_PATH) {
  console.error('Refusing to run against the default database. Set DATABASE_PATH.');
  process.exit(1);
}

const { config } = await import('../src/config.js');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(config.db.path + suffix, { force: true });
fs.mkdirSync(path.dirname(config.db.path), { recursive: true });

const { termsAcceptances, licenseKeys } = await import('../src/db/queries.js');
const { generateLicenseKey, inspectLicenseKey, redeemLicenseKey, resolveEntitlement } =
  await import('../src/services/entitlementService.js');
const { DOCUMENT, VERSION, SECTIONS, TITLE } = await import('../src/services/promoTerms.js');

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}` +
    (ok ? '' : `\n         expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`));
};

const PERPETUAL_GUILD = '600000000000000001';
const DATED_GUILD = '600000000000000002';
const USER = '333000000000000009';

console.log('\n- telling the two kinds of key apart -');
const perpetual = generateLicenseKey({ durationDays: null, maxGuilds: 1, note: 'promo' });
const dated = generateLicenseKey({ durationDays: 365, maxGuilds: 1, note: 'sold' });

const p = inspectLicenseKey(perpetual);
check('a perpetual key is recognised', p.ok, true);
check('and flagged as perpetual', p.perpetual, true);

const d = inspectLicenseKey(dated);
check('a dated key is recognised', d.ok, true);
check('and is not perpetual', d.perpetual, false);

check('an unknown key is rejected', inspectLicenseKey('BA-AAAAA-AAAAA-AAAAA-AAAAA').reason,
  'unknown_key');

console.log('\n- inspecting does not consume -');
check('the key is still unredeemed', licenseKeys.byHash(p.keyHash).redeemed_count, 0);
inspectLicenseKey(perpetual);
inspectLicenseKey(perpetual);
check('and stays unredeemed however often it is inspected',
  licenseKeys.byHash(p.keyHash).redeemed_count, 0);

console.log('\n- a revoked key never reaches the terms -');
const revoked = generateLicenseKey({ durationDays: null, maxGuilds: 1, note: 'oops' });
licenseKeys.revoke(inspectLicenseKey(revoked).keyHash);
check('revoked keys are refused up front', inspectLicenseKey(revoked).reason, 'revoked');

console.log('\n- accepting, then redeeming -');
check('nothing recorded yet', termsAcceptances.latestFor(PERPETUAL_GUILD, DOCUMENT), undefined);
const redeemed = await redeemLicenseKey(PERPETUAL_GUILD, perpetual, USER);
check('the key redeems', redeemed.ok, true);
check('with no expiry', redeemed.expiresAt, null);
termsAcceptances.record({
  guildId: PERPETUAL_GUILD, userId: USER, document: DOCUMENT, version: VERSION, keyHash: p.keyHash,
});
const rec = termsAcceptances.latestFor(PERPETUAL_GUILD, DOCUMENT);
check('the acceptance is on file', !!rec, true);
check('against the right person', rec.user_id, USER);
check('with the version that was shown', rec.version, VERSION);
check('and the key it was for', rec.key_hash, p.keyHash);
check('the server is licensed', resolveEntitlement(PERPETUAL_GUILD).licensed, true);

console.log('\n- a dated key needs no acceptance -');
const datedResult = await redeemLicenseKey(DATED_GUILD, dated, USER);
check('it redeems straight away', datedResult.ok, true);
check('with an expiry', typeof datedResult.expiresAt, 'number');
check('and no terms were recorded', termsAcceptances.latestFor(DATED_GUILD, DOCUMENT), undefined);

console.log('\n- the record survives and stays ordered -');
termsAcceptances.record({
  guildId: PERPETUAL_GUILD, userId: 'someone-else', document: DOCUMENT, version: 'later', keyHash: null,
});
check('a second acceptance is kept separately', termsAcceptances.forGuild(PERPETUAL_GUILD).length, 2);
check('newest first', termsAcceptances.latestFor(PERPETUAL_GUILD, DOCUMENT).version, 'later');
check('the instance-wide list sees both', termsAcceptances.recent(50).length, 2);

console.log('\n- the document itself -');
check('has a title', TITLE.length > 0, true);
check('has a version', /^\d{4}-\d{2}-\d{2}$/.test(VERSION), true);
check('says it can be revoked',
  SECTIONS.some((s) => /revoked/i.test(s.heading)), true);
check('says the server keeps working',
  SECTIONS.some((s) => /keeps working/i.test(s.body)), true);
check('lists what gets a licence pulled',
  SECTIONS.find((s) => /revoked/i.test(s.heading)).list.length >= 5, true);

console.log(`\n${failures ? `${failures} check(s) failed` : 'all checks passed'}\n`);
process.exit(failures ? 1 : 0);
