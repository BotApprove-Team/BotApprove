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

const { selfCheckState, guildConfig, approverRoles, securityLog } =
  await import('../src/db/queries.js');
const { checkGuild } = await import('../src/services/selfCheck.js');
const { Collection, PermissionsBitField } = await import('discord.js');

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}` +
    (ok ? '' : `\n         expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`));
};

let posted = [];

const REQUIRED = ['KickMembers', 'ViewAuditLog'];

function role(id, name, position, managed = false) {
  return {
    id,
    name,
    position,
    managed,
    comparePositionTo: (other) => position - other.position,
  };
}

function makeGuild({ id, position = 7, perms = REQUIRED, bots = [], channel = 'c1' }) {
  const mine = role('r-me', 'BotApprove', position, true);
  const roles = new Collection([[mine.id, mine], ['everyone', role(id, '@everyone', 0)]]);

  const me = {
    id: 'me',
    user: { bot: true, tag: 'BotApprove#0001' },
    permissions: new PermissionsBitField(perms),
    roles: { highest: mine, cache: new Collection([[mine.id, mine]]) },
  };

  const members = new Collection([['me', me]]);
  bots.forEach((b, i) => {
    const r = b.shares ? mine : role(`r-b${i}`, `Bot role ${i}`, b.position ?? position + 1);
    if (!b.shares) roles.set(r.id, r);
    members.set(`b${i}`, {
      id: `b${i}`,
      user: { bot: true, tag: b.tag ?? `bot${i}#0000` },
      permissions: new PermissionsBitField([]),
      roles: { highest: r, cache: new Collection([[r.id, r]]) },
    });
  });

  guildConfig.ensure(id);
  guildConfig.set(id, { notify_channel_id: channel, log_channel_id: channel });

  return {
    id,
    ownerId: 'owner-1',
    roles: { cache: roles, everyone: { permissions: new PermissionsBitField([]) } },
    members: { me, cache: members },
    channels: {
      fetch: async (wanted) => (wanted === channel && channel ? {
        isTextBased: () => true,
        permissionsFor: () => new PermissionsBitField([
          'ViewChannel', 'SendMessages', 'EmbedLinks', 'AttachFiles',
        ]),
        send: async (payload) => { posted.push(payload); },
      } : null),
    },
  };
}

const titleOf = (n = 0) => posted[n]?.embeds?.[0]?.data?.title;
const bodyOf = (n = 0) => posted[n]?.embeds?.[0]?.data?.description;
const alerts = (id) => securityLog.recent(id, 50)
  .filter((r) => r.action.startsWith('self_check')).length;

console.log('\n- a server that is merely unconfigured is not accused of being mispositioned -');
const bare = makeGuild({ id: 'g-bare' });
posted = [];
const first = await checkGuild(bare, { reason: 'startup' });
check('it is not ok', first.ok, false);
check('the only problem is the missing approvers', first.codes, ['no_approvers']);
check('and it says so', titleOf(), 'BotApprove is not finished being set up');
check('rather than blaming the role position',
  titleOf() === 'BotApprove is not correctly positioned', false);
check('the boilerplate about dragging the role is gone',
  /drag/i.test(bodyOf() ?? ''), false);
check('one message, not two', posted.length, 1);

console.log('\n- and it is said once -');
posted = [];
for (let i = 0; i < 5; i += 1) await checkGuild(bare, { reason: 'periodic' });
check('five more sweeps say nothing', posted.length, 0);
check('and log nothing new', alerts('g-bare'), 1);
check('but still report the problem to whoever asked',
  (await checkGuild(bare, { reason: 'periodic' })).problems.length, 1);

console.log('\n- until something actually changes -');
approverRoles.add('g-bare', 'r-approve');
guildConfig.set('g-bare', { notify_channel_id: null });
posted = [];
const moved = await checkGuild(bare, { reason: 'periodic' });
check('a different problem speaks again', posted.length, 1);
check('and it is the new one', moved.codes, ['no_channel']);

console.log('\n- fixing it resets the memory -');
guildConfig.set('g-bare', { notify_channel_id: 'c1' });
posted = [];
const clean = await checkGuild(bare, { reason: 'periodic' });
check('a healthy server says nothing', posted.length, 0);
check('and reports ok', clean.ok, true);
check('the fingerprint is cleared', selfCheckState.get('g-bare').problems_hash, null);

approverRoles.remove('g-bare', 'r-approve');
posted = [];
await checkGuild(bare, { reason: 'periodic' });
check('so a problem coming back is news again', posted.length, 1);

console.log('\n- reading the dashboard does not announce anything -');
const quiet = makeGuild({ id: 'g-quiet' });
posted = [];
const viewed = await checkGuild(quiet, { reason: 'dashboard', announce: false });
check('nothing is posted', posted.length, 0);
check('nothing is logged', alerts('g-quiet'), 0);
check('but the caller still sees the problems', viewed.problems.length, 1);
posted = [];
await checkGuild(quiet, { reason: 'periodic' });
check('and the sweep afterwards is still free to speak', posted.length, 1);

console.log('\n- a real positioning problem still reads as one -');
const stuck = makeGuild({ id: 'g-stuck', bots: [{ tag: 'nuke#1', shares: true }] });
approverRoles.add('g-stuck', 'r-approve');
posted = [];
const blocked = await checkGuild(stuck, { reason: 'startup' });
check('the unreachable bot is a problem', blocked.codes, ['unreachable']);
check('and the title names it', titleOf(), 'BotApprove cannot fully protect this server');

console.log('\n- missing permissions outrank a setup gap in the title -');
const weak = makeGuild({ id: 'g-weak', perms: [] });
posted = [];
const noPerms = await checkGuild(weak, { reason: 'startup' });
check('both are reported', noPerms.codes, ['perms', 'no_approvers']);
check('the permission one leads', titleOf(), 'BotApprove cannot fully protect this server');
check('and it names the permissions in plain words',
  /Kick Members and View Audit Log/.test(bodyOf()), true);

console.log('\n- being weakened is an incident, and repeats -');
const hit = makeGuild({ id: 'g-hit' });
approverRoles.add('g-hit', 'r-approve');
await checkGuild(hit, { reason: 'startup' });
selfCheckState.save('g-hit', {
  rolePosition: 40,
  permissions: JSON.stringify(REQUIRED),
});
posted = [];
const tampered = await checkGuild(hit, { reason: 'role_update' });
check('it is flagged as tampering', tampered.tampering, true);
check('and said loudly', titleOf(), 'BotApprove has been weakened');
check('the footer promises to keep saying it',
  posted[0].embeds[0].data.footer.text.includes('Repeats'), true);

selfCheckState.save('g-hit', {
  rolePosition: 40,
  permissions: JSON.stringify(REQUIRED),
});
posted = [];
await checkGuild(hit, { reason: 'role_update' });
check('within the cooldown it holds off', posted.length, 0);

const held = selfCheckState.get('g-hit').problems_hash;
selfCheckState.noteProblems('g-hit', held, Date.now() - 20 * 60_000);
selfCheckState.save('g-hit', {
  rolePosition: 40,
  permissions: JSON.stringify(REQUIRED),
});
posted = [];
await checkGuild(hit, { reason: 'role_update' });
check('past it, the same incident is repeated', posted.length, 1);

console.log('\n- and a fresh incident is not swallowed by an unrelated notice -');
const late = makeGuild({ id: 'g-late' });
approverRoles.add('g-late', 'r-approve');
guildConfig.set('g-late', { notify_channel_id: null });
posted = [];
await checkGuild(late, { reason: 'periodic' });
check('the setup gap is announced', posted.length, 1);

guildConfig.set('g-late', { notify_channel_id: 'c1' });
selfCheckState.save('g-late', {
  rolePosition: 40,
  permissions: JSON.stringify(REQUIRED),
});
posted = [];
const urgent = await checkGuild(late, { reason: 'role_update' });
check('a demotion two minutes later still gets through', posted.length, 1);
check('and is treated as tampering', urgent.tampering, true);

console.log('\n- a standing gap is renagged weekly, not every sweep -');
const old = makeGuild({ id: 'g-old' });
await checkGuild(old, { reason: 'startup' });
const hash = selfCheckState.get('g-old').problems_hash;
selfCheckState.noteProblems('g-old', hash, Date.now() - 6 * 86_400_000);
posted = [];
await checkGuild(old, { reason: 'periodic' });
check('six days in, still quiet', posted.length, 0);
selfCheckState.noteProblems('g-old', hash, Date.now() - 8 * 86_400_000);
posted = [];
await checkGuild(old, { reason: 'periodic' });
check('eight days in, one reminder', posted.length, 1);

console.log(`\n${failures ? `${failures} check(s) failed` : 'all checks passed'}\n`);
process.exit(failures ? 1 : 0);
