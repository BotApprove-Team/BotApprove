#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

if (!process.env.DATABASE_PATH) {
  console.error('Refusing to run against the default database. Set DATABASE_PATH.');
  process.exit(1);
}

process.env.PAYWALL_ENABLED = 'true';
process.env.TRIAL_DAYS = '0';
process.env.STRIPE_ENABLED = 'true';
process.env.STRIPE_SECRET_KEY = 'sk_test_not_a_real_key';
process.env.STRIPE_PRICE_ID = 'price_test';
process.env.STRIPE_TRIAL_DAYS = '7';

const { config } = await import('../src/config.js');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(config.db.path + suffix, { force: true });
fs.mkdirSync(path.dirname(config.db.path), { recursive: true });

const { entitlements } = await import('../src/db/queries.js');
const { trialOffer, handleEvent } = await import('../src/services/stripeService.js');
const { resolveEntitlement } = await import('../src/services/entitlementService.js');

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}` +
    (ok ? '' : `\n         expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`));
};

const GUILD = '700000000000000001';
const PAID = '700000000000000002';

const completed = (guildId, trialDays) => ({
  type: 'checkout.session.completed',
  id: `evt_${guildId}_${trialDays}`,
  data: {
    object: {
      customer: `cus_${guildId}`,
      client_reference_id: guildId,
      metadata: { guild_id: guildId, trial_days: String(trialDays) },
    },
  },
});

const invoicePaid = (guildId, amount) => ({
  type: 'invoice.paid',
  id: `evt_inv_${guildId}_${amount}`,
  data: {
    object: {
      customer: `cus_${guildId}`,
      amount_paid: amount,
      metadata: { guild_id: guildId },
      lines: { data: [{ period: { end: Math.floor(Date.now() / 1000) + 30 * 86_400 } }] },
    },
  },
});

console.log('\n- the offer -');
check('a fresh server is eligible', trialOffer(GUILD).eligible, true);
check('for the configured length', trialOffer(GUILD).days, 7);
check('with no server in hand there is no offer', trialOffer(null).eligible, false);

console.log('\n- taking it -');
await handleEvent(completed(GUILD, 7));
const afterCheckout = resolveEntitlement(GUILD);
check('the server is licensed immediately', afterCheckout.licensed, true);
check('recorded as a trial, not as pro', afterCheckout.tier, 'trial');
check('the note says so', entitlements.get(GUILD).note, 'stripe subscription, 7 day trial');
check('the customer id was stored', entitlements.get(GUILD).external_id, `cus_${GUILD}`);
check('and the offer is now spent', trialOffer(GUILD).eligible, false);
check('reported as used rather than merely licensed',
  trialOffer(GUILD).reason, 'already_used');

console.log('\n- the zero-pound trial invoice -');
await handleEvent(invoicePaid(GUILD, 0));
check('does not relabel the server pro', resolveEntitlement(GUILD).tier, 'trial');
check('but does set an expiry', typeof entitlements.get(GUILD).expires_at, 'number');

console.log('\n- converting to paid -');
await handleEvent(invoicePaid(GUILD, 500));
check('a real payment upgrades the tier', resolveEntitlement(GUILD).tier, 'pro');
check('still licensed', resolveEntitlement(GUILD).licensed, true);

console.log('\n- the offer is once per server -');
await handleEvent({
  type: 'customer.subscription.deleted',
  id: 'evt_cancel',
  data: { object: { customer: `cus_${GUILD}`, metadata: { guild_id: GUILD } } },
});
check('cancelling unlicenses it', resolveEntitlement(GUILD).licensed, false);
const afterCancel = trialOffer(GUILD);
check('and the trial is NOT offered again', afterCancel.eligible, false);
check('because it was already used', afterCancel.reason, 'already_used');
check('the stamp survived the cancellation',
  !!entitlements.get(GUILD).stripe_trial_used_at, true);

console.log('\n- a server that paid without a trial -');
await handleEvent(completed(PAID, 0));
check('is pro straight away', resolveEntitlement(PAID).tier, 'pro');
check('and never used its trial', entitlements.get(PAID).stripe_trial_used_at, null);
check('so it is not offered one while subscribed', trialOffer(PAID).eligible, false);
check('for the licensing reason, not the used one', trialOffer(PAID).reason, 'already_licensed');

console.log('\n- switching the offer off -');
config.stripe.trialDays = 0;
check('no offer when the length is zero', trialOffer('700000000000000003').eligible, false);
config.stripe.trialDays = 7;
config.stripe.enabled = false;
check('and none at all without stripe', trialOffer('700000000000000003').eligible, false);
config.stripe.enabled = true;
check('restored', trialOffer('700000000000000003').eligible, true);

console.log(`\n${failures ? `${failures} check(s) failed` : 'all checks passed'}\n`);
process.exit(failures ? 1 : 0);
