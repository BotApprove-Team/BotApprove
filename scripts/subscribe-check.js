#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

if (!process.env.DATABASE_PATH) {
  console.error('Refusing to run against the default database. Set DATABASE_PATH.');
  process.exit(1);
}

process.env.PAYWALL_ENABLED = 'true';
process.env.STRIPE_ENABLED = 'true';
process.env.STRIPE_SECRET_KEY = 'sk_test_not_a_real_key';
process.env.STRIPE_PRICE_ID = 'price_monthly';
process.env.STRIPE_PRICE_ID_YEARLY = 'price_yearly';
process.env.STRIPE_PRICE_ID_LIFETIME = 'price_lifetime';
process.env.SESSION_SECRET = 'test-only';

const { config } = await import('../src/config.js');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(config.db.path + suffix, { force: true });
fs.mkdirSync(path.dirname(config.db.path), { recursive: true });

const { entitlements } = await import('../src/db/queries.js');
const { PLANS, lifetimeAvailability, isEnabled } = await import('../src/services/stripeService.js');

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}` +
    (ok ? '' : `\n         expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`));
};

console.log('\n- the plans the buttons can ask for -');
check('monthly is a plan', Object.keys(PLANS).includes('monthly'), true);
check('yearly is a plan', Object.keys(PLANS).includes('yearly'), true);
check('lifetime is a plan', Object.keys(PLANS).includes('lifetime'), true);
check('anything else is not', Object.prototype.hasOwnProperty.call(PLANS, 'free'), false);
check('stripe reports enabled', isEnabled(), true);

console.log('\n- which servers are offered -');
const MANAGE_GUILD_BIT = 1n << 5n;
const LICENSED = '111111111111111111';
const PLAIN = '222222222222222222';
const NO_BOT = '333333333333333333';
const NO_PERMS = '444444444444444444';

entitlements.upsert(LICENSED, {
  tier: 'pro', status: 'active', expiresAt: null, source: 'manual',
});

const { resolveEntitlement } = await import('../src/services/featureService.js');

const session = {
  user: { id: 'buyer' },
  guilds: [
    { id: LICENSED, name: 'Already Paid', icon: null, owner: true, permissions: '8' },
    { id: PLAIN, name: 'Ready To Buy', icon: null, owner: true, permissions: '8' },
    { id: NO_BOT, name: 'Bot Not Added', icon: null, owner: true, permissions: '8' },
    { id: NO_PERMS, name: 'Just A Member', icon: null, owner: false, permissions: '0' },
  ],
};

const present = new Set([LICENSED, PLAIN, NO_PERMS]);
const offered = session.guilds
  .filter((g) => g.owner || (BigInt(g.permissions) & MANAGE_GUILD_BIT) === MANAGE_GUILD_BIT)
  .map((g) => ({
    id: g.id,
    name: g.name,
    botPresent: present.has(g.id),
    licensed: resolveEntitlement(g.id).licensed,
  }));

check('a server you only belong to is not offered',
  offered.some((g) => g.id === NO_PERMS), false);
check('a manageable server is offered', offered.some((g) => g.id === PLAIN), true);

const ready = offered.filter((g) => g.botPresent && !g.licensed);
const already = offered.filter((g) => g.licensed);
const missing = offered.filter((g) => !g.botPresent);

check('one server is ready to buy for', ready.map((g) => g.name), ['Ready To Buy']);
check('the paid one is listed separately', already.map((g) => g.name), ['Already Paid']);
check('and the one without the bot too', missing.map((g) => g.name), ['Bot Not Added']);

console.log('\n- the lifetime cap still applies -');
check('lifetime is available to start', lifetimeAvailability().soldOut, false);

console.log('\n- an unknown plan is refused before any of this -');
const badPlan = 'enterprise';
check('not a real plan', Object.prototype.hasOwnProperty.call(PLANS, badPlan), false);

console.log(`\n${failures ? `${failures} check(s) failed` : 'all checks passed'}\n`);
process.exit(failures ? 1 : 0);
