#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';

if (!process.env.DATABASE_PATH) {
  console.error('Refusing to run against the default database. Set DATABASE_PATH.');
  process.exit(1);
}
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(config.db.path + suffix, { force: true });
fs.mkdirSync(path.dirname(config.db.path), { recursive: true });

const { db } = await import('../src/db/index.js');
const erasure = await import('../src/services/erasureService.js');

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}`
    + (ok ? '' : `\n         expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`));
};

const G = '100000000000000001';
const OTHER = '100000000000000002';
const U = '200000000000000001';
const V = '200000000000000002';

console.log('\n- every table and ID column is accounted for -');
const userCols = new Set(erasure.USER_COLUMNS.flatMap(([t, c, tag]) => [`${t}.${c}`, tag && `${t}.${tag}`]).filter(Boolean));
const textCols = new Set(erasure.textColumns().map(([t, c]) => `${t}.${c}`));
const retained = new Set(erasure.RETAINED.map(([t, c]) => `${t}.${c}`));
const looksLikeId = (c) => /(_id|_by|_tag)$/.test(c);

const unaccounted = [];
const guildTablesMissing = [];
for (const { table, columns } of erasure.schema()) {
  if (columns.includes('guild_id') && !erasure.SERVER_TABLES.includes(table)) guildTablesMissing.push(table);
  for (const c of columns) {
    const key = `${table}.${c}`;
    if (!looksLikeId(c)) continue;
    if (erasure.NOT_PERSONAL.has(c) || userCols.has(key) || textCols.has(key) || retained.has(key)) continue;
    unaccounted.push(key);
  }
}
check('every table with a guild_id is erased with the server', guildTablesMissing, []);
check('every ID column is erased, scrubbed, kept on purpose or not personal', unaccounted, []);
const tables = new Set(erasure.schema().map((s) => s.table));
check('every table the plan names exists',
  [...erasure.SERVER_TABLES, ...erasure.USER_COLUMNS.map(([t]) => t)].filter((t) => !tables.has(t)), []);
check('deleted rows are overwritten, not just unlinked', db.pragma('secure_delete', { simple: true }), 1);

// One row per table, filling whatever the schema insists on. Text gets a
// counter so unique columns never collide between test rows.
let seq = 0;
function fill(table, overrides) {
  const cols = db.prepare(`PRAGMA table_info("${table}")`).all();
  const single = cols.filter((c) => c.pk).length === 1;
  const row = {};
  for (const c of cols) {
    if (c.name in overrides) { row[c.name] = overrides[c.name]; continue; }
    if (c.pk && single && /INT/i.test(c.type)) continue;
    if (c.notnull && c.dflt_value === null) row[c.name] = /INT|REAL/i.test(c.type) ? 1 : `x-${c.name}-${seq += 1}`;
  }
  const keys = Object.keys(row);
  db.prepare(`INSERT INTO "${table}" (${keys.map((k) => `"${k}"`).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
    .run(...keys.map((k) => row[k]));
}

console.log('\n- a server erase leaves nothing of that server, and only that server -');
for (const t of erasure.SERVER_TABLES) {
  fill(t, { guild_id: G });
  fill(t, { guild_id: OTHER });
}
const pending = db.prepare('SELECT id FROM pending_approvals WHERE guild_id = ?').get(G).id;
fill('approval_votes', { pending_id: pending, voter_id: V });
const before = erasure.serverRows(G);
check('every server table had a row to remove', erasure.SERVER_TABLES.filter((t) => !before[t]), []);
const server = erasure.eraseServer(G);
check('nothing of that server is left', server.left, 0);
check('including the votes on its approvals', erasure.serverRows(G).approval_votes, 0);
check('another server is untouched', erasure.SERVER_TABLES.filter((t) =>
  db.prepare(`SELECT COUNT(*) n FROM "${t}" WHERE guild_id = ?`).get(OTHER).n !== 1), []);

console.log('\n- a person erase leaves nothing that names them -');
let spare = 300000000000000000n;
const another = () => String(spare += 1n);
for (const [t, col, tag] of erasure.USER_COLUMNS) {
  fill(t, { guild_id: another(), [col]: U, ...(tag ? { [tag]: 'someone#0001' } : {}) });
  fill(t, { guild_id: another(), [col]: V });
}
db.prepare('UPDATE security_log SET detail = ? WHERE actor_id = ?').run(JSON.stringify({ inviter: U }), V);
db.prepare('INSERT INTO web_sessions (sid, data, expires_at) VALUES (?, ?, ?)')
  .run('s1', JSON.stringify({ user: { id: U } }), Date.now() + 1000);
db.prepare('INSERT INTO web_sessions (sid, data, expires_at) VALUES (?, ?, ?)')
  .run('s2', JSON.stringify({ user: { id: V } }), Date.now() + 1000);
db.prepare('UPDATE guild_config SET owner_id = ? WHERE guild_id = ?').run(U, OTHER);
const LEFT = '100000000000000003';
fill('guild_config', { guild_id: LEFT, owner_id: U });
db.prepare('UPDATE known_nuke_bots SET reason = ? WHERE added_by = ?').run(`seen with ${U}`, V);
db.prepare("UPDATE license_keys SET note = ? WHERE created_by = ?").run(`for ${U}`, V);

const person = erasure.eraseUser(U, { present: (g) => g !== LEFT });
check('something was found and changed', person.changed > 0, true);
check('checked again afterwards, nothing names them', person.left, 0);
check('their name went with their ID', db.prepare("SELECT COUNT(*) n FROM external_app_events WHERE actor_tag = 'someone#0001'").get().n, 0);
check('the record a server relies on stays, without them',
  db.prepare("SELECT COUNT(*) n FROM whitelist WHERE approved_by = 'erased'").get().n, 1);
check('their own vote is gone rather than renamed',
  db.prepare('SELECT COUNT(*) n FROM approval_votes WHERE voter_id IN (?, ?)').get(U, 'erased').n, 0);
check('their ID is scrubbed out of log details',
  db.prepare('SELECT detail FROM security_log WHERE actor_id = ?').get(V).detail.includes(U), false);
check('their sessions are deleted', db.prepare("SELECT sid FROM web_sessions").all().map((r) => r.sid), ['s2']);
check('free text nobody listed is scrubbed too', [
  db.prepare('SELECT reason FROM known_nuke_bots WHERE added_by = ?').get(V).reason,
  db.prepare('SELECT note FROM license_keys WHERE created_by = ?').get(V).note,
], ['seen with erased', 'for erased']);
check('the count afterwards reads every column, not the plan', (() => {
  db.prepare('UPDATE giveaways SET winners = ? WHERE created_by = ?').run(BigInt(U), V);
  const n = Object.values(erasure.anywhere(U)).reduce((a, b) => a + b, 0);
  db.prepare('UPDATE giveaways SET winners = 1 WHERE created_by = ?').run(V);
  return n;
})(), 1);
check('ownership of a server the bot is in is kept and explained', person.retained.map((r) => [r.where, r.rows]), [['guild_config.owner_id', 1]]);
check('ownership of a server the bot has left is cleared',
  db.prepare('SELECT owner_id FROM guild_config WHERE guild_id = ?').get(LEFT).owner_id, null);
check('someone else is untouched', erasure.USER_COLUMNS.filter(([t, col]) =>
  db.prepare(`SELECT COUNT(*) n FROM "${t}" WHERE "${col}" = ?`).get(V).n < 1).map(([t, c]) => `${t}.${c}`), []);
check('a second erase finds nothing', erasure.eraseUser(U).changed, 0);
check('it refuses something that is not a user id', (() => { try { erasure.eraseUser("1' OR '1'='1"); return 'ran'; } catch { return 'refused'; } })(), 'refused');

console.log('\n- /uninstall waits while an attack is being handled -');
const H = '100000000000000003';
check('a quiet server can be uninstalled', erasure.inProgress(H), []);
fill('lockdown_state', { guild_id: H, active: 1 });
check('not during a lockdown', erasure.inProgress(H).length, 1);
db.prepare('UPDATE lockdown_state SET active = 0 WHERE guild_id = ?').run(H);
fill('nuke_incidents', { guild_id: H, resolution: 'pending', created_at: Date.now() });
check('nor with a nuke bot incident open', erasure.inProgress(H), ['1 nuke bot incident is still open']);
db.prepare("UPDATE nuke_incidents SET resolution = 'kicked' WHERE guild_id = ?").run(H);
fill('tamper_responses', { guild_id: H, roles_removed: '["300000000000000001"]', created_at: Date.now() });
check('nor with roles from a tamper response still to give back', erasure.inProgress(H).length, 1);
db.prepare('UPDATE tamper_responses SET restored_at = ? WHERE guild_id = ?').run(Date.now(), H);
check('once it is all dealt with, it can go', erasure.inProgress(H), []);
fill('nuke_incidents', { guild_id: H, resolution: 'pending', created_at: Date.now() - 3 * 86_400_000 });
check('an incident left open days ago does not block it forever', erasure.inProgress(H), []);

console.log('\n- nobody reads it as wiping the server -');
const { commandDefinitions } = await import('../src/bot/commands/index.js');
const byName = (n) => commandDefinitions.find((c) => c.name === n);
check('/erase is only about the person running it', byName('erase').options.map((o) => o.name), ['me']);
check('/uninstall is hidden from anyone without Administrator', byName('uninstall').default_member_permissions, '8');
check('and only offered inside a server', byName('uninstall').contexts, [0]);

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
