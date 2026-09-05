#!/usr/bin/env node
/**
 * Monthly, yearly and perpetual.
 *
 *   DATABASE_PATH=./data/plans.db node scripts/plans-check.js
 *
 * The perpetual case is the one worth guarding: it arrives as a one-off payment
 * with no subscription behind it, so nothing will ever renew it, and a
 * cancellation belonging to some other subscription must not take it away.
 */
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
process.env.STRIPE_PRICE_ID = 'price_monthly';
process.env.STRIPE_PRICE_ID_YEARLY = 'price_yearly';
process.env.STRIPE_PRICE_ID_LIFETIME = 'price_lifetime';
process.env.STRIPE_TRIAL_DAYS = '7';
process.env.LIFETIME_CAP = '1';

const { config } = await import('../src/config.js');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(config.db.path + suffix, { force: true });
fs.mkdirSync(path.dirname(config.db.path), { recursive: true });

const { entitlements } = await import('../src/db/queries.js');
const { availablePlans, planPrice, handleEvent, trialOffer, lifetimeAvailability, createCheckoutSession } =
  await import('../src/services/stripeService.js');
const { resolveEntitlement, markBillingLapse, generateLicenseKey, redeemLicenseKey } =
  await import('../src/services/entitlementService.js');

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}` +
    (ok ? '' : `\n         expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`));
};

const LIFE = '800000000000000001';
const YEAR = '800000000000000002';
const KEYED = '800000000000000003';

const completed = (guildId, mode, extra = {}) => ({
  type: 'checkout.session.completed',
  id: `evt_${guildId}_${mode}`,
  data: {
    object: {
      mode,
      customer: `cus_${guildId}`,
      client_reference_id: guildId,
      metadata: { guild_id: guildId, trial_days: '0', ...extra },
    },
  },
});

console.log('\n- the plans on offer -');
check('all three are sellable', availablePlans(), ['monthly', 'yearly', 'lifetime']);
check('monthly is recurring', planPrice('monthly').recurring, true);
check('yearly is recurring', planPrice('yearly').recurring, true);
check('lifetime is not', planPrice('lifetime').recurring, false);
check('an unknown plan resolves to nothing', planPrice('forever'), null);

const savedYearly = config.stripe.priceIdYearly;
config.stripe.priceIdYearly = '';
check('a plan with no price id is not offered', availablePlans().includes('yearly'), false);
config.stripe.priceIdYearly = savedYearly;

console.log('\n- buying a lifetime licence -');
await handleEvent(completed(LIFE, 'payment'));
const life = resolveEntitlement(LIFE);
check('the server is licensed', life.licensed, true);
check('as pro', life.tier, 'pro');
check('with no expiry', entitlements.get(LIFE).expires_at, null);
check('flagged perpetual', !!entitlements.get(LIFE).perpetual, true);
check('the note says lifetime', entitlements.get(LIFE).note, 'stripe lifetime');
check('the customer id was kept', entitlements.get(LIFE).external_id, `cus_${LIFE}`);

console.log('\n- a stray cancellation cannot revoke it -');
// Someone who moves from monthly to lifetime cancels the old subscription. That
// event resolves to this guild, and acting on it would revoke what they bought.
const lapse = await markBillingLapse(LIFE, 'cancelled');
check('the lapse is refused', lapse.reason, 'perpetual');
check('still licensed afterwards', resolveEntitlement(LIFE).licensed, true);
check('and still active', entitlements.get(LIFE).status, 'active');
check('a failed payment is refused too',
  (await markBillingLapse(LIFE, 'payment_failed')).reason, 'perpetual');
check('licensed through that as well', resolveEntitlement(LIFE).licensed, true);

console.log('\n- a subscription still lapses normally -');
await handleEvent(completed(YEAR, 'subscription'));
check('the yearly server is licensed', resolveEntitlement(YEAR).licensed, true);
check('and is not perpetual', !!entitlements.get(YEAR).perpetual, false);
await markBillingLapse(YEAR, 'cancelled');
check('cancelling ends it', resolveEntitlement(YEAR).licensed, false);
check('recorded as cancelled', entitlements.get(YEAR).lapse_reason, 'cancelled');

console.log('\n- a perpetual key is just as permanent -');
const key = generateLicenseKey({ durationDays: null, maxGuilds: 1, note: 'promo' });
await redeemLicenseKey(KEYED, key, 'someone');
check('flagged perpetual on redemption', !!entitlements.get(KEYED).perpetual, true);
check('a stray cancellation is refused',
  (await markBillingLapse(KEYED, 'cancelled')).reason, 'perpetual');
check('still licensed', resolveEntitlement(KEYED).licensed, true);

const dated = generateLicenseKey({ durationDays: 30, maxGuilds: 1, note: 'sold' });
const DATED = '800000000000000004';
await redeemLicenseKey(DATED, dated, 'someone');
check('a dated key is not perpetual', !!entitlements.get(DATED).perpetual, false);

console.log('\n- the lifetime cap -');
const avail = lifetimeAvailability();
check('the cap is on', avail.capped, true);
check('one has been sold', avail.sold, 1);
check('none left', avail.remaining, 0);
check('so it is sold out', avail.soldOut, true);
check('and it stops being offered', availablePlans().includes('lifetime'), false);
check('monthly and yearly are unaffected', availablePlans(), ['monthly', 'yearly']);
// A stale page or a hand-made form must not get past a closed sale.
const blocked = await createCheckoutSession({ guildId: '800000000000000009', plan: 'lifetime' });
check('checkout refuses it server-side', blocked.reason, 'lifetime_sold_out');

console.log('\n- a complimentary key does not consume a place -');
check('the keyed server is perpetual', !!entitlements.get(KEYED).perpetual, true);
check('but it was given, not sold', entitlements.get(KEYED).source, 'license_key');
check('so the sold count still reads one', lifetimeAvailability().sold, 1);

config.stripe.lifetimeCap = 3;
check('raising the cap reopens the sale', lifetimeAvailability().soldOut, false);
check('with two left', lifetimeAvailability().remaining, 2);
check('and it is offered again', availablePlans().includes('lifetime'), true);
config.stripe.lifetimeCap = 0;
check('a cap of zero means no limit', lifetimeAvailability().capped, false);
check('and never sold out', lifetimeAvailability().soldOut, false);
config.stripe.lifetimeCap = 1;

console.log('\n- trials belong to subscriptions only -');
const FRESH = '800000000000000005';
check('a fresh server is offered a trial', trialOffer(FRESH).eligible, true);
check('the lifetime server is not', trialOffer(LIFE).eligible, false);

console.log(`\n${failures ? `${failures} check(s) failed` : 'all checks passed'}\n`);
process.exit(failures ? 1 : 0);
