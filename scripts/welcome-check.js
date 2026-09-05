#!/usr/bin/env node
/**
 * Can BotApprove actually remove the bots in this server?
 *
 *   DATABASE_PATH=./data/welcome.db node scripts/welcome-check.js
 *
 * Discord only lets a bot remove a member whose highest role is STRICTLY below
 * its own. Level with it is not enough, which is how a server that has tidily
 * put every bot in one "Bots" role ends up with a gate that holds bots for
 * approval and then fails to kick them. That case looks correct from the role
 * list, so it has to be caught by position, not by eye.
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

const { roleStanding } = await import('../src/services/welcome.js');

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}` +
    (ok ? '' : `\n         expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`));
};

// Enough of a guild for roleStanding, which reads role positions, the managed
// flag, and each bot's highest role. A real one needs a gateway connection.
const collection = (items) => ({
  get size() { return items.length; },
  values: () => items.values(),
  filter: (fn) => collection(items.filter(fn)),
  some: (fn) => items.some(fn),
  map: (fn) => items.map(fn),
});

const makeGuild = ({ myRole, roles, bots = [] }) => {
  const all = [myRole, ...roles];
  return {
    members: {
      me: { id: 'me', roles: { highest: myRole } },
      cache: collection([
        { id: 'me', user: { bot: true, tag: 'BotApprove#3260' }, roles: { highest: myRole } },
        ...bots,
      ]),
    },
    roles: { cache: collection(all) },
  };
};

const OWN = { id: 'r-me', name: 'BotApprove', position: 25, managed: true };
const BOTS_ROLE = { id: 'r-bots', name: 'Bots', position: 68, managed: false };

console.log('\n- a fresh join, at the bottom of the list -');
const fresh = makeGuild({
  myRole: { ...OWN, position: 1 },
  roles: [
    { id: 'r1', name: 'Admin', position: 30, managed: false },
    { id: 'r2', name: 'Dyno', position: 20, managed: true },
  ],
  bots: [{ id: 'b1', user: { bot: true, tag: 'Dyno#3861' }, roles: { highest: { id: 'r2', name: 'Dyno', position: 20 } } }],
});
const s1 = roleStanding(fresh);
check('the position is reported', s1.position, 1);
check('the bot above is out of reach', s1.unreachable, ['Dyno#3861']);
check('so it is not ok', s1.ok, false);
check('and it is not a shared-role problem', s1.sharing, false);

console.log('\n- sharing one "Bots" role with the bots it gates -');
// The Cube Bouncers shape: tidy role list, and nothing can be removed.
const shared = makeGuild({
  myRole: BOTS_ROLE,
  roles: [{ id: 'r1', name: 'Admin', position: 90, managed: false }],
  bots: [
    { id: 'b1', user: { bot: true, tag: 'Dyno#3861' }, roles: { highest: BOTS_ROLE } },
    { id: 'b2', user: { bot: true, tag: 'Carl-bot#1536' }, roles: { highest: BOTS_ROLE } },
  ],
});
const s2 = roleStanding(shared);
check('level is not above, so both are out of reach',
  s2.unreachable, ['Dyno#3861', 'Carl-bot#1536']);
check('it is flagged as sharing a role', s2.sharing, true);
check('and the standing is not ok', s2.ok, false);
check('no bot role sits above it, which is why > would have missed this',
  s2.botRolesAtOrAbove, []);

console.log('\n- given its own role above the bots role -');
const fixed = makeGuild({
  myRole: { ...OWN, position: 69 },
  roles: [BOTS_ROLE, { id: 'r1', name: 'Admin', position: 90, managed: false }],
  bots: [
    { id: 'b1', user: { bot: true, tag: 'Dyno#3861' }, roles: { highest: BOTS_ROLE } },
    { id: 'b2', user: { bot: true, tag: 'Carl-bot#1536' }, roles: { highest: BOTS_ROLE } },
  ],
});
const s3 = roleStanding(fixed);
check('every bot is now reachable', s3.unreachable, []);
check('nothing is shared', s3.sharing, false);
check('so the standing is ok', s3.ok, true);

console.log('\n- a human role above changes nothing -');
const humans = makeGuild({
  myRole: { ...OWN, position: 10 },
  roles: [
    { id: 'r1', name: 'Admin', position: 30, managed: false },
    { id: 'r2', name: 'Moderator', position: 20, managed: false },
  ],
  bots: [{ id: 'b1', user: { bot: true, tag: 'Dyno#3861' }, roles: { highest: { id: 'r3', name: 'Dyno', position: 5 } } }],
});
const s4 = roleStanding(humans);
check('the bot below is reachable', s4.unreachable, []);
check('human roles above do not block removals', s4.ok, true);

console.log('\n- one bot out of reach is still a failure -');
const partial = makeGuild({
  myRole: { ...OWN, position: 10 },
  roles: [{ id: 'r2', name: 'Carl-bot', position: 12, managed: true }],
  bots: [
    { id: 'b1', user: { bot: true, tag: 'Carl-bot#1536' }, roles: { highest: { id: 'r2', name: 'Carl-bot', position: 12 } } },
    { id: 'b2', user: { bot: true, tag: 'Tickets#5105' }, roles: { highest: { id: 'r3', name: 'Tickets', position: 5 } } },
  ],
});
const s5 = roleStanding(partial);
check('only the one out of reach is listed', s5.unreachable, ['Carl-bot#1536']);
check('which is enough to fail', s5.ok, false);
check('and the role above is named', s5.botRolesAtOrAbove, ['Carl-bot']);

console.log('\n- BotApprove never counts itself -');
check('not among the unreachable', s2.unreachable.includes('BotApprove#3260'), false);
check('its own role is not listed above itself', s3.botRolesAtOrAbove.includes('BotApprove'), false);

console.log(`\n${failures ? `${failures} check(s) failed` : 'all checks passed'}\n`);
process.exit(failures ? 1 : 0);
