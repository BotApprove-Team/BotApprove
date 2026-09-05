#!/usr/bin/env node
/**
 * The setup guide sent when BotApprove is added to a server.
 *
 *   DATABASE_PATH=./data/welcome.db node scripts/welcome-check.js
 *
 * Discord refuses to let a bot remove a member whose highest role outranks its
 * own, and a newly added bot's role starts at the bottom. Getting this wrong
 * leaves a gate that reports success and removes nothing, so the guide has to
 * say where the role actually sits rather than offer generic advice.
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

// A stand-in guild: roleStanding only reads positions, names and the managed
// flag, and a real one needs a gateway connection.
const makeGuild = ({ myPosition, roles, bots = [] }) => {
  const mine = { id: 'r-me', name: 'BotApprove', position: myPosition, managed: true };
  const all = [mine, ...roles];
  const collection = {
    get size() { return all.length; },
    values: () => all.values(),
    filter: (fn) => {
      const kept = all.filter(fn);
      return { size: kept.length, values: () => kept.values() };
    },
  };
  const members = [
    { id: 'me', user: { bot: true, tag: 'BotApprove#3260' }, roles: { highest: mine } },
    ...bots,
  ];
  return {
    members: {
      me: { id: 'me', roles: { highest: mine } },
      cache: {
        filter: (fn) => ({ map: (m) => members.filter(fn).map(m) }),
      },
    },
    roles: { cache: collection },
  };
};

console.log('\n- a fresh join, role at the bottom -');
const fresh = makeGuild({
  myPosition: 1,
  roles: [
    { id: 'r1', name: 'Admin', position: 30, managed: false },
    { id: 'r2', name: 'Dyno', position: 20, managed: true },
    { id: 'r3', name: 'MEE6', position: 18, managed: true },
  ],
  bots: [
    { id: 'b1', user: { bot: true, tag: 'Dyno#3861' }, roles: { highest: { position: 20 } } },
    { id: 'b2', user: { bot: true, tag: 'MEE6#4876' }, roles: { highest: { position: 18 } } },
  ],
});
const s1 = roleStanding(fresh);
check('the role position is reported', s1.position, 1);
check('bot roles above are found', s1.botRolesAbove, ['Dyno', 'MEE6']);
check('and it is not ok', s1.ok, false);
check('the bots it cannot remove are named', s1.ungateable, ['Dyno#3861', 'MEE6#4876']);

console.log('\n- after the role is dragged above the bots -');
const fixed = makeGuild({
  myPosition: 25,
  roles: [
    { id: 'r1', name: 'Admin', position: 30, managed: false },
    { id: 'r2', name: 'Dyno', position: 20, managed: true },
    { id: 'r3', name: 'MEE6', position: 18, managed: true },
  ],
  bots: [
    { id: 'b1', user: { bot: true, tag: 'Dyno#3861' }, roles: { highest: { position: 20 } } },
    { id: 'b2', user: { bot: true, tag: 'MEE6#4876' }, roles: { highest: { position: 18 } } },
  ],
});
const s2 = roleStanding(fixed);
check('no bot role outranks it', s2.botRolesAbove, []);
check('nothing is out of reach', s2.ungateable, []);
check('so the standing is ok', s2.ok, true);

console.log('\n- a human role above is not a problem -');
// Our own managed role means human roles above do not stop us removing bots.
const humansAbove = makeGuild({
  myPosition: 10,
  roles: [
    { id: 'r1', name: 'Admin', position: 30, managed: false },
    { id: 'r2', name: 'Moderator', position: 20, managed: false },
  ],
});
const s3 = roleStanding(humansAbove);
check('human roles are not counted as bot roles', s3.botRolesAbove, []);
check('and the standing is ok', s3.ok, true);

console.log('\n- one bot above is still a problem -');
const onePartial = makeGuild({
  myPosition: 10,
  roles: [
    { id: 'r2', name: 'Carl-bot', position: 12, managed: true },
    { id: 'r3', name: 'Tickets', position: 5, managed: true },
  ],
  bots: [
    { id: 'b1', user: { bot: true, tag: 'Carl-bot#1536' }, roles: { highest: { position: 12 } } },
    { id: 'b2', user: { bot: true, tag: 'Tickets#5105' }, roles: { highest: { position: 5 } } },
  ],
});
const s4 = roleStanding(onePartial);
check('only the one above is listed', s4.botRolesAbove, ['Carl-bot']);
check('only that bot is out of reach', s4.ungateable, ['Carl-bot#1536']);
check('and that is enough to not be ok', s4.ok, false);

console.log('\n- BotApprove never counts itself -');
check('its own managed role is excluded', s2.botRolesAbove.includes('BotApprove'), false);
check('and it is not listed as out of reach', s1.ungateable.includes('BotApprove#3260'), false);

console.log(`\n${failures ? `${failures} check(s) failed` : 'all checks passed'}\n`);
process.exit(failures ? 1 : 0);
