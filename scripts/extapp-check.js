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

const { guildConfig, externalAppEvents, externalAppRules } = await import('../src/db/queries.js');
const { onExternalAppMessage, fromUserInstalledApp } =
  await import('../src/services/externalAppGuard.js');

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}` +
    (ok ? '' : `\n         expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`));
};

const OWNER = 'owner-1';
let acted = [];

function makeMessage({
  guildId, actorId = 'raider-1', userInstalled = true, guildInstalled = false,
  action = 'report', burst = 3, canDelete = true, canModerate = true, actorPosition = 5,
  mePosition = 50,
}) {
  guildConfig.ensure(guildId);
  guildConfig.set(guildId, {
    external_app_action: action,
    external_app_burst: burst,
    external_app_window_s: 15,
    log_channel_id: null,
    notify_channel_id: null,
  });

  const member = {
    id: actorId,
    roles: {
      highest: {
        position: actorPosition,
        comparePositionTo: (o) => actorPosition - o.position,
      },
    },
    timeout: async () => { acted.push('timeout'); },
    kick: async () => { acted.push('kick'); },
  };

  const me = {
    permissions: { has: () => canDelete && canModerate },
    roles: {
      highest: {
        position: mePosition,
        comparePositionTo: (o) => mePosition - o.position,
      },
    },
  };

  const guild = {
    id: guildId,
    ownerId: OWNER,
    members: {
      me,
      cache: new Map([[actorId, member]]),
      fetch: async (id) => (id === actorId ? member : null),
    },
    channels: { fetch: async () => null },
    bans: { create: async () => { acted.push('ban'); } },
  };

  const owners = {};
  if (userInstalled) owners.userId = actorId;
  else owners.userId = null;
  owners.guildId = guildInstalled ? guildId : null;

  return {
    id: 'm-' + Math.random().toString(36).slice(2),
    guild,
    channelId: 'c1',
    applicationId: 'app-1',
    interactionMetadata: {
      user: { id: actorId, tag: 'raider#1' },
      authorizingIntegrationOwners: owners,
    },
    delete: async () => {
      if (!canDelete) throw new Error('no perms');
      acted.push('delete');
    },
  };
}

console.log('\n- telling a user app from a server app -');
check('a user-installed app is caught',
  !!fromUserInstalledApp(makeMessage({ guildId: 'a1' })), true);
check('a server-installed app is not',
  fromUserInstalledApp(makeMessage({ guildId: 'a2', guildInstalled: true })), null);
check('an ordinary message is not',
  fromUserInstalledApp({ interactionMetadata: null }), null);

console.log('\n- off means off -');
acted = [];
check('nothing happens',
  (await onExternalAppMessage(makeMessage({ guildId: 'g-off', action: 'off' }))).outcome,
  'disabled');
check('and nothing is done', acted, []);
check('and nothing is recorded', externalAppEvents.recent('g-off').length, 0);

console.log('\n- report leaves the message up -');
acted = [];
const rep = await onExternalAppMessage(makeMessage({ guildId: 'g-rep', action: 'report' }));
check('reported', rep.outcome, 'reported');
check('nothing deleted', acted, []);
check('but it is recorded', externalAppEvents.recent('g-rep').length, 1);

console.log('\n- delete acts on the first message -');
acted = [];
const del = await onExternalAppMessage(makeMessage({ guildId: 'g-del', action: 'delete' }));
check('deleted', del.outcome, 'deleted');
check('the message went', acted, ['delete']);

console.log('\n- a single use never gets someone banned -');
acted = [];
const one = await onExternalAppMessage(makeMessage({ guildId: 'g-one', action: 'ban', burst: 3 }));
check('the message is still deleted', acted, ['delete']);
check('but the person is untouched', one.outcome, 'below_burst');

console.log('\n- a burst does -');
acted = [];
let last = null;
for (let i = 0; i < 3; i += 1) {
  last = await onExternalAppMessage(makeMessage({ guildId: 'g-burst', action: 'ban', burst: 3 }));
}
check('the third one acts', last.outcome, 'ban');
check('deleting each time, banning once', acted, ['delete', 'delete', 'delete', 'ban']);

console.log('\n- each rung of the ladder -');
for (const [mode, expected] of [['timeout', 'timeout'], ['kick', 'kick']]) {
  acted = [];
  let r = null;
  for (let i = 0; i < 3; i += 1) {
    r = await onExternalAppMessage(makeMessage({ guildId: `g-${mode}`, action: mode, burst: 3 }));
  }
  check(`${mode} reaches ${expected}`, r.outcome, expected);
  check(`and ${mode} was the action taken`, acted[acted.length - 1], expected);
}

console.log('\n- who is never acted against -');
acted = [];
let asOwner = null;
for (let i = 0; i < 3; i += 1) {
  asOwner = await onExternalAppMessage(
    makeMessage({ guildId: 'g-owner', actorId: OWNER, action: 'ban', burst: 3 }),
  );
}
check('the server owner is exempt', asOwner.outcome, 'owner_exempt');
check('though the message is still removed', acted.every((a) => a === 'delete'), true);

acted = [];
let above = null;
for (let i = 0; i < 3; i += 1) {
  above = await onExternalAppMessage(
    makeMessage({ guildId: 'g-above', action: 'ban', burst: 3, actorPosition: 90 }),
  );
}
check('someone outranking BotApprove is out of reach', above.outcome, 'unreachable');
check('no ban was attempted', acted.includes('ban'), false);

console.log('\n- the circuit breaker -');
acted = [];
const outcomes = [];
for (let i = 0; i < 21; i += 1) {
  const r = await onExternalAppMessage(
    makeMessage({ guildId: 'g-breaker', action: 'kick', burst: 1 }),
  );
  outcomes.push(r.outcome);
}
check('the first five act', outcomes.slice(0, 5), ['kick', 'kick', 'kick', 'kick', 'kick']);
check('then it stands down', outcomes[5], 'breaker_open');
check('and stays down', outcomes[20], 'breaker_open');

console.log('\n- per-app rules -');
acted = [];
externalAppRules.set({ guildId: 'g-block', appId: 'app-1', rule: 'block', addedBy: 'u1' });
const blocked = await onExternalAppMessage(
  makeMessage({ guildId: 'g-block', action: 'ban', burst: 5 }),
);
check('a blocked app skips the burst wait', blocked.outcome, 'ban');
check('on the very first message', acted, ['delete', 'ban']);

acted = [];
externalAppRules.set({ guildId: 'g-allow', appId: 'app-1', rule: 'allow', addedBy: 'u1' });
const allowed = await onExternalAppMessage(
  makeMessage({ guildId: 'g-allow', action: 'ban', burst: 1 }),
);
check('an allowed app is ignored entirely', allowed.outcome, 'allowed_app');
check('nothing is done to it', acted, []);
check('and nothing is recorded', externalAppEvents.recent('g-allow').length, 0);

acted = [];
externalAppRules.set({ guildId: 'g-blockoff', appId: 'app-1', rule: 'block', addedBy: 'u1' });
const evenOff = await onExternalAppMessage(
  makeMessage({ guildId: 'g-blockoff', action: 'off', burst: 1 }),
);
check('a blocked app is still removed with the guard off', evenOff.deleted, true);
check('though nobody is punished for it', evenOff.outcome, 'deleted');

acted = [];
externalAppRules.remove('g-block', 'app-1');
const unblocked = await onExternalAppMessage(
  makeMessage({ guildId: 'g-block2', action: 'ban', burst: 5 }),
);
check('removing the rule restores the burst wait', unblocked.outcome, 'below_burst');


console.log(`\n${failures ? `${failures} check(s) failed` : 'all checks passed'}\n`);
process.exit(failures ? 1 : 0);
