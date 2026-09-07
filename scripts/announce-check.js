import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PermissionsBitField } = require('discord.js');

if (!process.env.DATABASE_PATH) {
  console.error('Refusing to run against the default database. Set DATABASE_PATH.');
  process.exit(1);
}

const { config } = await import('../src/config.js');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(config.db.path + suffix, { force: true });
fs.mkdirSync(path.dirname(config.db.path), { recursive: true });

const { guildConfig, announcements } = await import('../src/db/queries.js');
const { broadcast, preview, validate } =
  await import('../src/services/announcementService.js');

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}` +
    (ok ? '' : `\n         expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`));
};

const sent = [];

function makeGuild({ id, name, canMention = true, sendThrows = false, channelMissing = false }) {
  const perms = new PermissionsBitField(
    canMention
      ? ['ViewChannel', 'SendMessages', 'EmbedLinks', 'AttachFiles', 'MentionEveryone']
      : ['ViewChannel', 'SendMessages', 'EmbedLinks', 'AttachFiles'],
  );
  const channel = {
    isTextBased: () => true,
    permissionsFor: () => perms,
    send: async (payload) => {
      if (sendThrows) throw new Error('missing access');
      sent.push({ guildId: id, content: payload.content, allowed: payload.allowedMentions });
    },
  };
  return {
    id,
    name,
    ownerId: `owner-${id}`,
    members: { me: { permissions: perms } },
    channels: { fetch: async () => (channelMissing ? null : channel) },
  };
}

const guilds = new Map();
const client = { guilds: { cache: guilds } };
const addGuild = (g, { channelId, allowEveryone }) => {
  guilds.set(g.id, g);
  guildConfig.get(g.id);
  guildConfig.set(g.id, {
    announce_channel_id: channelId,
    announce_allow_everyone: allowEveryone ? 1 : 0,
  });
};

addGuild(makeGuild({ id: 'g-allows', name: 'Allows pings' }), { channelId: 'c1', allowEveryone: true });
addGuild(makeGuild({ id: 'g-quiet', name: 'Quiet only' }), { channelId: 'c2', allowEveryone: false });
addGuild(makeGuild({ id: 'g-nomention', name: 'No permission', canMention: false }),
  { channelId: 'c3', allowEveryone: true });
addGuild(makeGuild({ id: 'g-optout', name: 'Opted out' }), { channelId: null, allowEveryone: false });
addGuild(makeGuild({ id: 'g-broken', name: 'Broken channel', sendThrows: true }),
  { channelId: 'c5', allowEveryone: false });

console.log('\n- validation -');
check('an empty body is refused', validate({ body: '  ' }).ok, false);
check('a normal message passes', validate({ body: 'Maintenance tonight.' }).ok, true);
check('title is optional', validate({ body: 'x'.repeat(10) }).title, null);

console.log('\n- preview shows who would receive it -');
const rows = preview(client);
check('every guild is listed', rows.length, 5);
check('opted-in servers sort first', rows.slice(0, 4).every((r) => r.optedIn), true);
check('the opted-out one is last', rows[4].optedIn, false);

console.log('\n- a quiet announcement -');
sent.length = 0;
const quiet = await broadcast(client, { title: 'Notice', body: 'Quiet please.', everyone: false, sentBy: 'op' });
check('it succeeds', quiet.ok, true);
check('delivered to the four with channels', quiet.delivered, 3);
check('the opted-out server is skipped, not failed', quiet.skipped, 1);
check('the broken channel is counted as failed', quiet.failed, 1);
check('nothing was pinged', quiet.pinged, 0);
check('no message carried an @everyone', sent.every((s) => !s.content), true);
check('and mentions were suppressed', sent.every((s) => s.allowed.parse.length === 0), true);

console.log('\n- an @everyone announcement needs both sides to agree -');
sent.length = 0;
const loud = await broadcast(client, { title: 'Urgent', body: 'Please read.', everyone: true, sentBy: 'op' });
check('still delivered to everyone reachable', loud.delivered, 3);
check('only the consenting server was pinged', loud.pinged, 1);
const pinged = sent.filter((s) => s.content === '@everyone').map((s) => s.guildId);
check('and it was the right one', pinged, ['g-allows']);
check('a server that disallows it got no ping',
  sent.find((s) => s.guildId === 'g-quiet').content, undefined);
check('nor did the one where we lack MentionEveryone',
  sent.find((s) => s.guildId === 'g-nomention').content, undefined);

console.log('\n- one broken server cannot stop the rest -');
check('the run completed despite a throwing channel', loud.ok, true);
check('and the others still received it', sent.length, 3);

console.log('\n- everything is recorded -');
const history = announcements.recent(10);
check('both broadcasts are in the history', history.length, 2);
check('the newest is first', history[0].title, 'Urgent');
check('counts were persisted', history[0].delivered, 3);
const targets = announcements.targets(history[0].id);
check('every guild has a target row', targets.length, 5);
check('the pinged one is marked', targets.filter((t) => t.pinged_everyone).length, 1);
check('the skipped one says why',
  targets.find((t) => t.guild_id === 'g-optout').detail, 'no channel configured');

console.log('\n- a message aimed at named servers -');
sent.length = 0;
const directed = await broadcast(client, {
  body: 'Your role sits below the bots it is meant to gate.',
  guildIds: ['g-quiet'],
  sentBy: 'operator',
});
check('it went out', directed.ok, true);
check('to exactly one server', sent.length, 1);
check('and it was the one named', sent[0].guildId, 'g-quiet');

console.log('\n- pinging the owner -');
sent.length = 0;
await broadcast(client, {
  body: 'Please move the BotApprove role above your bots.',
  guildIds: ['g-quiet'],
  pingOwner: true,
  sentBy: 'operator',
});
check('the owner is mentioned', sent[0].content, '<@owner-g-quiet>');
check('and only they can be mentioned', sent[0].allowed, { parse: [], users: ['owner-g-quiet'] });

console.log('\n- a server that never opted in can still be reached directly -');
sent.length = 0;
guildConfig.set('g-optout', { notify_channel_id: 'fallback' });
const reached = await broadcast(client, {
  body: 'This one needs fixing.',
  guildIds: ['g-optout'],
  pingOwner: true,
  sentBy: 'operator',
});
check('the fallback channel was used', reached.delivered, 1);
check('and the owner was pinged there', sent[0].content, '<@owner-g-optout>');

console.log('\n- and a broadcast still respects the opt-in -');
sent.length = 0;
const all = await broadcast(client, { body: 'To everyone who opted in.', sentBy: 'operator' });
check('the opted-out server is still skipped', all.skipped, 1);
check('even though it now has an approval channel',
  sent.some((x) => x.guildId === 'g-optout'), false);

console.log(`\n${failures ? `${failures} check(s) failed` : 'all checks passed'}\n`);
process.exit(failures ? 1 : 0);
