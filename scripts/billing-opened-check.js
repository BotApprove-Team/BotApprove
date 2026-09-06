#!/usr/bin/env node
/**
 * The "card payment is now open" announcement.
 *
 *   DATABASE_PATH=./data/opened.db node scripts/billing-opened-check.js
 *
 * It fires once, on a real off-to-on transition, and never on a fresh install
 * that has always had Stripe enabled. Getting that wrong means DMing every
 * server owner on the instance for no reason, which is the sort of mistake that
 * costs a verified bot its verification.
 */
import fs from 'node:fs';
import path from 'node:path';

if (!process.env.DATABASE_PATH) {
  console.error('Refusing to run against the default database. Set DATABASE_PATH.');
  process.exit(1);
}

process.env.PAYWALL_ENABLED = 'true';
process.env.STRIPE_SECRET_KEY = 'sk_test_not_a_real_key';
process.env.STRIPE_PRICE_ID = 'price_monthly';
process.env.STRIPE_ENABLED = 'false';
// Pinned rather than left unset. dotenv fills these from a real .env, so on a
// configured host the run would inherit the live yearly and lifetime prices and
// assert against plans this test never set up.
process.env.STRIPE_PRICE_ID_YEARLY = '';
process.env.STRIPE_PRICE_ID_LIFETIME = '';

const { config } = await import('../src/config.js');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(config.db.path + suffix, { force: true });
fs.mkdirSync(path.dirname(config.db.path), { recursive: true });

const { instanceState } = await import('../src/db/queries.js');
const { transition, announceIfOpened } = await import('../src/services/billingOpened.js');
const { availablePlans } = await import('../src/services/stripeService.js');

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}` +
    (ok ? '' : `\n         expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`));
};

const KEY = 'stripe_enabled_last_seen';
const noGuilds = { guilds: { cache: new Map() } };

console.log('\n- while card payment is off -');
check('the pricing page has nothing to sell', availablePlans(), []);
check('nothing has been seen yet', transition().firstRun, true);
check('and there is no transition to announce', transition().opened, false);

const first = await announceIfOpened(noGuilds);
check('the first boot announces nothing', first.announced, false);
check('for being the first run', first.reason, 'first_run');
check('but the state is now recorded', instanceState.get(KEY), 'disabled');

console.log('\n- still off on the next boot -');
const second = await announceIfOpened(noGuilds);
check('still nothing', second.announced, false);
check('because nothing changed', second.reason, 'no_change');

console.log('\n- card payment is switched on -');
config.stripe.enabled = true;
check('plans appear', availablePlans(), ['monthly']);
const t = transition();
check('the transition is seen', t.opened, true);
check('from disabled', t.seen, 'disabled');
check('to enabled', t.now, 'enabled');

const opened = await announceIfOpened(noGuilds);
check('the announcement runs', opened.announced, true);
check('across every guild it is in', opened.guilds, 0);
check('and the new state is recorded', instanceState.get(KEY), 'enabled');

console.log('\n- how it reaches each server -');
const { guildConfig } = await import('../src/db/queries.js');

// Records what each fake guild was sent, and how.
const sends = [];
const channel = (id, canPost = true) => ({
  id,
  isTextBased: () => true,
  permissionsFor: () => ({ has: () => canPost }),
  send: async (payload) => {
    if (!canPost) throw new Error('cannot post');
    sends.push({ via: 'channel', id, content: payload.content, mentions: payload.allowedMentions });
  },
});

const makeGuild = ({ id, channels = {}, ownerDmOk = true, cfg = {} }) => {
  guildConfig.set(id, cfg);
  return {
    id,
    ownerId: `owner-${id}`,
    members: { me: {} },
    channels: { fetch: async (cid) => channels[cid] ?? null },
    fetchOwner: async () => ({
      id: `owner-${id}`,
      send: async () => {
        if (!ownerDmOk) throw new Error('dms closed');
        sends.push({ via: 'dm', id });
      },
    }),
  };
};

const withGuilds = (list) => ({ guilds: { cache: new Map(list.map((g) => [g.id, g])) } });

// Announcement channel wins; it is the one opted into for exactly this.
const g1 = makeGuild({
  id: 'g1',
  cfg: { announce_channel_id: 'a1', notify_channel_id: 'n1', log_channel_id: 'l1' },
  channels: { a1: channel('a1'), n1: channel('n1'), l1: channel('l1') },
});
// No announcement channel, so the approval channel is used.
const g2 = makeGuild({
  id: 'g2',
  cfg: { notify_channel_id: 'n2', log_channel_id: 'l2' },
  channels: { n2: channel('n2'), l2: channel('l2') },
});
// A channel is set but unpostable, so it must fall through rather than fail.
const g3 = makeGuild({
  id: 'g3',
  cfg: { notify_channel_id: 'n3' },
  channels: { n3: channel('n3', false) },
});
// No channels at all: the DM fallback.
const g4 = makeGuild({ id: 'g4', cfg: {} });
// No channels and closed DMs: counted as failed, not silently lost.
const g5 = makeGuild({ id: 'g5', cfg: {}, ownerDmOk: false });

instanceState.set(KEY, 'disabled');
const run = await announceIfOpened(withGuilds([g1, g2, g3, g4, g5]));

check('every guild was attempted', run.guilds, 5);
check('two reached in-channel', run.inChannel, 2);
// g3's channel is unpostable, so it correctly falls through to a DM alongside g4.
check('two by DM, including the unpostable-channel guild', run.byDm, 2);
check('one could not be reached', run.failed, 1);

const by = (id) => sends.find((s) => s.id === id || s.id === `${id}`);
check('the announcement channel was preferred', !!by('a1'), true);
check('and the others in that guild were left alone', !!by('n1') || !!by('l1'), false);
check('the approval channel was used where there was no announce channel', !!by('n2'), true);
check('an unpostable channel fell through to a DM', sends.some((s) => s.via === 'dm' && s.id === 'g3'), true);
check('the channel-less guild got a DM', sends.some((s) => s.via === 'dm' && s.id === 'g4'), true);
check('the owner was pinged, not the channel', by('a1').content, '<@owner-g1>');
check('and only the owner could be mentioned', by('a1').mentions, { users: ['owner-g1'] });

console.log('\n- and never again -');
const again = await announceIfOpened(noGuilds);
check('a later boot announces nothing', again.announced, false);
check('because nothing changed', again.reason, 'no_change');
check('the state is unchanged', instanceState.get(KEY), 'enabled');

console.log('\n- switching it back off re-arms it -');
config.stripe.enabled = false;
await announceIfOpened(noGuilds);
check('the off state is recorded', instanceState.get(KEY), 'disabled');
config.stripe.enabled = true;
check('so turning it on again would announce', transition().opened, true);

console.log('\n- an instance that never had it off -');
// A fresh install with Stripe on from the start must not DM anyone.
instanceState.set(KEY, null);
check('nothing seen', transition().firstRun, true);
const fresh = await announceIfOpened(noGuilds);
check('it stays quiet', fresh.announced, false);
check('recorded as first run', fresh.reason, 'first_run');
check('and enabled is remembered', instanceState.get(KEY), 'enabled');

console.log(`\n${failures ? `${failures} check(s) failed` : 'all checks passed'}\n`);
process.exit(failures ? 1 : 0);
