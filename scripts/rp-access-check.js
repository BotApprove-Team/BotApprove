#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

if (!process.env.DATABASE_PATH) {
  console.error('Refusing to run against the default database. Set DATABASE_PATH.');
  process.exit(1);
}
const SECRET = 'shared-test-secret';
const OPERATOR = '200000000000000007';
process.env.RAIDPROTECTOR_TOKEN = SECRET;
process.env.OWNER_IDS = OPERATOR;

const RP_ONLY = '100000000000000001';
const MANAGER = '200000000000000001';
const MEMBER = '200000000000000002';

// A stand-in for RaidProtector: in one server, with one manager and one plain member.
const asked = [];
const rp = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    asked.push({ method: req.method, path: req.url, body: JSON.parse(raw || '{}') });
    const reply = (body) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const m = req.url.match(/^\/v1\/guild\/(\d+)\/member\/(\d+)$/);
    if (m) {
      if (m[1] !== RP_ONLY) return reply({ present: false });
      return reply({
        present: true,
        member: m[2] === MANAGER || m[2] === MEMBER,
        canConfigure: m[2] === MANAGER,
        guild: { id: RP_ONLY, name: 'raid only', icon: null, memberCount: 40 },
      });
    }
    return reply({ reversed: 1, cancelled: 1 });
  });
});
await new Promise((resolve) => rp.listen(0, '127.0.0.1', resolve));
process.env.RAIDPROTECTOR_URL = `http://127.0.0.1:${rp.address().port}`;

const { config } = await import('../src/config.js');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(config.db.path + suffix, { force: true });
fs.mkdirSync(path.dirname(config.db.path), { recursive: true });

const { resolveRpAccess } = await import('../src/web/auth.js');
const raidprotector = await import('../src/services/raidprotector.js');

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}`
    + (ok ? '' : `\n         expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`));
};

console.log('\n- a server with RaidProtector and no BotApprove -');
const mine = await resolveRpAccess(MANAGER, RP_ONLY);
check('its manager gets in', [mine.allowed, mine.rpOnly, mine.canConfigure], [true, true, true]);
check('with the server named for the page', mine.guild.name, 'raid only');
check('a member without Manage Server does not',
  (await resolveRpAccess(MEMBER, RP_ONLY)).reason, 'not_a_manager');
check('nor does someone who is not in it', (await resolveRpAccess('200000000000000003', RP_ONLY)).reason, 'not_a_member');
check('a server RaidProtector is not in is refused',
  (await resolveRpAccess(MANAGER, '100000000000000002')).reason, 'rp_not_in_guild');
check('something that is not a server id never reaches RaidProtector', [
  (await resolveRpAccess(MANAGER, '../../v1/access')).reason,
  asked.some((a) => a.path.includes('..')),
], ['rp_not_in_guild', false]);
check('the operator gets in only once unlocked', [
  (await resolveRpAccess(OPERATOR, RP_ONLY)).allowed,
  (await resolveRpAccess(OPERATOR, RP_ONLY, { elevated: true })).via,
], [false, 'instance_owner']);

console.log('\n- incidents are sent with the server they were checked against -');
asked.length = 0;
await raidprotector.undoIncident(RP_ONLY, 5, MANAGER);
await raidprotector.cancelBans(RP_ONLY, 6, MANAGER);
check('undo names the server', asked[0].body, { guildId: RP_ONLY, actorId: MANAGER });
check('so does cancelling bans', asked[1].body, { guildId: RP_ONLY, actorId: MANAGER });

console.log('\n- when RaidProtector is down, nobody gets in on a guess -');
rp.closeAllConnections();
await new Promise((resolve) => rp.close(resolve));
check('it is refused, and says why', (await resolveRpAccess(MANAGER, RP_ONLY)).reason, 'rp_unreachable');

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exitCode = failures ? 1 : 0;
