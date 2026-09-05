#!/usr/bin/env node
/**
 * Who gets into a server's dashboard, and under what label.
 *
 *   DATABASE_PATH=./data/access.db node scripts/access-check.js
 *
 * Real permissions have to be resolved before the operator override. Checking
 * the override first hands back "borrowed access" for every server, including
 * ones the operator genuinely runs, and states they lack a permission that was
 * never looked at.
 */
import fs from 'node:fs';
import path from 'node:path';

if (!process.env.DATABASE_PATH) {
  console.error('Refusing to run against the default database. Set DATABASE_PATH.');
  process.exit(1);
}

const OPERATOR = '333000000000000009';
const OUTSIDER = '444000000000000001';
process.env.OWNER_IDS = OPERATOR;

const { config } = await import('../src/config.js');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(config.db.path + suffix, { force: true });
fs.mkdirSync(path.dirname(config.db.path), { recursive: true });

const { approverRoles } = await import('../src/db/queries.js');
const { setClient } = await import('../src/bot/clientRef.js');
const { resolveGuildAccess } = await import('../src/web/auth.js');

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}` +
    (ok ? '' : `\n         expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`));
};

const GUILD = '700000000000000001';
const MANAGE_GUILD = 1n << 5n;
const APPROVER_ROLE = 'role-approvers';

// A stand-in guild. resolveGuildAccess reads member permissions and roles.
const members = new Map();
const guild = {
  id: GUILD,
  name: 'Test Server',
  members: {
    fetch: async (id) => {
      const m = members.get(id);
      if (!m) throw new Error('unknown member');
      return m;
    },
  },
};
setClient({ guilds: { cache: { get: (id) => (id === GUILD ? guild : undefined) } } });

const member = (id, { manages = false, roles = [] } = {}) => {
  members.set(id, {
    id,
    permissions: { has: (flag) => manages && flag === MANAGE_GUILD },
    roles: { cache: { some: (fn) => roles.map((r) => ({ id: r })).some(fn) } },
  });
};

approverRoles.add(GUILD, APPROVER_ROLE);

console.log('\n- the operator, in a server they run -');
member(OPERATOR, { manages: true });
const own = await resolveGuildAccess(OPERATOR, GUILD, { elevated: true });
check('access is granted', own.allowed, true);
check('credited to their own permissions, not the unlock', own.via, 'guild_permissions');
check('they can configure', own.canConfigure, true);
check('and no borrowed-access banner is shown', !!own.configureViaOperator, false);

console.log('\n- the same server, unlock not active -');
const ownLocked = await resolveGuildAccess(OPERATOR, GUILD, { elevated: false });
check('still allowed, because they really do manage it', ownLocked.allowed, true);
check('still their own permissions', ownLocked.via, 'guild_permissions');
check('and still able to configure', ownLocked.canConfigure, true);

console.log('\n- a server they do not belong to -');
members.delete(OPERATOR);
const borrowed = await resolveGuildAccess(OPERATOR, GUILD, { elevated: true });
check('the unlock lets them in', borrowed.allowed, true);
check('and it is labelled as operator access', borrowed.via, 'instance_owner');
check('with configure granted', borrowed.canConfigure, true);

const locked = await resolveGuildAccess(OPERATOR, GUILD, { elevated: false });
check('without the unlock they are refused', locked.allowed, false);
check('as a non-member', locked.reason, 'not_a_member');

console.log('\n- an approver who cannot manage the server -');
member(OUTSIDER, { manages: false, roles: [APPROVER_ROLE] });
const approver = await resolveGuildAccess(OUTSIDER, GUILD, { elevated: false });
check('they get in', approver.allowed, true);
check('to approve', approver.canApprove, true);
check('but not to change settings', approver.canConfigure, false);

console.log('\n- the operator as an approver, not a manager -');
member(OPERATOR, { manages: false, roles: [APPROVER_ROLE] });
const mixed = await resolveGuildAccess(OPERATOR, GUILD, { elevated: true });
check('their real access is what let them in', mixed.via, 'guild_permissions');
check('the unlock still grants configure', mixed.canConfigure, true);
check('and that is disclosed rather than silent', mixed.configureViaOperator, true);

const mixedLocked = await resolveGuildAccess(OPERATOR, GUILD, { elevated: false });
check('locked again, approve remains', mixedLocked.canApprove, true);
check('and configure is withdrawn', mixedLocked.canConfigure, false);

console.log('\n- someone with no claim at all -');
member(OUTSIDER, { manages: false, roles: [] });
const nobody = await resolveGuildAccess(OUTSIDER, GUILD, { elevated: false });
check('refused', nobody.allowed, false);
check('for not being an approver', nobody.reason, 'not_an_approver');
// Elevation is the operator's, and must not travel to anyone else.
const notOperator = await resolveGuildAccess(OUTSIDER, GUILD, { elevated: true });
check('and elevation does not help a non-operator', notOperator.allowed, false);

console.log(`\n${failures ? `${failures} check(s) failed` : 'all checks passed'}\n`);
process.exit(failures ? 1 : 0);
