#!/usr/bin/env node
/**
 * Baselines across a leave and rejoin.
 *
 *   DATABASE_PATH=./data/rejoin.db node scripts/rejoin-check.js
 *
 * Discord puts a re-added bot's managed role back at the bottom of the list. If
 * the role position from a previous stint survives, that drop reads as a
 * demotion and the self-check reports an active compromise attempt at the
 * moment someone re-invites the bot. Settings and the whitelist must survive;
 * the baselines must not.
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

const { selfCheckState, botPermissions, guildConfig, whitelist, keywords } =
  await import('../src/db/queries.js');

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}` +
    (ok ? '' : `\n         expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`));
};

const GUILD = '1332914184568045598';
const BOT = '888000000000000001';

console.log('\n- the first stint -');
guildConfig.set(GUILD, { notify_channel_id: '555', log_channel_id: '666', nickname: 'Gatekeeper' });
whitelist.add(GUILD, BOT, 'approver');
keywords.add(GUILD, 'custom-word', 'approver');
selfCheckState.save(GUILD, { rolePosition: 3, permissions: '["KickMembers","ViewAuditLog"]', lastOkAt: Date.now() });
botPermissions.save(GUILD, BOT, { botTag: 'x#1', permissions: '8', dangerous: ['Administrator'] });

check('a role position is on file', selfCheckState.get(GUILD).role_position, 3);
check('and a permission baseline', !!botPermissions.get(GUILD, BOT), true);

console.log('\n- the bot is removed and re-invited -');
// What the GuildCreate handler does now.
selfCheckState.clear(GUILD);
botPermissions.clearGuild(GUILD);

check('the role baseline is gone', selfCheckState.get(GUILD), undefined);
check('the permission baseline is gone', botPermissions.get(GUILD, BOT), undefined);

console.log('\n- which is what stops the false alarm -');
// selfCheck computes: demoted = previous?.role_position != null && position < previous.role_position
const rejoinPosition = 1;
const previous = selfCheckState.get(GUILD);
const demoted = previous?.role_position != null && rejoinPosition < previous.role_position;
check('landing at the bottom is not a demotion', demoted, false);

// The same position against the stale baseline is what fired before.
selfCheckState.save(GUILD, { rolePosition: 3, permissions: '[]', lastOkAt: Date.now() });
const stale = selfCheckState.get(GUILD);
check('whereas a stale baseline would have flagged it',
  stale.role_position != null && rejoinPosition < stale.role_position, true);
selfCheckState.clear(GUILD);

console.log('\n- what must survive the rejoin -');
const cfg = guildConfig.get(GUILD);
check('the approval channel is kept', cfg.notify_channel_id, '555');
check('the log channel is kept', cfg.log_channel_id, '666');
check('the nickname is kept', cfg.nickname, 'Gatekeeper');
check('the whitelist is kept', whitelist.has(GUILD, BOT), true);
check('custom keywords are kept', keywords.list(GUILD).includes('custom-word'), true);

console.log('\n- clearing is scoped to the one guild -');
const OTHER = '999000000000000002';
selfCheckState.save(OTHER, { rolePosition: 9, permissions: '[]', lastOkAt: Date.now() });
botPermissions.save(OTHER, BOT, { botTag: 'y#2', permissions: '0', dangerous: [] });
selfCheckState.clear(GUILD);
botPermissions.clearGuild(GUILD);
check('another server keeps its role baseline', selfCheckState.get(OTHER).role_position, 9);
check('and its permission baseline', !!botPermissions.get(OTHER, BOT), true);

console.log(`\n${failures ? `${failures} check(s) failed` : 'all checks passed'}\n`);
process.exit(failures ? 1 : 0);
