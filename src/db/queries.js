import { db } from './index.js';
import { config } from '../config.js';

const cache = new Map();
const q = (sql) => {
  let stmt = cache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    cache.set(sql, stmt);
  }
  return stmt;
};

export const whitelist = {
  get: (guildId, botId) =>
    q('SELECT * FROM whitelist WHERE guild_id = ? AND bot_id = ?').get(guildId, botId),
  has: (guildId, botId) =>
    !!q('SELECT 1 FROM whitelist WHERE guild_id = ? AND bot_id = ?').get(guildId, botId),
  add: (guildId, botId, approvedBy) =>
    q(`INSERT INTO whitelist (guild_id, bot_id, approved_by, approved_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(guild_id, bot_id) DO UPDATE SET
         approved_by = excluded.approved_by,
         approved_at = excluded.approved_at`).run(guildId, botId, approvedBy, Date.now()),
  remove: (guildId, botId) =>
    q('DELETE FROM whitelist WHERE guild_id = ? AND bot_id = ?').run(guildId, botId),
  list: (guildId) =>
    q('SELECT * FROM whitelist WHERE guild_id = ? ORDER BY approved_at DESC').all(guildId),
};

export const approverRoles = {
  list: (guildId) =>
    q('SELECT role_id FROM approver_roles WHERE guild_id = ?').all(guildId).map((r) => r.role_id),
  add: (guildId, roleId) =>
    q('INSERT OR IGNORE INTO approver_roles (guild_id, role_id) VALUES (?, ?)').run(guildId, roleId),
  remove: (guildId, roleId) =>
    q('DELETE FROM approver_roles WHERE guild_id = ? AND role_id = ?').run(guildId, roleId),
};

export const pendingApprovals = {
  create: ({ guildId, botId, botTag, addedBy, keywordMatched, tokenConsumed }) =>
    q(`INSERT INTO pending_approvals
        (guild_id, bot_id, bot_tag, added_by, keyword_matched, token_consumed, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`)
      .run(guildId, botId, botTag ?? null, addedBy ?? null, keywordMatched ?? null,
           tokenConsumed ? 1 : 0, Date.now()),
  attachMessage: (id, channelId, messageId) =>
    q('UPDATE pending_approvals SET channel_id = ?, message_id = ? WHERE id = ?')
      .run(channelId, messageId, id),
  setInviter: (id, userId) =>
    q('UPDATE pending_approvals SET added_by = ? WHERE id = ?').run(userId, id),
  byId: (id) => q('SELECT * FROM pending_approvals WHERE id = ?').get(id),
  byMessage: (messageId) =>
    q('SELECT * FROM pending_approvals WHERE message_id = ?').get(messageId),
  listPending: (guildId) =>
    q(`SELECT * FROM pending_approvals WHERE guild_id = ? AND status = 'pending'
       ORDER BY created_at DESC`).all(guildId),
  listRecent: (guildId, limit = 50) =>
    q('SELECT * FROM pending_approvals WHERE guild_id = ? ORDER BY id DESC LIMIT ?')
      .all(guildId, limit),
  resolve: (id, status, resolvedBy) => {
    const info = q(`UPDATE pending_approvals
                    SET status = ?, resolved_by = ?, resolved_at = ?
                    WHERE id = ? AND status = 'pending'`)
      .run(status, resolvedBy, Date.now(), id);
    return info.changes === 1 ? pendingApprovals.byId(id) : null;
  },
};

export const reinviteTokens = {
  issue: (guildId, botId, issuedBy, ttlMs = config.reinviteTokenTtlMs) => {
    const expiresAt = Date.now() + ttlMs;
    q(`INSERT INTO pending_reinvite_token (guild_id, bot_id, issued_by, issued_at, expires_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(guild_id, bot_id) DO UPDATE SET
         issued_by  = excluded.issued_by,
         issued_at  = excluded.issued_at,
         expires_at = excluded.expires_at`)
      .run(guildId, botId, issuedBy ?? null, Date.now(), expiresAt);
    return expiresAt;
  },
  peek: (guildId, botId) =>
    q('SELECT * FROM pending_reinvite_token WHERE guild_id = ? AND bot_id = ? AND expires_at > ?')
      .get(guildId, botId, Date.now()),
  consume: db.transaction((guildId, botId) => {
    const row = q('SELECT * FROM pending_reinvite_token WHERE guild_id = ? AND bot_id = ?')
      .get(guildId, botId);
    if (!row) return { consumed: false, reason: 'no_token' };
    q('DELETE FROM pending_reinvite_token WHERE guild_id = ? AND bot_id = ?').run(guildId, botId);
    if (row.expires_at <= Date.now()) return { consumed: false, reason: 'expired', row };
    return { consumed: true, reason: 'ok', row };
  }),
  revoke: (guildId, botId) =>
    q('DELETE FROM pending_reinvite_token WHERE guild_id = ? AND bot_id = ?').run(guildId, botId),
  listLive: (guildId) =>
    q('SELECT * FROM pending_reinvite_token WHERE guild_id = ? AND expires_at > ? ORDER BY expires_at')
      .all(guildId, Date.now()),
  purgeExpired: () =>
    q('DELETE FROM pending_reinvite_token WHERE expires_at <= ?').run(Date.now()).changes,
};

export const keywords = {
  list: (guildId) =>
    q('SELECT keyword FROM keyword_blocklist WHERE guild_id = ? ORDER BY keyword')
      .all(guildId).map((r) => r.keyword),
  rows: (guildId) =>
    q('SELECT * FROM keyword_blocklist WHERE guild_id = ? ORDER BY keyword').all(guildId),
  add: (guildId, keyword, addedBy) =>
    q(`INSERT OR IGNORE INTO keyword_blocklist (guild_id, keyword, added_by, added_at)
       VALUES (?, ?, ?, ?)`)
      .run(guildId, String(keyword).trim().toLowerCase(), addedBy ?? null, Date.now()),
  remove: (guildId, keyword) =>
    q('DELETE FROM keyword_blocklist WHERE guild_id = ? AND keyword = ?')
      .run(guildId, String(keyword).trim().toLowerCase()),
};

const CONFIG_COLUMNS = [
  'notify_channel_id',
  'notify_via_dm',
  'log_channel_id',
  'low_res_threshold_px',
  'nickname',
  'auto_ban_nuke_inviters',
  'nuke_inviter_action',
  'owner_id',
  'guild_name',
  'announce_channel_id',
  'announce_allow_everyone',
  'min_account_age_days',
  'quorum_required',
  'whitelist_expiry_days',
  'impersonation_check',
];

export const guildConfig = {
  get: (guildId) => {
    let row = q('SELECT * FROM guild_config WHERE guild_id = ?').get(guildId);
    if (!row) {
      q('INSERT OR IGNORE INTO guild_config (guild_id, low_res_threshold_px) VALUES (?, ?)')
        .run(guildId, config.defaults.lowResThresholdPx);
      row = q('SELECT * FROM guild_config WHERE guild_id = ?').get(guildId);
    }
    return row;
  },
  set: (guildId, patch) => {
    guildConfig.ensure(guildId);
    const cols = Object.keys(patch).filter((k) => CONFIG_COLUMNS.includes(k));
    if (!cols.length) return;
    const sql = `UPDATE guild_config SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE guild_id = ?`;
    q(sql).run(...cols.map((c) => patch[c]), guildId);
  },
  ensure: (guildId) => { guildConfig.get(guildId); },
  markSeeded: (guildId) =>
    q('UPDATE guild_config SET seeded_keywords = 1 WHERE guild_id = ?').run(guildId),
};

export const securityLog = {
  write: ({ guildId, botId, actorId, action, severity = 'info', detail }) =>
    q(`INSERT INTO security_log (guild_id, bot_id, actor_id, action, severity, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(guildId ?? null, botId ?? null, actorId ?? null, action, severity,
           detail ? JSON.stringify(detail) : null, Date.now()),
  recent: (guildId, limit = 100) =>
    q('SELECT * FROM security_log WHERE guild_id = ? ORDER BY id DESC LIMIT ?').all(guildId, limit),
};

export const selfCheckState = {
  get: (guildId) => q('SELECT * FROM self_check_state WHERE guild_id = ?').get(guildId),
  save: (guildId, { rolePosition, permissions, lastOkAt, lastAlertAt }) =>
    q(`INSERT INTO self_check_state (guild_id, role_position, permissions, last_ok_at, last_alert_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(guild_id) DO UPDATE SET
         role_position = excluded.role_position,
         permissions   = excluded.permissions,
         last_ok_at    = COALESCE(excluded.last_ok_at, self_check_state.last_ok_at),
         last_alert_at = COALESCE(excluded.last_alert_at, self_check_state.last_alert_at)`)
      .run(guildId, rolePosition ?? null, permissions ?? null, lastOkAt ?? null, lastAlertAt ?? null),
};

export const nukeRegistry = {
  has: (guildId, botId) =>
    !!q('SELECT 1 FROM nuke_registry WHERE guild_id = ? AND bot_id = ?').get(guildId, botId),
  get: (guildId, botId) =>
    q('SELECT * FROM nuke_registry WHERE guild_id = ? AND bot_id = ?').get(guildId, botId),
  add: (guildId, botId, { botTag, confirmedBy, reason }) =>
    q(`INSERT INTO nuke_registry (guild_id, bot_id, bot_tag, confirmed_by, confirmed_at, reason)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(guild_id, bot_id) DO UPDATE SET
         bot_tag      = excluded.bot_tag,
         confirmed_by = excluded.confirmed_by,
         confirmed_at = excluded.confirmed_at,
         reason       = excluded.reason`)
      .run(guildId, botId, botTag ?? null, confirmedBy, Date.now(), reason ?? null),
  remove: (guildId, botId) =>
    q('DELETE FROM nuke_registry WHERE guild_id = ? AND bot_id = ?').run(guildId, botId),
  list: (guildId) =>
    q('SELECT * FROM nuke_registry WHERE guild_id = ? ORDER BY confirmed_at DESC').all(guildId),
  count: (guildId) =>
    q('SELECT COUNT(*) AS n FROM nuke_registry WHERE guild_id = ?').get(guildId).n,
};

export const knownNukeBots = {
  has: (botId) => !!q('SELECT 1 FROM known_nuke_bots WHERE bot_id = ?').get(botId),
  get: (botId) => q('SELECT * FROM known_nuke_bots WHERE bot_id = ?').get(botId),
  add: ({ botId, botTag, reason, source = 'manual', addedBy }) =>
    q(`INSERT INTO known_nuke_bots (bot_id, bot_tag, reason, source, added_by, added_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(bot_id) DO UPDATE SET
         bot_tag  = COALESCE(excluded.bot_tag, known_nuke_bots.bot_tag),
         reason   = COALESCE(excluded.reason, known_nuke_bots.reason),
         source   = excluded.source,
         added_by = excluded.added_by`)
      .run(botId, botTag ?? null, reason ?? null, source, addedBy ?? null, Date.now()),
  remove: (botId) => q('DELETE FROM known_nuke_bots WHERE bot_id = ?').run(botId),
  all: () => q('SELECT * FROM known_nuke_bots ORDER BY added_at DESC').all(),
  count: () => q('SELECT COUNT(*) AS n FROM known_nuke_bots').get().n,
};

export const nukeDbRequests = {
  create: ({ botId, botTag, reason, requestedBy, requestedByTag, guildId, guildName }) =>
    q(`INSERT INTO nuke_db_requests
         (bot_id, bot_tag, reason, requested_by, requested_by_tag, guild_id, guild_name,
          status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
      .run(botId, botTag ?? null, reason, requestedBy, requestedByTag ?? null, guildId,
           guildName ?? null, Date.now()),
  byId: (id) => q('SELECT * FROM nuke_db_requests WHERE id = ?').get(id),
  openFor: (botId, guildId) =>
    q(`SELECT * FROM nuke_db_requests
       WHERE bot_id = ? AND guild_id = ? AND status = 'pending'`).get(botId, guildId),
  listPending: () =>
    q("SELECT * FROM nuke_db_requests WHERE status = 'pending'ORDER BY created_at").all(),
  listForGuild: (guildId, limit = 20) =>
    q('SELECT * FROM nuke_db_requests WHERE guild_id = ? ORDER BY id DESC LIMIT ?')
      .all(guildId, limit),
  listRecent: (limit = 40) =>
    q('SELECT * FROM nuke_db_requests ORDER BY id DESC LIMIT ?').all(limit),
  pendingCount: () =>
    q("SELECT COUNT(*) AS n FROM nuke_db_requests WHERE status = 'pending'").get().n,
  resolve: (id, status, reviewerId, note) => {
    const info = q(`UPDATE nuke_db_requests
                    SET status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ?
                    WHERE id = ? AND status = 'pending'`)
      .run(status, reviewerId, Date.now(), note ?? null, id);
    return info.changes === 1 ? nukeDbRequests.byId(id) : null;
  },
};

export const nukeIncidents = {
  create: ({ guildId, botId, botTag, inviterId, inviterTag, botAction, inviterAction }) =>
    q(`INSERT INTO nuke_incidents
         (guild_id, bot_id, bot_tag, inviter_id, inviter_tag, bot_action, inviter_action,
          resolution, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
      .run(guildId, botId, botTag ?? null, inviterId ?? null, inviterTag ?? null,
           botAction ?? null, inviterAction ?? null, Date.now()),
  byId: (id) => q('SELECT * FROM nuke_incidents WHERE id = ?').get(id),
  recent: (guildId, limit = 20) =>
    q('SELECT * FROM nuke_incidents WHERE guild_id = ? ORDER BY id DESC LIMIT ?')
      .all(guildId, limit),
  resolve: (id, resolution, resolvedBy) => {
    const info = q(`UPDATE nuke_incidents
                    SET resolution = ?, resolved_by = ?, resolved_at = ?
                    WHERE id = ? AND resolution = 'pending'`)
      .run(resolution, resolvedBy, Date.now(), id);
    return info.changes === 1 ? nukeIncidents.byId(id) : null;
  },
};

export const botPermissions = {
  get: (guildId, botId) =>
    q('SELECT * FROM bot_permission_state WHERE guild_id = ? AND bot_id = ?').get(guildId, botId),
  save: (guildId, botId, { botTag, permissions, dangerous }) =>
    q(`INSERT INTO bot_permission_state (guild_id, bot_id, bot_tag, permissions, dangerous, checked_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(guild_id, bot_id) DO UPDATE SET
         bot_tag     = excluded.bot_tag,
         permissions = excluded.permissions,
         dangerous   = excluded.dangerous,
         checked_at  = excluded.checked_at`)
      .run(guildId, botId, botTag ?? null, permissions, JSON.stringify(dangerous ?? []), Date.now()),
  remove: (guildId, botId) =>
    q('DELETE FROM bot_permission_state WHERE guild_id = ? AND bot_id = ?').run(guildId, botId),
  list: (guildId) =>
    q('SELECT * FROM bot_permission_state WHERE guild_id = ?').all(guildId),
};

export const approvalVotes = {
  cast: (pendingId, voterId, decision) =>
    q(`INSERT INTO approval_votes (pending_id, voter_id, decision, voted_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(pending_id, voter_id) DO UPDATE SET
         decision = excluded.decision,
         voted_at = excluded.voted_at`)
      .run(pendingId, voterId, decision, Date.now()),
  list: (pendingId) =>
    q('SELECT * FROM approval_votes WHERE pending_id = ? ORDER BY voted_at').all(pendingId),
  countFor: (pendingId, decision) =>
    q('SELECT COUNT(*) AS n FROM approval_votes WHERE pending_id = ? AND decision = ?')
      .get(pendingId, decision).n,
  clear: (pendingId) =>
    q('DELETE FROM approval_votes WHERE pending_id = ?').run(pendingId),
};

export const blog = {
  create: ({ slug, title, summary, body, published, authorId }) =>
    q(`INSERT INTO blog_posts
         (slug, title, summary, body, published, author_id, created_at, updated_at, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(slug, title, summary ?? null, body, published ? 1 : 0, authorId ?? null,
           Date.now(), Date.now(), published ? Date.now() : null),
  update: (id, { title, summary, body, published }) => {
    const existing = blog.byId(id);
    if (!existing) return null;
    const publishedAt = published
      ? (existing.published_at ?? Date.now())
      : existing.published_at;
    q(`UPDATE blog_posts
       SET title = ?, summary = ?, body = ?, published = ?, updated_at = ?, published_at = ?
       WHERE id = ?`)
      .run(title, summary ?? null, body, published ? 1 : 0, Date.now(), publishedAt, id);
    return blog.byId(id);
  },
  remove: (id) => q('DELETE FROM blog_posts WHERE id = ?').run(id),
  byId: (id) => q('SELECT * FROM blog_posts WHERE id = ?').get(id),
  bySlug: (slug) => q('SELECT * FROM blog_posts WHERE slug = ?').get(slug),
  slugExists: (slug) => !!q('SELECT 1 FROM blog_posts WHERE slug = ?').get(slug),
  listPublished: (limit = 50) =>
    q(`SELECT * FROM blog_posts WHERE published = 1
       ORDER BY published_at DESC LIMIT ?`).all(limit),
  listAll: (limit = 100) =>
    q('SELECT * FROM blog_posts ORDER BY updated_at DESC LIMIT ?').all(limit),
  latest: () =>
    q("SELECT * FROM blog_posts WHERE published = 1 ORDER BY published_at DESC LIMIT 1").get(),
};

export const announcements = {
  create: ({ title, body, requestedEveryone, sentBy }) =>
    q(`INSERT INTO announcements (title, body, requested_everyone, sent_by, sent_at)
       VALUES (?, ?, ?, ?, ?)`)
      .run(title ?? null, body, requestedEveryone ? 1 : 0, sentBy, Date.now()),
  finish: (id, { delivered, skipped, failed }) =>
    q('UPDATE announcements SET delivered = ?, skipped = ?, failed = ? WHERE id = ?')
      .run(delivered, skipped, failed, id),
  recent: (limit = 20) =>
    q('SELECT * FROM announcements ORDER BY id DESC LIMIT ?').all(limit),
  targets: (id) =>
    q('SELECT * FROM announcement_targets WHERE announcement_id = ?').all(id),
  recordTarget: ({ announcementId, guildId, status, pingedEveryone, detail }) =>
    q(`INSERT INTO announcement_targets
         (announcement_id, guild_id, status, pinged_everyone, detail)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(announcement_id, guild_id) DO UPDATE SET
         status = excluded.status,
         pinged_everyone = excluded.pinged_everyone,
         detail = excluded.detail`)
      .run(announcementId, guildId, status, pingedEveryone ? 1 : 0, detail ?? null),
};

export const removalEvents = {
  create: ({ guildId, guildName, actorId, actorTag, actorIsBot, action, ownerId }) =>
    q(`INSERT INTO removal_events
         (guild_id, guild_name, actor_id, actor_tag, actor_is_bot, action, owner_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(guildId, guildName ?? null, actorId ?? null, actorTag ?? null,
           actorIsBot ? 1 : 0, action ?? null, ownerId ?? null, Date.now()),
  markNotified: (id) => q('UPDATE removal_events SET notified = 1 WHERE id = ?').run(id),
  recent: (limit = 50) =>
    q('SELECT * FROM removal_events ORDER BY id DESC LIMIT ?').all(limit),
  lastForGuild: (guildId) =>
    q('SELECT * FROM removal_events WHERE guild_id = ? ORDER BY id DESC LIMIT 1').get(guildId),
};

export const entitlements = {
  get: (guildId) => q('SELECT * FROM entitlements WHERE guild_id = ?').get(guildId),
  upsert: (guildId, { tier, status, expiresAt = null, source, externalId = null, note = null }) =>
    q(`INSERT INTO entitlements
         (guild_id, tier, status, expires_at, source, external_id, note, lapsed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
       ON CONFLICT(guild_id) DO UPDATE SET
         tier        = excluded.tier,
         status      = excluded.status,
         expires_at  = excluded.expires_at,
         source      = excluded.source,
         external_id = excluded.external_id,
         note        = excluded.note,
         lapsed_at   = NULL,
         updated_at  = excluded.updated_at`)
      .run(guildId, tier, status, expiresAt, source ?? null, externalId, note, Date.now()),
  markLapsed: (guildId, reason = null, at = Date.now()) =>
    q(`UPDATE entitlements
       SET lapsed_at = COALESCE(lapsed_at, ?),
           lapse_reason = COALESCE(?, lapse_reason),
           updated_at = ?
       WHERE guild_id = ?`).run(at, reason, Date.now(), guildId),
  markDowngradeNotified: (guildId, reason) =>
    q(`UPDATE entitlements
       SET downgrade_notified_at = ?, downgrade_notified_reason = ?, updated_at = ?
       WHERE guild_id = ?`).run(Date.now(), reason, Date.now(), guildId),
  clearDowngradeNotice: (guildId) =>
    q(`UPDATE entitlements
       SET downgrade_notified_at = NULL, downgrade_notified_reason = NULL, updated_at = ?
       WHERE guild_id = ?`).run(Date.now(), guildId),
  setLapseReason: (guildId, reason) =>
    q('UPDATE entitlements SET lapse_reason = ?, updated_at = ? WHERE guild_id = ?')
      .run(reason, Date.now(), guildId),
  markPerpetual: (guildId, on = true) =>
    q('UPDATE entitlements SET perpetual = ?, updated_at = ? WHERE guild_id = ?')
      .run(on ? 1 : 0, Date.now(), guildId),
  // Paid lifetime purchases only. Complimentary perpetual keys are given away,
  // not sold, so they do not consume a place.
  countSoldPerpetual: () =>
    q(`SELECT COUNT(*) AS n FROM entitlements
       WHERE perpetual = 1 AND source = 'stripe' AND status = 'active'`).get().n,
  isPerpetual: (guildId) =>
    !!q('SELECT perpetual FROM entitlements WHERE guild_id = ?').get(guildId)?.perpetual,
  clearLapsed: (guildId) =>
    q('UPDATE entitlements SET lapsed_at = NULL, updated_at = ? WHERE guild_id = ?')
      .run(Date.now(), guildId),
  markStripeTrialUsed: (guildId, at = Date.now()) =>
    q(`UPDATE entitlements
       SET stripe_trial_used_at = COALESCE(stripe_trial_used_at, ?), updated_at = ?
       WHERE guild_id = ?`).run(at, Date.now(), guildId),
  hasUsedStripeTrial: (guildId) =>
    !!q('SELECT stripe_trial_used_at FROM entitlements WHERE guild_id = ?')
      .get(guildId)?.stripe_trial_used_at,
  revoke: (guildId, note = null) =>
    q(`UPDATE entitlements SET status = 'revoked', note = COALESCE(?, note), updated_at = ?
       WHERE guild_id = ?`).run(note, Date.now(), guildId),
  all: () => q('SELECT * FROM entitlements ORDER BY updated_at DESC').all(),
  byExternalId: (externalId) =>
    q('SELECT * FROM entitlements WHERE external_id = ?').get(externalId),
};

export const licenseKeys = {
  create: ({ keyHash, tier = 'pro', durationDays = null, maxGuilds = 1, note = null, createdBy = null }) =>
    q(`INSERT INTO license_keys
         (key_hash, tier, duration_days, max_guilds, note, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(keyHash, tier, durationDays, maxGuilds, note, createdBy, Date.now()),
  byHash: (keyHash) => q('SELECT * FROM license_keys WHERE key_hash = ?').get(keyHash),
  revoke: (keyHash) => q('UPDATE license_keys SET revoked = 1 WHERE key_hash = ?').run(keyHash),
  all: () => q('SELECT * FROM license_keys ORDER BY created_at DESC').all(),
  redeem: db.transaction((keyHash, guildId, redeemedBy) => {
    const key = q('SELECT * FROM license_keys WHERE key_hash = ?').get(keyHash);
    if (!key) return { ok: false, reason: 'unknown_key' };
    if (key.revoked) return { ok: false, reason: 'revoked' };

    const already = q('SELECT 1 FROM license_redemptions WHERE key_hash = ? AND guild_id = ?')
      .get(keyHash, guildId);
    if (!already && key.redeemed_count >= key.max_guilds) {
      return { ok: false, reason: 'seats_exhausted' };
    }
    if (!already) {
      q(`INSERT INTO license_redemptions (key_hash, guild_id, redeemed_by, redeemed_at)
         VALUES (?, ?, ?, ?)`).run(keyHash, guildId, redeemedBy ?? null, Date.now());
      q('UPDATE license_keys SET redeemed_count = redeemed_count + 1 WHERE key_hash = ?')
        .run(keyHash);
    }
    return { ok: true, key, reused: !!already };
  }),
  redemptions: (keyHash) =>
    q('SELECT * FROM license_redemptions WHERE key_hash = ? ORDER BY redeemed_at DESC').all(keyHash),
};

export const termsAcceptances = {
  record: ({ guildId, userId, document, version, keyHash = null }) =>
    q(`INSERT INTO terms_acceptances
         (guild_id, user_id, document, version, key_hash, accepted_at)
       VALUES (?, ?, ?, ?, ?, ?)`)
      .run(guildId, userId, document, version, keyHash, Date.now()),
  latestFor: (guildId, document) =>
    q(`SELECT * FROM terms_acceptances
       WHERE guild_id = ? AND document = ?
       ORDER BY accepted_at DESC LIMIT 1`).get(guildId, document),
  forGuild: (guildId, limit = 20) =>
    q('SELECT * FROM terms_acceptances WHERE guild_id = ? ORDER BY accepted_at DESC LIMIT ?')
      .all(guildId, limit),
  recent: (limit = 50) =>
    q('SELECT * FROM terms_acceptances ORDER BY accepted_at DESC LIMIT ?').all(limit),
};

export { db };
