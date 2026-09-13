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

const { guildConfig, instanceState, securityLog } = await import('../src/db/queries.js');
const safeMode = await import('../src/services/safeMode.js');
const { respond } = await import('../src/services/tamperResponse.js');
const { start: startLockdown } = await import('../src/services/lockdownService.js');
const { broadcast } = await import('../src/services/announcementService.js');
const { inviteNewGuild, announce } = await import('../src/services/giveawayService.js');
const { PermissionsBitField } = await import('discord.js');

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}` +
    (ok ? '' : `\n         expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`));
};

const GUILD = 'g-safe';
guildConfig.ensure(GUILD);
guildConfig.set(GUILD, { tamper_response: 'strip' });

const attacker = { id: 'attacker-1', tag: 'bad#0001' };

function makeGuild() {
  const mine = { id: 'r-me', name: 'BotApprove', position: 50, managed: true };
  return {
    id: GUILD,
    name: 'Safe',
    ownerId: 'owner-1',
    channels: { cache: new Map() },
    roles: { everyone: { id: GUILD, permissions: new PermissionsBitField([]) }, cache: new Map() },
    members: {
      me: {
        id: 'me',
        roles: { highest: mine, cache: new Map([[mine.id, mine]]) },
        permissions: new PermissionsBitField(['ManageRoles', 'KickMembers', 'ManageChannels']),
      },
      fetchMe: async () => null,
      cache: new Map(),
      fetch: async () => null,
    },
  };
}

console.log('\n- it starts off -');
check('nothing stored means off', safeMode.isActive(), false);
check('and everything is allowed', safeMode.CAPABILITIES.every(safeMode.allows), true);

console.log('\n- turning it on -');
const entered = await safeMode.enter({ reason: 'token may have leaked', actorId: 'op-1' });
check('it reports success', entered.ok, true);
check('it is on', safeMode.isActive(), true);
check('the reason is kept', safeMode.state().reason, 'token may have leaked');
check('turning it on twice is refused', (await safeMode.enter({ reason: 'again' })).reason,
  'already_active');
check('the original reason survives that', safeMode.state().reason, 'token may have leaked');

console.log('\n- what it refuses -');
check('acting on a person', safeMode.allows('act_on_member'), false);
check('messaging every server', safeMode.allows('broadcast'), false);
check('locking a server down', safeMode.allows('lockdown'), false);
check('anything it does not know about is left alone', safeMode.allows('approvals'), true);

console.log('\n- the refusals are real, not just a flag -');
const guild = makeGuild();
const stripped = await respond(guild, { trigger: 'role_update', actor: attacker });
check('tamper response refuses to strip', stripped.outcome, 'safe_mode');

check('lockdown refuses', (await startLockdown(guild, 'op-1')).reason, 'safe_mode');

check('announcements refuse', (await broadcast(null, {
  title: 'Hello', body: 'Everyone read this', sentBy: 'op-1',
})).reason, 'safe_mode');

check('giveaway announcements refuse', (await announce(1)).reason, 'safe_mode');
check('a joining server is not offered a giveaway', (await inviteNewGuild(guild)).sent, 0);

console.log('\n- entering and leaving is written down, and readable -');
check('a guild query cannot see an instance event', securityLog.recent(GUILD, 50)
  .some((r) => r.action === 'safe_mode_entered'), false);
check('the instance query can', securityLog.instance(50)
  .some((r) => r.action === 'safe_mode_entered'), true);
check('with the reason attached', JSON.parse(securityLog.instance(50)
  .find((r) => r.action === 'safe_mode_entered').detail).reason, 'token may have leaked');

console.log('\n- turning it off -');
const left = await safeMode.leave('op-1');
check('it reports success', left.ok, true);
check('it is off', safeMode.isActive(), false);
check('leaving twice is refused', (await safeMode.leave('op-1')).reason, 'not_active');
check('and the powers come back', safeMode.CAPABILITIES.every(safeMode.allows), true);

console.log('\n- it survives a restart -');
await safeMode.enter({ reason: 'held across a reboot', actorId: 'op-1' });
check('the state is in the database, not in memory',
  JSON.parse(instanceState.get('safe_mode')).reason, 'held across a reboot');
check('so a fresh read still sees it on', safeMode.isActive(), true);

console.log('\n- the gate has no off switch, by construction -');
const reads = (f) => fs.readFileSync(new URL(`../src/services/${f}`, import.meta.url), 'utf8');
const importsSafeMode = (f) => /from '\.\/safeMode\.js'/.test(reads(f));

for (const f of ['botJoinPipeline.js', 'approvalService.js', 'securityService.js']) {
  check(`${f} cannot consult safe mode`, importsSafeMode(f), false);
}
for (const f of ['tamperResponse.js', 'nukeDefense.js', 'externalAppGuard.js',
  'lockdownService.js', 'announcementService.js', 'giveawayService.js',
  'billingOpened.js', 'premiumWelcome.js']) {
  check(`${f} does`, importsSafeMode(f), true);
}

console.log('\n- a corrupt value is treated as off, not as on -');
instanceState.set('safe_mode', 'not json at all');
check('garbage does not wedge it on', safeMode.isActive(), false);
instanceState.set('safe_mode', '{"reason":"no timestamp"}');
check('an entry with no start time is not a state', safeMode.isActive(), false);

console.log(`\n${failures ? `${failures} check(s) failed` : 'all checks passed'}\n`);
process.exit(failures ? 1 : 0);
