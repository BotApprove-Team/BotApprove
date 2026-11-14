/**
 * Erasure, for /erase. Built so that "deleted" means deleted.
 *
 * A server erase removes every row that belongs to that server. A user erase
 * takes the person out of every record: where a row exists only because of
 * them it goes, and where another server relies on the record (who approved a
 * bot, who confirmed a nuke bot) the ID is replaced with "erased" so the event
 * stays and the person does not.
 *
 * Both finish by counting again and returning what is left, which should be
 * nothing. For a person that count reads every column of every table, not the
 * lists below, so a place nobody listed still shows up. scripts/erase-check.js
 * fails when a migration adds a table or an ID column this file does not
 * account for. That is the part that keeps it honest later.
 */
import { db } from '../db/index.js';

export const ERASED = 'erased';

// Every table with a row per server. Deleted outright by a server erase.
export const SERVER_TABLES = [
  'announcement_targets', 'approver_roles', 'bot_permission_state', 'entitlements',
  'external_app_events', 'external_app_rules', 'giveaway_entries', 'giveaway_winners',
  'guild_config', 'guild_features', 'keyword_blocklist', 'license_redemptions',
  'lockdown_state', 'nuke_db_requests', 'nuke_incidents', 'nuke_registry', 'pending_approvals',
  'pending_reinvite_token', 'removal_events', 'security_log', 'self_check_state',
  'tamper_responses', 'terms_acceptances', 'webhook_events', 'whitelist',
];

// Every column that can hold a person's Discord ID, with the name column that
// travels with it.
export const USER_COLUMNS = [
  ['announcements', 'sent_by'],
  ['approval_votes', 'voter_id'],
  ['blog_posts', 'author_id'],
  ['external_app_events', 'actor_id', 'actor_tag'],
  ['external_app_rules', 'added_by'],
  ['giveaway_entries', 'entered_by'],
  ['giveaways', 'created_by'],
  ['guild_features', 'updated_by'],
  ['keyword_blocklist', 'added_by'],
  ['known_nuke_bots', 'added_by'],
  ['license_keys', 'created_by'],
  ['license_redemptions', 'redeemed_by'],
  ['lockdown_state', 'started_by'],
  ['nuke_db_requests', 'requested_by', 'requested_by_tag'],
  ['nuke_db_requests', 'reviewed_by'],
  ['nuke_incidents', 'inviter_id', 'inviter_tag'],
  ['nuke_incidents', 'resolved_by'],
  ['nuke_registry', 'confirmed_by'],
  ['pending_approvals', 'added_by'],
  ['pending_approvals', 'resolved_by'],
  ['pending_reinvite_token', 'issued_by'],
  ['removal_events', 'actor_id', 'actor_tag'],
  ['removal_events', 'owner_id'],
  ['security_log', 'actor_id'],
  ['tamper_responses', 'actor_id', 'actor_tag'],
  ['terms_acceptances', 'user_id'],
  ['webhook_events', 'actor_id', 'actor_tag'],
  ['whitelist', 'approved_by'],
];

// Kept on purpose while it is doing a job, and said so to the person asking.
export const RETAINED = [
  ['guild_config', 'owner_id', 'You own a server BotApprove is still in, and this is how its '
    + 'alerts reach you. It is read from Discord again whenever the bot starts, so erasing it here '
    + 'would not last. Run /uninstall there. Or remove the bot, then run /erase me again, and '
    + 'it goes.'],
];

// Columns whose names look like IDs but hold no person: servers, bots, roles,
// channels, messages, apps, keys, and the Stripe customer, which is removed
// with the server's entitlement and cannot be traced from a Discord ID.
export const NOT_PERSONAL = new Set([
  'guild_id', 'bot_id', 'bot_tag', 'role_id', 'channel_id', 'message_id', 'app_id', 'webhook_id',
  'notify_channel_id', 'log_channel_id', 'announce_channel_id', 'quarantine_role_id',
  'report_channel_id', 'pending_id', 'giveaway_id', 'announcement_id', 'key_hash', 'event_id',
  'external_id', 'id', 'feature_key',
]);

const quoteId = (s) => `"${String(s).replace(/"/g, '""')}"`;

function keyColumns(table) {
  const keys = new Set(db.prepare(`PRAGMA table_info(${quoteId(table)})`).all()
    .filter((c) => c.pk > 0).map((c) => c.name));
  for (const idx of db.prepare(`PRAGMA index_list(${quoteId(table)})`).all()) {
    if (!idx.unique) continue;
    for (const c of db.prepare(`PRAGMA index_info(${quoteId(idx.name)})`).all()) keys.add(c.name);
  }
  return keys;
}

const count = (sql, ...args) => db.prepare(sql).get(...args).n;

const columnsOf = (table) => db.prepare(`PRAGMA table_info(${quoteId(table)})`).all();
const tableNames = () => db.prepare(
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
).all().map((r) => r.name);

// Free text and JSON, where an ID can turn up inside a sentence. Read from the
// schema instead of listed, so a column added later is scrubbed without anyone
// remembering to add it here: every text column that is not itself an ID.
export function textColumns() {
  const skip = new Set([
    ...USER_COLUMNS.flatMap(([t, c, tag]) => [`${t}.${c}`, tag && `${t}.${tag}`]),
    ...RETAINED.map(([t, c]) => `${t}.${c}`),
  ]);
  const out = [];
  for (const table of tableNames()) {
    if (table === 'web_sessions') continue;
    for (const c of columnsOf(table)) {
      if (c.type && !/CHAR|CLOB|TEXT/i.test(c.type)) continue;
      if (NOT_PERSONAL.has(c.name) || skip.has(`${table}.${c.name}`)) continue;
      out.push([table, c.name]);
    }
  }
  return out;
}

// The count afterwards: every column of every table, read as text. Nothing
// here comes from the lists above, so "none left" means the ID is nowhere in
// the database apart from what is kept on purpose and said so.
export function anywhere(userId) {
  const keep = new Set(RETAINED.map(([t, c]) => `${t}.${c}`));
  const found = {};
  for (const table of tableNames()) {
    const cols = columnsOf(table).map((c) => c.name).filter((c) => !keep.has(`${table}.${c}`));
    if (!cols.length) continue;
    const where = cols.map((c) => `CAST(${quoteId(c)} AS TEXT) LIKE ?`).join(' OR ');
    const n = count(`SELECT COUNT(*) n FROM ${quoteId(table)} WHERE ${where}`,
      ...cols.map(() => `%${userId}%`));
    if (n) found[table] = n;
  }
  return found;
}

export function serverRows(guildId) {
  const rows = {};
  rows.approval_votes = count(`SELECT COUNT(*) n FROM approval_votes WHERE pending_id IN
    (SELECT id FROM pending_approvals WHERE guild_id = ?)`, guildId);
  for (const t of SERVER_TABLES) {
    rows[t] = count(`SELECT COUNT(*) n FROM ${quoteId(t)} WHERE guild_id = ?`, guildId);
  }
  return rows;
}

const like = (id) => `%${id}%`;

export function userRows(userId) {
  const rows = {};
  for (const [t, col] of USER_COLUMNS) {
    const n = count(`SELECT COUNT(*) n FROM ${quoteId(t)} WHERE ${quoteId(col)} = ?`, userId);
    if (n) rows[`${t}.${col}`] = (rows[`${t}.${col}`] ?? 0) + n;
  }
  for (const [t, col] of textColumns()) {
    const n = count(`SELECT COUNT(*) n FROM ${quoteId(t)} WHERE ${quoteId(col)} LIKE ?`, like(userId));
    if (n) rows[`${t}.${col}`] = n;
  }
  const sessions = count('SELECT COUNT(*) n FROM web_sessions WHERE data LIKE ?', like(userId));
  if (sessions) rows['web_sessions'] = sessions;
  return rows;
}

// present(guildId) says whether the bot is still in a server. Ownership of one
// it has left does no job, and comes back from Discord if the bot ever rejoins.
export function releasable(userId, present = () => true) {
  return db.prepare('SELECT guild_id FROM guild_config WHERE owner_id = ?').all(String(userId))
    .map((r) => r.guild_id).filter((g) => !present(g));
}

export function retainedFor(userId, present = () => true) {
  const gone = releasable(userId, present).length;
  return RETAINED
    .map(([t, col, why]) => ({
      where: `${t}.${col}`,
      rows: count(`SELECT COUNT(*) n FROM ${quoteId(t)} WHERE ${quoteId(col)} = ?`, userId)
        - (t === 'guild_config' && col === 'owner_id' ? gone : 0),
      why,
    }))
    .filter((r) => r.rows);
}

const total = (rows) => Object.values(rows).reduce((a, b) => a + b, 0);

function settle() {
  // secure_delete overwrites the freed pages; the checkpoint pushes them out of
  // the write-ahead log, so the old rows do not survive in a side file either.
  db.pragma('wal_checkpoint(TRUNCATE)');
}

export function eraseServer(guildId) {
  const before = serverRows(guildId);
  db.transaction(() => {
    db.prepare(`DELETE FROM approval_votes WHERE pending_id IN
      (SELECT id FROM pending_approvals WHERE guild_id = ?)`).run(guildId);
    for (const t of SERVER_TABLES) db.prepare(`DELETE FROM ${quoteId(t)} WHERE guild_id = ?`).run(guildId);
  })();
  settle();
  const after = serverRows(guildId);
  return { removed: total(before), left: total(after), before, after };
}

export function eraseUser(userId, { present = () => true } = {}) {
  const id = String(userId);
  if (!/^\d{5,25}$/.test(id)) throw new Error('not a Discord user id');
  const before = userRows(id);
  const gone = releasable(id, present);
  if (gone.length) before['guild_config.owner_id'] = gone.length;

  db.transaction(() => {
    for (const g of gone) {
      db.prepare('UPDATE guild_config SET owner_id = NULL WHERE guild_id = ? AND owner_id = ?').run(g, id);
    }
    for (const [t, col, tagCol] of USER_COLUMNS) {
      // A column that is part of a key cannot all become "erased" without two
      // rows colliding, so those rows go instead. They are the person's own
      // entries anyway: their vote, their giveaway entry.
      if (keyColumns(t).has(col)) {
        db.prepare(`DELETE FROM ${quoteId(t)} WHERE ${quoteId(col)} = ?`).run(id);
        continue;
      }
      const sets = [`${quoteId(col)} = ?`];
      if (tagCol) sets.push(`${quoteId(tagCol)} = ?`);
      db.prepare(`UPDATE ${quoteId(t)} SET ${sets.join(', ')} WHERE ${quoteId(col)} = ?`)
        .run(...(tagCol ? [ERASED, ERASED] : [ERASED]), id);
    }
    for (const [t, col] of textColumns()) {
      db.prepare(`UPDATE ${quoteId(t)} SET ${quoteId(col)} = REPLACE(${quoteId(col)}, ?, ?)
        WHERE ${quoteId(col)} LIKE ?`).run(id, ERASED, like(id));
    }
    db.prepare('DELETE FROM web_sessions WHERE data LIKE ?').run(like(id));
  })();
  settle();

  const after = anywhere(id);
  return { changed: total(before), left: total(after), before, after, retained: retainedFor(id, present) };
}

// For a paying server, erasing the entitlement would leave Stripe charging for
// a licence that no longer exists here. Cancelling comes first.
export function activeSubscription(guildId) {
  const row = db.prepare('SELECT status, external_id FROM entitlements WHERE guild_id = ?').get(guildId);
  return !!row && String(row.external_id ?? '').startsWith('cus_')
    && ['active', 'trialing', 'past_due'].includes(row.status);
}

// What would be lost by uninstalling right now. A lockdown and a tamper
// response both store what BotApprove needs to put things back, and an open
// nuke incident is the record of an attack. Wiping those mid-attack is what
// someone who had taken over the owner account would want.
const DAY = 24 * 60 * 60 * 1000;
export function inProgress(guildId, now = Date.now()) {
  const out = [];
  if (db.prepare('SELECT 1 FROM lockdown_state WHERE guild_id = ? AND active = 1').get(guildId)) {
    out.push('the server is in lockdown, and BotApprove holds the permissions it has to put back');
  }
  const nukes = db.prepare(`SELECT COUNT(*) AS n FROM nuke_incidents
                             WHERE guild_id = ? AND resolution = 'pending' AND created_at >= ?`)
    .get(guildId, now - DAY).n;
  if (nukes) out.push(`${nukes} nuke bot incident${nukes === 1 ? ' is' : 's are'} still open`);
  const held = db.prepare(`SELECT COUNT(*) AS n FROM tamper_responses
                            WHERE guild_id = ? AND roles_removed IS NOT NULL
                              AND restored_at IS NULL AND created_at >= ?`)
    .get(guildId, now - DAY).n;
  if (held) {
    out.push(`roles taken in ${held} tamper response${held === 1 ? '' : 's'} today have not been given back`);
  }
  return out;
}

// Every table and column in the database, for the coverage check.
export function schema() {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map(({ name }) => ({
      table: name,
      columns: db.prepare(`PRAGMA table_info(${quoteId(name)})`).all().map((c) => c.name),
    }));
}
