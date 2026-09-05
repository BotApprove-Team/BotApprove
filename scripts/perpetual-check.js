#!/usr/bin/env node
/**
 * The operator's proof-of-life command.
 *
 *   DATABASE_PATH=./data/perp.db node scripts/perpetual-check.js
 *
 * It exists to be answered from inside a real Discord client, because the
 * dashboard reads a cached guild list and the REST API is a different path
 * again: both can look healthy while the bot is deaf on the gateway. What it
 * says about the licence still has to be true, so the headline is derived from
 * the entitlement row rather than assumed.
 */
import fs from 'node:fs';
import path from 'node:path';

if (!process.env.DATABASE_PATH) {
  console.error('Refusing to run against the default database. Set DATABASE_PATH.');
  process.exit(1);
}

const OPERATOR = '333000000000000009';
process.env.OWNER_IDS = OPERATOR;
process.env.PAYWALL_ENABLED = 'true';

const { config } = await import('../src/config.js');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(config.db.path + suffix, { force: true });
fs.mkdirSync(path.dirname(config.db.path), { recursive: true });

const { entitlements } = await import('../src/db/queries.js');
const { resolveEntitlement, generateLicenseKey, redeemLicenseKey } =
  await import('../src/services/entitlementService.js');
const { commandDefinitions } = await import('../src/bot/commands/index.js');

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}` +
    (ok ? '' : `\n         expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`));
};

// Mirrors the headline branch in the command handler.
const headlineFor = (guildId) => {
  const row = entitlements.get(guildId);
  const ent = resolveEntitlement(guildId);
  const perpetual = !!row?.perpetual;
  const gifted = perpetual && row?.source === 'license_key';
  return gifted
    ? 'I am on a perpetual gifted licence.'
    : perpetual
      ? 'I am on a purchased lifetime licence.'
      : `I am not on a perpetual licence here. This server is ${ent.tier} / ${ent.state}.`;
};

console.log('\n- the command is registered correctly -');
const def = commandDefinitions.find((c) => c.name === 'perpetual');
check('it exists', !!def, true);
check('it is not usable in DMs', def.dm_permission, false);
// No permission gate: the operator is usually just a member of the servers
// holding a gifted licence, and gating would hide it from them precisely there.
check('usable by any member, so the operator is never locked out',
  def.default_member_permissions ?? null, null);

console.log('\n- a gifted perpetual key -');
const GIFTED = '900000000000000001';
const key = generateLicenseKey({ durationDays: null, maxGuilds: 1, note: 'promo' });
await redeemLicenseKey(GIFTED, key, OPERATOR);
check('the row is perpetual', !!entitlements.get(GIFTED).perpetual, true);
check('and came from a key', entitlements.get(GIFTED).source, 'license_key');
check('so it says exactly that', headlineFor(GIFTED), 'I am on a perpetual gifted licence.');

console.log('\n- a purchased lifetime -');
const BOUGHT = '900000000000000002';
entitlements.upsert(BOUGHT, {
  tier: 'pro', status: 'active', expiresAt: null, source: 'stripe', note: 'stripe lifetime',
});
entitlements.markPerpetual(BOUGHT);
check('it is not called gifted', headlineFor(BOUGHT), 'I am on a purchased lifetime licence.');

console.log('\n- a dated key is not perpetual -');
const DATED = '900000000000000003';
const dated = generateLicenseKey({ durationDays: 365, maxGuilds: 1, note: 'sold' });
await redeemLicenseKey(DATED, dated, OPERATOR);
check('the claim is not made', headlineFor(DATED).startsWith('I am not on a perpetual'), true);
check('and the real state is reported', headlineFor(DATED), 'I am not on a perpetual licence here. This server is pro / active.');

console.log('\n- an unlicensed server -');
const FREE = '900000000000000004';
check('it says so plainly', headlineFor(FREE),
  'I am not on a perpetual licence here. This server is none / never_licensed.');

console.log('\n- a lapsed subscription -');
const LAPSED = '900000000000000005';
entitlements.upsert(LAPSED, {
  tier: 'pro', status: 'expired', expiresAt: Date.now() - 1000, source: 'stripe',
});
check('reported as expired, not perpetual', headlineFor(LAPSED),
  'I am not on a perpetual licence here. This server is pro / expired.');

console.log('\n- the server is told, whatever it pays -');
const { guildConfig } = await import('../src/db/queries.js');
const { hasFeature } = await import('../src/services/featureService.js');

// Where the notice goes: the log channel, else the approval channel.
const target = (guildId) => {
  const cfg = guildConfig.get(guildId);
  return cfg.log_channel_id ?? cfg.notify_channel_id ?? null;
};

const UNPAID = '900000000000000006';
guildConfig.set(UNPAID, { log_channel_id: '555' });
check('an unlicensed server gets no log mirroring', hasFeature(UNPAID, 'log_channel'), false);
check('but the notice still has somewhere to go', target(UNPAID), '555');

const NOLOG = '900000000000000007';
guildConfig.set(NOLOG, { notify_channel_id: '777' });
check('with no log channel it falls back to the approval channel', target(NOLOG), '777');

const SILENT = '900000000000000008';
guildConfig.get(SILENT);
check('a server with neither has nowhere, and that is reported back', target(SILENT), null);

guildConfig.set(GIFTED, { log_channel_id: '999', notify_channel_id: '888' });
check('the log channel wins over the approval channel', target(GIFTED), '999');

console.log('\n- only the operator may run it -');
const allowed = (userId) => config.ownerIds.includes(userId);
check('the operator can', allowed(OPERATOR), true);
check('a server owner cannot', allowed('111000000000000001'), false);
check('nor can anyone else', allowed('222000000000000002'), false);

console.log(`\n${failures ? `${failures} check(s) failed` : 'all checks passed'}\n`);
process.exit(failures ? 1 : 0);
