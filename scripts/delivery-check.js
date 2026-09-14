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

const { guildConfig, approverRoles, pendingApprovals, securityLog } =
  await import('../src/db/queries.js');
const { resolveDeliveryChannel } = await import('../src/services/channelCheck.js');
const { deliverApprovalPrompt } = await import('../src/services/approvalService.js');
const { ChannelType, EmbedBuilder, PermissionsBitField, Collection } =
  await import('discord.js');

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}` +
    (ok ? '' : `\n         expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`));
};

const FULL = ['ViewChannel', 'SendMessages', 'EmbedLinks', 'AttachFiles'];
let sent = [];

function makeChannel(id, name, position, perms = FULL, type = ChannelType.GuildText) {
  return {
    id,
    name,
    rawPosition: position,
    type,
    isTextBased: () => type === ChannelType.GuildText || type === ChannelType.GuildAnnouncement,
    permissionsFor: () => new PermissionsBitField(perms),
    send: async (payload) => {
      sent.push({ channelId: id, payload });
      return { id: `msg-${id}` };
    },
  };
}

let dms = [];

function makeGuild({ id, channels, systemChannel = null, notify = null, log = null }) {
  guildConfig.ensure(id);
  guildConfig.set(id, { notify_channel_id: notify, log_channel_id: log });
  const cache = new Collection(channels.map((c) => [c.id, c]));
  const member = (uid) => ({
    id: uid,
    send: async (payload) => { dms.push({ to: uid, payload }); },
  });
  return {
    id,
    name: 'Server',
    ownerId: 'owner-1',
    systemChannel,
    publicUpdatesChannel: null,
    members: {
      me: { id: 'me' },
      fetchMe: async () => ({ id: 'me' }),
      cache: new Collection(),
      fetch: async (uid) => member(uid),
    },
    channels: { cache, fetch: async (wanted) => cache.get(wanted) ?? null },
  };
}

const payload = () => ({
  embeds: [new EmbedBuilder().setTitle('Bot kicked, approval required')],
  files: [],
  components: [],
});

const fieldNames = (n = 0) =>
  (sent[n]?.payload?.embeds?.[0]?.data?.fields ?? []).map((f) => f.name);
const guidance = (n = 0) =>
  (sent[n]?.payload?.embeds?.[0]?.data?.fields ?? [])
    .find((f) => f.name === 'Worth setting up')?.value ?? '';

console.log('\n- the configured channel wins when it works -');
const chosen = makeChannel('c-notify', 'mod-log', 5);
const other = makeChannel('c-other', 'general', 1);
const g1 = makeGuild({ id: 'g1', channels: [other, chosen], notify: 'c-notify' });
check('it resolves to the configured one', (await resolveDeliveryChannel(g1, ['c-notify'])).channel.id,
  'c-notify');
check('and is not flagged as a guess', (await resolveDeliveryChannel(g1, ['c-notify'])).picked, false);

console.log('\n- with nothing configured it finds a channel itself -');
const g2 = makeGuild({ id: 'g2', channels: [makeChannel('c-3', 'third', 3), makeChannel('c-1', 'first', 1)] });
const found = await resolveDeliveryChannel(g2, [null, null]);
check('it picks one', found.channel.id, 'c-1');
check('lowest position first', found.channel.name, 'first');
check('and says it guessed', found.picked, true);

console.log('\n- the system channel is preferred over channel order -');
const sys = makeChannel('c-sys', 'welcome', 9);
const g3 = makeGuild({ id: 'g3', channels: [makeChannel('c-a', 'aaa', 0), sys], systemChannel: sys });
check('Discord own notice channel wins', (await resolveDeliveryChannel(g3, [])).channel.id, 'c-sys');

console.log('\n- a channel it cannot post in is skipped -');
const muted = makeChannel('c-muted', 'rules', 0, ['ViewChannel']);
const usable = makeChannel('c-ok', 'chat', 4);
const g4 = makeGuild({ id: 'g4', channels: [muted, usable] });
check('it steps over the one it cannot use', (await resolveDeliveryChannel(g4, [])).channel.id, 'c-ok');

const deaf = makeGuild({ id: 'g-deaf', channels: [makeChannel('c-x', 'x', 0, ['ViewChannel'])] });
check('and reports nothing when there is nowhere', (await resolveDeliveryChannel(deaf, [])).channel, null);

console.log('\n- voice and forum channels are not text -');
const voice = makeChannel('c-v', 'Voice', 0, FULL, ChannelType.GuildVoice);
const g5 = makeGuild({ id: 'g5', channels: [voice, makeChannel('c-t', 'text', 8)] });
check('a voice channel is not chosen', (await resolveDeliveryChannel(g5, [])).channel.id, 'c-t');

console.log('\n- the whole point: a card is delivered with nothing configured -');
const g6 = makeGuild({ id: 'g6', channels: [makeChannel('c-only', 'general', 0)] });
const p6 = Number(pendingApprovals.create({
  guildId: 'g6', botId: 'b1', botTag: 'b#1', addedBy: 'u1',
}).lastInsertRowid);

sent = [];
const delivered = await deliverApprovalPrompt({ guild: g6, pendingId: p6, payload: payload() });
check('it was delivered', delivered, true);
check('to the channel it found', sent[0].channelId, 'c-only');
check('and the message id was stored so the buttons survive a restart',
  pendingApprovals.byId(p6).message_id, 'msg-c-only');
check('nothing was logged as undelivered',
  securityLog.recent('g6', 20).some((r) => r.action === 'approval_undelivered'), false);

console.log('\n- and it explains itself rather than silently guessing -');
check('the card carries the guidance field',
  fieldNames().includes('Worth setting up'), true);
check('it says why it picked this channel',
  guidance().includes('/config notify-channel'), true);
check('and who is allowed to press the buttons',
  guidance().includes('Manage Server'), true);
check('naming the command for that too', guidance().includes('/approvers add'), true);

console.log('\n- the owner is pinged as the stand-in -');
check('with no approver roles the owner is mentioned', sent[0].payload.content, '<@owner-1>');
check('and the mention is allowed through',
  sent[0].payload.allowedMentions, { users: ['owner-1'] });

console.log('\n- a configured server gets no lecture -');
const g7 = makeGuild({ id: 'g7', channels: [makeChannel('c-mod', 'mod', 0)], notify: 'c-mod' });
approverRoles.add('g7', 'r-mods');
const p7 = Number(pendingApprovals.create({
  guildId: 'g7', botId: 'b2', botTag: 'b#2', addedBy: 'u1',
}).lastInsertRowid);
sent = [];
await deliverApprovalPrompt({ guild: g7, pendingId: p7, payload: payload() });
check('no guidance field', fieldNames().includes('Worth setting up'), false);
check('the approver role is pinged', sent[0].payload.content, '<@&r-mods>');

console.log('\n- a broken configured channel falls through instead of failing -');
const broken = makeChannel('c-broken', 'gone', 0, ['ViewChannel']);
const spare = makeChannel('c-spare', 'spare', 2);
const g8 = makeGuild({ id: 'g8', channels: [broken, spare], notify: 'c-broken' });
const p8 = Number(pendingApprovals.create({
  guildId: 'g8', botId: 'b3', botTag: 'b#3', addedBy: 'u1',
}).lastInsertRowid);
sent = [];
const d8 = await deliverApprovalPrompt({ guild: g8, pendingId: p8, payload: payload() });
check('it still gets through', d8, true);
check('via the spare channel', sent[0].channelId, 'c-spare');

console.log('\n- when there is genuinely nowhere, it is still recorded -');
const g9 = makeGuild({ id: 'g9', channels: [makeChannel('c-no', 'no', 0, ['ViewChannel'])] });
const p9 = Number(pendingApprovals.create({
  guildId: 'g9', botId: 'b4', botTag: 'b#4', addedBy: 'u1',
}).lastInsertRowid);
sent = [];
const d9 = await deliverApprovalPrompt({ guild: g9, pendingId: p9, payload: payload() });
check('delivery fails honestly', d9, false);
check('nothing was sent', sent.length, 0);
check('and it is on the audit trail',
  securityLog.recent('g9', 20).some((r) => r.action === 'approval_undelivered'), true);

console.log('\n- the person who added the bot is told what happened -');
const g10 = makeGuild({ id: 'g10', channels: [makeChannel('c-g', 'general', 0)] });
const p10 = Number(pendingApprovals.create({
  guildId: 'g10', botId: 'b5', botTag: 'cool#5', addedBy: 'inviter-1',
}).lastInsertRowid);
sent = []; dms = [];
await deliverApprovalPrompt({
  guild: g10,
  pendingId: p10,
  payload: payload(),
  inviter: { known: true, id: 'inviter-1', tag: 'someone#0001' },
  botTag: 'cool#5',
});
check('the inviter got a DM', dms.length, 1);
check('addressed to them', dms[0].to, 'inviter-1');
const dm = dms[0].payload.embeds[0].data;
check('it names the bot in the title', dm.title.includes('held for approval'), true);
check('it says this is not an error', dm.description.includes('not an error'), true);
check('and that every bot is treated the same way', dm.description.includes('every'), true);
check('it points at the channel the card went to',
  JSON.stringify(dm.fields).includes('c-g'), true);
check('and warns the bot is not re-added automatically',
  JSON.stringify(dm.fields).includes('re-invite the bot yourself'), true);

console.log('\n- but it does not become its own spam -');
dms = [];
const p11 = Number(pendingApprovals.create({
  guildId: 'g10', botId: 'b6', botTag: 'cool#6', addedBy: 'inviter-1',
}).lastInsertRowid);
await deliverApprovalPrompt({
  guild: g10, pendingId: p11, payload: payload(),
  inviter: { known: true, id: 'inviter-1', tag: 'someone#0001' }, botTag: 'cool#6',
});
check('a second bot from the same person is quiet', dms.length, 0);

dms = [];
const p12 = Number(pendingApprovals.create({
  guildId: 'g10', botId: 'b7', botTag: 'cool#7', addedBy: 'inviter-2',
}).lastInsertRowid);
await deliverApprovalPrompt({
  guild: g10, pendingId: p12, payload: payload(),
  inviter: { known: true, id: 'inviter-2', tag: 'other#0002' }, botTag: 'cool#7',
});
check('but a different person is still told', dms.length, 1);

dms = [];
const p13 = Number(pendingApprovals.create({
  guildId: 'g10', botId: 'b8', botTag: 'cool#8', addedBy: null,
}).lastInsertRowid);
await deliverApprovalPrompt({
  guild: g10, pendingId: p13, payload: payload(),
  inviter: { known: false, reason: 'audit_log_unavailable' }, botTag: 'cool#8',
});
check('an unknown inviter is nobody to DM', dms.length, 0);

console.log(`\n${failures ? `${failures} check(s) failed` : 'all checks passed'}\n`);
process.exit(failures ? 1 : 0);
