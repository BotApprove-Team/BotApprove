#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

if (!process.env.DATABASE_PATH) {
  console.error('Refusing to run against the default database. Set DATABASE_PATH.');
  process.exit(1);
}
const RP = '1548844974693552179';
process.env.RAIDPROTECTOR_BOT_ID = RP;

const { config } = await import('../src/config.js');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(config.db.path + suffix, { force: true });
fs.mkdirSync(path.dirname(config.db.path), { recursive: true });

const { PermissionsBitField } = await import('discord.js');
const { whitelist, guildConfig } = await import('../src/db/queries.js');
const { seedDefaultKeywords, matchKeyword } = await import('../src/services/securityService.js');
const { onBotJoin, isOwnProduct } = await import('../src/services/botJoinPipeline.js');
const { db } = await import('../src/db/index.js');

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}`
    + (ok ? '' : `\n         expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`));
};

const GUILD = '100000000000000001';
const BOTAPPROVE = '1545551180640288828';
guildConfig.ensure(GUILD);
seedDefaultKeywords(GUILD);

const kicked = [];
const joining = (id, username, { bot = true } = {}) => ({
  id,
  guild: { id: GUILD, name: 'test', client: { users: { fetch: async () => null } } },
  client: { user: { id: BOTAPPROVE } },
  user: { id, bot, username, tag: `${username}#0001`, createdTimestamp: Date.now() - 400 * 86_400_000 },
  roles: { cache: new Map(), highest: { position: 1 } },
  permissions: new PermissionsBitField(['BanMembers', 'ModerateMembers', 'SendMessages']),
  kick: async () => { kicked.push(id); },
});

console.log('\n- RaidProtector, by its own ID -');
check('its name would match the default keywords', matchKeyword(GUILD, 'RaidProtector'), 'raid');
const rp = await onBotJoin(joining(RP, 'RaidProtector'));
check('it is let in', rp.action, 'allowed_own_product');
check('and not kicked', kicked.includes(RP), false);
check('it goes on the whitelist, approved by BotApprove itself', whitelist.get(GUILD, RP)?.approved_by, BOTAPPROVE);
// The drift watch only follows whitelisted bots, and this one can ban.
check('so the permission drift watch follows it like any approved bot', whitelist.has(GUILD, RP), true);
const logged = db.prepare("SELECT action, detail FROM security_log WHERE guild_id = ? AND bot_id = ? ORDER BY id").all(GUILD, RP);
check('and the join is logged as our own product',
  logged.some((r) => r.action === 'join_allowed' && JSON.parse(r.detail).own_product === true), true);

console.log('\n- a bot that only borrows the name -');
const LOOKALIKE = '200000000000000005';
check('is not our product', isOwnProduct(joining(LOOKALIKE, 'RaidProtector')), false);
check('nor is a person who somehow has the ID', isOwnProduct(joining(RP, 'RaidProtector', { bot: false })), false);
check('so the name still meets the keyword check', matchKeyword(GUILD, 'RaidProtector'), 'raid');

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exitCode = failures ? 1 : 0;
