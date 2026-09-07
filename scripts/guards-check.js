#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { PermissionsBitField } from 'discord.js';

if (!process.env.DATABASE_PATH) {
  console.error('Refusing to run against the default database. Set DATABASE_PATH.');
  process.exit(1);
}

const { config } = await import('../src/config.js');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(config.db.path + suffix, { force: true });
fs.mkdirSync(path.dirname(config.db.path), { recursive: true });

const { guildConfig, webhookEvents, lockdown } = await import('../src/db/queries.js');
const { onWebhookCreated } = await import('../src/services/webhookGuard.js');
const { start, lift, isActive } = await import('../src/services/lockdownService.js');

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}` +
    (ok ? '' : `\n         expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`));
};

const OWNER = 'owner-1';
let deleted = [];

function webhookGuild(id, mode, { hookExists = true } = {}) {
  guildConfig.ensure(id);
  guildConfig.set(id, { webhook_guard: mode, log_channel_id: null, notify_channel_id: null });
  return {
    id,
    ownerId: OWNER,
    client: { user: { id: 'me' } },
    channels: { fetch: async () => null },
    fetchWebhooks: async () => new Map(
      hookExists ? [['wh1', { id: 'wh1', delete: async () => { deleted.push('wh1'); } }]] : [],
    ),
  };
}

const created = (actorId) => ({
  webhookId: 'wh1',
  name: 'incoming',
  channelId: 'c1',
  actor: { id: actorId, tag: `${actorId}#1` },
});

console.log('\n- the webhook guard -');
deleted = [];
check('off does nothing',
  (await onWebhookCreated(webhookGuild('w1', 'off'), created('u1'))).outcome, 'disabled');
check('and deletes nothing', deleted, []);

deleted = [];
check('report leaves it in place',
  (await onWebhookCreated(webhookGuild('w2', 'report'), created('u1'))).outcome, 'reported');
check('but still records it', webhookEvents.recent('w2').length, 1);
check('without deleting', deleted, []);

deleted = [];
check('delete removes it',
  (await onWebhookCreated(webhookGuild('w3', 'delete'), created('u1'))).outcome, 'deleted');
check('and it is gone', deleted, ['wh1']);

deleted = [];
check('the owner\'s webhook is left alone',
  (await onWebhookCreated(webhookGuild('w4', 'delete'), created(OWNER))).outcome, 'owner_created');
check('not deleted', deleted, []);
check('but still recorded', webhookEvents.recent('w4').length, 1);

deleted = [];
check('our own webhook is not a finding',
  (await onWebhookCreated(webhookGuild('w5', 'delete'), created('me'))).outcome, 'self');
check('and is not recorded', webhookEvents.recent('w5').length, 0);

check('a webhook already gone reports the failure',
  (await onWebhookCreated(webhookGuild('w6', 'delete', { hookExists: false }), created('u1'))).outcome,
  'delete_failed');

console.log('\n- lockdown restores what was there -');
const edits = [];

const SEND = PermissionsBitField.Flags.SendMessages;

function channel(id, before) {
  const cache = new Map();
  if (before !== undefined) {
    cache.set('everyone', {
      deny: { has: (f) => f === SEND && before === false },
      allow: { has: (f) => f === SEND && before === true },
    });
  }
  return {
    id,
    parentId: null,
    permissionOverwrites: {
      cache,
      edit: async (_role, perms) => { edits.push({ id, SendMessages: perms.SendMessages }); },
    },
  };
}

const channels = new Map([
  ['c1', channel('c1', undefined)],
  ['c2', channel('c2', true)],
  ['c3', channel('c3', false)],
]);

const guild = {
  id: 'L1',
  members: { me: { permissions: { has: () => true } } },
  roles: { everyone: { id: 'everyone' } },
  channels: { cache: channels },
};

const on = await start(guild, 'op');
check('every channel is locked', on.channels, 3);
check('all set to deny', edits.map((e) => e.SendMessages), [false, false, false]);
check('and it is recorded as active', isActive('L1'), true);
check('starting twice is refused', (await start(guild, 'op')).reason, 'already_active');

edits.length = 0;
const off = await lift(guild, 'op');
check('every channel is restored', off.restored, 3);

check('c1 had no setting, so it is cleared',
  edits.find((e) => e.id === 'c1').SendMessages, null);
check('c2 was allowed, so it is allowed again',
  edits.find((e) => e.id === 'c2').SendMessages, true);
check('c3 was already locked, so it stays locked',
  edits.find((e) => e.id === 'c3').SendMessages, false);
check('and it is no longer active', isActive('L1'), false);
check('lifting again is refused', (await lift(guild, 'op')).reason, 'not_active');

console.log('\n- lockdown needs the permission -');
const weak = { ...guild, id: 'L2', members: { me: { permissions: { has: () => false } } } };
check('without Manage Channels it says so', (await start(weak, 'op')).reason, 'no_manage_channels');
check('and records nothing', lockdown.isActive('L2'), false);

console.log(`\n${failures ? `${failures} check(s) failed` : 'all checks passed'}\n`);
process.exit(failures ? 1 : 0);
