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

const {
  giveaways, giveawayEntries, guildConfig, approverRoles, entitlements,
} = await import('../src/db/queries.js');
const {
  enter, weighFor, drawFrom, eligible, prizeLabel, draw,
} = await import('../src/services/giveawayService.js');
const { PermissionsBitField } = await import('discord.js');

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}` +
    (ok ? '' : `\n         expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`));
};

const OWNER = 'owner-1';

function makeGuild({ id, name = 'Server', channel = null, approvers = [], botsStuck = 0,
  manageRoles = false }) {
  guildConfig.ensure(id);
  guildConfig.set(id, { notify_channel_id: channel });
  for (const r of approvers) approverRoles.add(id, r);

  const members = [
    { id: 'me', user: { bot: true }, roles: { highest: { position: 50 } } },
  ];
  for (let i = 0; i < botsStuck; i += 1) {
    members.push({ id: 'b' + i, user: { bot: true }, roles: { highest: { position: 90 } } });
  }

  return {
    id,
    name,
    ownerId: OWNER,
    members: {
      me: {
        id: 'me',
        roles: { highest: { position: 50 } },
        permissions: new PermissionsBitField(manageRoles ? ['ManageRoles'] : []),
      },
      cache: new Map(members.map((m) => [m.id, m])),
    },
    channels: { fetch: async () => null },
  };
}

console.log('\n- what a prize is called -');
check('a fixed run', prizeLabel({ duration_days: 30 }), 'premium for 30 days');
check('a single day', prizeLabel({ duration_days: 1 }), 'premium for a day');
check('forever', prizeLabel({ duration_days: null }), 'premium forever');

console.log('\n- entries are earned by being set up -');
const bare = makeGuild({ id: 'g-bare' });
check('a bare server gets the entry itself', weighFor(bare).reasons[0].why, 'Entered');
check('plus reach, since a server with no other bots can reach all of them',
  weighFor(bare).weight, 2);

const cramped = makeGuild({ id: 'g-cramped', botsStuck: 1 });
check('a server that actually cannot reach its bots gets only the entry',
  weighFor(cramped).weight, 1);

const setup = makeGuild({
  id: 'g-setup', channel: 'c1', approvers: ['r1'], manageRoles: true,
});
check('a fully configured one gets five', weighFor(setup).weight, 5);
check('and is told why', weighFor(setup).reasons.map((r) => r.why), [
  'Entered', 'Approval channel set', 'Approvers chosen',
  'Can remove every bot here', 'Can defend itself',
]);

const blocked = makeGuild({
  id: 'g-blocked', channel: 'c1', approvers: ['r1'], botsStuck: 2, manageRoles: true,
});
check('a server that cannot remove its bots loses that one', weighFor(blocked).weight, 4);

console.log('\n- who may enter -');
const info = giveaways.create({
  title: 'Test', tier: 'pro', durationDays: 30, winners: 1,
  closesAt: Date.now() + 3600_000, createdBy: 'op',
});
const gid = Number(info.lastInsertRowid);

check('a draft cannot be entered', (await enter(gid, bare, OWNER)).reason, 'not_open');

giveaways.markAnnounced(gid, {});
check('an open one can', (await enter(gid, bare, OWNER)).ok, true);
check('but not by a member', (await enter(gid, bare, 'someone-else')).reason, 'not_owner');

entitlements.upsert('g-paid', {
  tier: 'pro', status: 'active', expiresAt: null, source: 'manual',
});
const paid = makeGuild({ id: 'g-paid' });
check('a server with premium is not eligible', eligible('g-paid'), false);
check('and cannot enter', (await enter(gid, paid, OWNER)).reason, 'already_premium');

console.log('\n- entering twice recounts rather than stacking -');
await enter(gid, setup, OWNER);
const before = giveawayEntries.count(gid);
const again = await enter(gid, setup, OWNER);
check('it reports as an update', again.updated, true);
check('the server count did not grow', giveawayEntries.count(gid).n, before.n);
check('and neither did its tickets', giveawayEntries.get(gid, 'g-setup').weight, 5);

console.log('\n- a closed one is closed -');
const closedInfo = giveaways.create({
  title: 'Old', tier: 'pro', durationDays: 7, winners: 1,
  closesAt: Date.now() - 1000, createdBy: 'op',
});
const closedId = Number(closedInfo.lastInsertRowid);
giveaways.markAnnounced(closedId, {});
check('entering after the close is refused', (await enter(closedId, bare, OWNER)).reason, 'closed');

console.log('\n- the draw -');
const pool = [
  { guild_id: 'a', weight: 1 },
  { guild_id: 'b', weight: 1 },
  { guild_id: 'c', weight: 1 },
];
check('it picks the number asked for', drawFrom(pool, 2).length, 2);
check('never the same server twice',
  new Set(drawFrom(pool, 3).map((w) => w.guild_id)).size, 3);
check('and cannot pick more than entered', drawFrom(pool, 10).length, 3);

const heavy = [{ guild_id: 'big', weight: 1000 }, { guild_id: 'small', weight: 1 }];
let bigWins = 0;
for (let i = 0; i < 200; i += 1) {
  if (drawFrom(heavy, 1)[0].guild_id === 'big') bigWins += 1;
}
check('more entries really does mean better odds', bigWins > 150, true);

console.log('\n- drawing grants the prize -');
const grantInfo = giveaways.create({
  title: 'Grant', tier: 'pro', durationDays: 30, winners: 1,
  closesAt: Date.now() + 3600_000, createdBy: 'op',
});
const grantId = Number(grantInfo.lastInsertRowid);
giveaways.markAnnounced(grantId, {});
const lucky = makeGuild({ id: 'g-lucky' });
await enter(grantId, lucky, OWNER);
check('the winner had no premium', eligible('g-lucky'), true);
const result = await draw(grantId);
check('the draw succeeded', result.ok, true);
check('one winner', result.winners.length, 1);
check('who now has premium', eligible('g-lucky'), false);
check('and it is marked drawn', giveaways.byId(grantId).status, 'drawn');
check('drawing twice is refused', (await draw(grantId)).reason, 'already_drawn');

console.log('\n- an empty giveaway still closes -');
const emptyInfo = giveaways.create({
  title: 'Empty', tier: 'pro', durationDays: 30, winners: 1,
  closesAt: Date.now() + 1000, createdBy: 'op',
});
const emptyId = Number(emptyInfo.lastInsertRowid);
giveaways.markAnnounced(emptyId, {});
const empty = await draw(emptyId);
check('it draws nobody', empty.winners, []);
check('and says why', empty.reason, 'no_entries');
check('and does not stay open', giveaways.byId(emptyId).status, 'drawn');

console.log(`\n${failures ? `${failures} check(s) failed` : 'all checks passed'}\n`);
process.exit(failures ? 1 : 0);
