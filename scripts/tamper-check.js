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

const { guildConfig, tamperResponses } = await import('../src/db/queries.js');
const { respond, removableRoles, restore } = await import('../src/services/tamperResponse.js');

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}` +
    (ok ? '' : `\n         expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`));
};

const OWNER = 'owner-1';
let removed = [];

function makeGuild({ id, mode = 'strip', myPosition = 50, actorRoles = [], canManageRoles = true }) {
  guildConfig.ensure(id);
  guildConfig.set(id, { tamper_response: mode, log_channel_id: null, notify_channel_id: null });

  const roles = new Map(actorRoles.map((r) => [r.id, { ...r, guild: null }]));

  const member = {
    id: 'actor-1',
    roles: {
      cache: { values: () => roles.values(), has: (rid) => roles.has(rid) },
      remove: async (role) => {
        if (!canManageRoles) throw new Error('Missing Permissions');
        removed.push(role.id);
        roles.delete(role.id);
      },
    },
  };

  const guild = {
    id,
    ownerId: OWNER,
    members: {
      me: {
        id: 'me',
        roles: { highest: { id: 'ba', position: myPosition } },
        permissions: { has: () => canManageRoles },
      },
      cache: new Map([['actor-1', member]]),
      fetch: async (uid) => (uid === 'actor-1' ? member : null),
      fetchMe: async () => guild.members.me,
    },
    channels: { fetch: async () => null },
    roles: { cache: new Map(roles) },
  };
  for (const r of roles.values()) r.guild = guild;
  member.guild = guild;
  return guild;
}

const role = (id, position, extra = {}) => ({ id, position, name: id, managed: false, ...extra });

console.log('\n- who is never acted against -');
removed = [];
const g1 = makeGuild({ id: 'g1', actorRoles: [role('r1', 10)] });
const asOwner = await respond(g1, { trigger: 'role_position', actor: { id: OWNER, tag: 'own#1' } });
check('the server owner is exempt', asOwner.outcome, 'owner_exempt');
check('and keeps every role', removed, []);

removed = [];
const g2 = makeGuild({ id: 'g2', actorRoles: [role('r2', 10)] });
const asSelf = await respond(g2, { trigger: 'role_position', actor: { id: 'me', tag: 'self' } });
check('our own edits are not an attack', asSelf.outcome, 'self_inflicted');
check('and take nothing', removed, []);

removed = [];
const g3 = makeGuild({ id: 'g3', actorRoles: [role('r3', 10)] });
const unknown = await respond(g3, { trigger: 'role_position', actor: null });
check('an unattributed change is still reported', unknown.outcome, 'actor_unknown');
check('but nobody is stripped for it', removed, []);

console.log('\n- reach -');
removed = [];
const above = makeGuild({ id: 'g4', myPosition: 20, actorRoles: [role('hi', 30), role('lo', 10)] });
const outranked = await respond(above, { trigger: 'role_position', actor: { id: 'actor-1', tag: 'a#1' } });

check('a role below ours is taken', removed, ['lo']);
check('the one above it is left alone', outranked.removed, 1);

removed = [];
const equal = makeGuild({ id: 'g5', myPosition: 20, actorRoles: [role('same', 20)] });
const level = await respond(equal, { trigger: 'role_position', actor: { id: 'actor-1', tag: 'a#1' } });
check('a role level with ours is out of reach', level.outcome, 'unreachable');
check('and nothing is removed', removed, []);

removed = [];
const managed = makeGuild({ id: 'g6', actorRoles: [role('int', 10, { managed: true })] });
const bot = await respond(managed, { trigger: 'role_position', actor: { id: 'actor-1', tag: 'a#1' } });
check('an integration role cannot be removed', bot.outcome, 'unreachable');

removed = [];
const everyone = makeGuild({ id: 'g7', actorRoles: [role('g7', 0)] });
const base = await respond(everyone, { trigger: 'role_position', actor: { id: 'actor-1', tag: 'a#1' } });
check('@everyone is never removed', base.outcome, 'unreachable');

console.log('\n- the mode decides how far it goes -');
removed = [];
const off = makeGuild({ id: 'g8', mode: 'off', actorRoles: [role('r8', 10)] });
check('off does nothing',
  (await respond(off, { trigger: 'role_position', actor: { id: 'actor-1', tag: 'a#1' } })).outcome,
  'disabled');
check('and takes no roles', removed, []);

removed = [];
const defend = makeGuild({ id: 'g9', mode: 'defend', actorRoles: [role('r9', 10)] });
check('defend reports only',
  (await respond(defend, { trigger: 'role_position', actor: { id: 'actor-1', tag: 'a#1' } })).outcome,
  'reported');
check('and takes no roles', removed, []);

removed = [];
const strip = makeGuild({ id: 'g10', mode: 'strip', actorRoles: [role('r10', 10)] });
check('strip acts',
  (await respond(strip, { trigger: 'role_position', actor: { id: 'actor-1', tag: 'a#1' } })).outcome,
  'stripped');
check('and takes the role', removed, ['r10']);

console.log('\n- missing permission -');
removed = [];
const noPerm = makeGuild({ id: 'g11', actorRoles: [role('r11', 10)], canManageRoles: false });
check('without Manage Roles it says so',
  (await respond(noPerm, { trigger: 'role_position', actor: { id: 'actor-1', tag: 'a#1' } })).outcome,
  'no_permission');

console.log('\n- the circuit breaker -');

const outcomes = [];
for (let i = 0; i < 5; i += 1) {
  removed = [];
  const g = makeGuild({ id: 'g12', actorRoles: [role(`b${i}`, 10)] });
  outcomes.push((await respond(g, { trigger: 'role_position', actor: { id: 'actor-1', tag: 'a#1' } })).outcome);
}
check('the first three act', outcomes.slice(0, 3), ['stripped', 'stripped', 'stripped']);
check('then it stops itself', outcomes.slice(3), ['breaker_open', 'breaker_open']);

console.log('\n- everything is written down -');
const rows = tamperResponses.recent('g10');
check('the strip was recorded', rows.length, 1);
check('with the role it took', JSON.parse(rows[0].roles_removed).map((r) => r.id), ['r10']);
check('and it is restorable', tamperResponses.restorable('g10', 'actor-1').length, 1);

console.log('\n- and can be handed back -');
const back = makeGuild({ id: 'g10', actorRoles: [] });
back.roles.cache.set('r10', role('r10', 10));
const added = [];
back.members.fetch = async () => ({ roles: { add: async (id) => { added.push(id); } } });
const undo = await restore(back, 'actor-1');
check('the role is given back', added, ['r10']);
check('once', undo.restored, 1);
check('and is not restorable twice', tamperResponses.restorable('g10', 'actor-1').length, 0);

console.log('\n- removableRoles is the whole reach rule -');
const me = { roles: { highest: { position: 20 } } };
const mk = (roles) => ({
  guild: { id: 'gx' },
  roles: { cache: { values: () => roles.values() } },
});
const set = new Map([
  ['gx', role('gx', 0)],
  ['low', role('low', 5)],
  ['high', role('high', 25)],
  ['managed', role('managed', 5, { managed: true })],
  ['level', role('level', 20)],
]);
check('only the reachable, unmanaged, non-default role',
  removableRoles(me, mk(set)).map((r) => r.id), ['low']);

console.log(`\n${failures ? `${failures} check(s) failed` : 'all checks passed'}\n`);
process.exit(failures ? 1 : 0);
