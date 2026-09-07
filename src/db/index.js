import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('db');

fs.mkdirSync(path.dirname(config.db.path), { recursive: true });

export const db = new Database(config.db.path);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = FULL');

const MIGRATIONS = [
  {
    id: 1,
    name: 'init',
    sql: `
      CREATE TABLE whitelist (
        guild_id    TEXT    NOT NULL,
        bot_id      TEXT    NOT NULL,
        approved_by TEXT    NOT NULL,
        approved_at INTEGER NOT NULL,
        PRIMARY KEY (guild_id, bot_id)
      );

      CREATE TABLE approver_roles (
        guild_id TEXT NOT NULL,
        role_id  TEXT NOT NULL,
        PRIMARY KEY (guild_id, role_id)
      );

      CREATE TABLE pending_approvals (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id        TEXT    NOT NULL,
        bot_id          TEXT    NOT NULL,
        bot_tag         TEXT,
        added_by        TEXT,
        channel_id      TEXT,
        message_id      TEXT,
        -- The matched keyword, or NULL. Persisted because approval has to know
        -- whether to mint a re-invite token, and buttons outlive the process.
        keyword_matched TEXT,
        -- 1 when a token was burned to get past the hard keyword gate.
        token_consumed  INTEGER NOT NULL DEFAULT 0,
        status          TEXT    NOT NULL DEFAULT 'pending',
        resolved_by     TEXT,
        resolved_at     INTEGER,
        created_at      INTEGER NOT NULL
      );
      CREATE INDEX idx_pending_message ON pending_approvals(message_id);
      CREATE INDEX idx_pending_guild_status ON pending_approvals(guild_id, status);
      CREATE INDEX idx_pending_bot ON pending_approvals(guild_id, bot_id);

      CREATE TABLE pending_reinvite_token (
        guild_id   TEXT    NOT NULL,
        bot_id     TEXT    NOT NULL,
        issued_by  TEXT,
        issued_at  INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (guild_id, bot_id)
      );

      CREATE TABLE keyword_blocklist (
        guild_id TEXT NOT NULL,
        keyword  TEXT NOT NULL,
        added_by TEXT,
        added_at INTEGER,
        PRIMARY KEY (guild_id, keyword)
      );

      CREATE TABLE guild_config (
        guild_id             TEXT PRIMARY KEY,
        notify_channel_id    TEXT,
        notify_via_dm        INTEGER NOT NULL DEFAULT 0,
        log_channel_id       TEXT,
        low_res_threshold_px INTEGER NOT NULL DEFAULT 512,
        -- BotApprove's own nickname in this guild, set from the dashboard.
        -- NULL means "leave whatever is there alone".
        nickname             TEXT,
        seeded_keywords      INTEGER NOT NULL DEFAULT 0
      );

      -- Not in the original schema sketch, but "log every kick, approval and
      -- denial" needs somewhere durable to land, and the web UI reads it.
      CREATE TABLE security_log (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id   TEXT,
        bot_id     TEXT,
        actor_id   TEXT,
        action     TEXT    NOT NULL,
        severity   TEXT    NOT NULL DEFAULT 'info',
        detail     TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_seclog_guild ON security_log(guild_id, created_at DESC);

      -- Baseline for detecting that our own perms/role position were lowered.
      CREATE TABLE self_check_state (
        guild_id      TEXT PRIMARY KEY,
        role_position INTEGER,
        permissions   TEXT,
        last_ok_at    INTEGER,
        last_alert_at INTEGER
      );

      CREATE TABLE web_sessions (
        sid        TEXT PRIMARY KEY,
        data       TEXT    NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX idx_sessions_expiry ON web_sessions(expires_at);
    `,
  },
  {
    id: 2,
    name: 'entitlements',
    sql: `
      -- Paywall state per guild. Written by any source (manual grant, license
      -- key redemption, Stripe webhook) so billing providers stay swappable.
      CREATE TABLE entitlements (
        guild_id    TEXT PRIMARY KEY,
        tier        TEXT    NOT NULL DEFAULT 'none',      -- none|trial|pro|owner
        status      TEXT    NOT NULL DEFAULT 'inactive',  -- active|expired|revoked|inactive
        expires_at  INTEGER,                              -- NULL = never expires
        source      TEXT,                                 -- owner_allowlist|manual|license_key|stripe
        external_id TEXT,                                 -- e.g. Stripe subscription id
        note        TEXT,
        -- When the guild first went unlicensed; drives the grace period.
        lapsed_at   INTEGER,
        updated_at  INTEGER NOT NULL
      );

      -- Only the hash is stored: a leaked database must not yield usable keys.
      CREATE TABLE license_keys (
        key_hash       TEXT PRIMARY KEY,
        tier           TEXT    NOT NULL DEFAULT 'pro',
        duration_days  INTEGER,                     -- NULL = perpetual
        max_guilds     INTEGER NOT NULL DEFAULT 1,
        redeemed_count INTEGER NOT NULL DEFAULT 0,
        revoked        INTEGER NOT NULL DEFAULT 0,
        note           TEXT,
        created_by     TEXT,
        created_at     INTEGER NOT NULL
      );

      CREATE TABLE license_redemptions (
        key_hash    TEXT    NOT NULL,
        guild_id    TEXT    NOT NULL,
        redeemed_by TEXT,
        redeemed_at INTEGER NOT NULL,
        PRIMARY KEY (key_hash, guild_id)
      );
      CREATE INDEX idx_redemptions_guild ON license_redemptions(guild_id);
    `,
  },
  {
    id: 3,
    name: 'nuke_registry_feature_gating',
    sql: `
      -- Bots a human has explicitly confirmed as nuke bots. Deliberately
      -- per-guild: one server's confirmation must not auto-ban people in
      -- another server.
      CREATE TABLE nuke_registry (
        guild_id     TEXT    NOT NULL,
        bot_id       TEXT    NOT NULL,
        bot_tag      TEXT,
        confirmed_by TEXT    NOT NULL,
        confirmed_at INTEGER NOT NULL,
        reason       TEXT,
        PRIMARY KEY (guild_id, bot_id)
      );

      -- Off by default. Banning a human is destructive and near-irreversible
      -- for that person's membership, so it is always opt-in.
      ALTER TABLE guild_config ADD COLUMN auto_ban_nuke_inviters INTEGER NOT NULL DEFAULT 0;

      -- Why premium access lapsed, and whether the owner was already told.
      -- Prevents the 5-minute sweep from re-DMing the same people forever.
      ALTER TABLE entitlements ADD COLUMN lapse_reason TEXT;
      ALTER TABLE entitlements ADD COLUMN downgrade_notified_at INTEGER;
      ALTER TABLE entitlements ADD COLUMN downgrade_notified_reason TEXT;
    `,
  },
  {
    id: 4,
    name: 'known_nuke_database',
    sql: `
      -- Instance-wide threat list, curated by the operator, distinct from the
      -- per-guild nuke_registry, which only ever reflects one server's own
      -- confirmations. A hit here is treated as already proven.
      CREATE TABLE known_nuke_bots (
        bot_id   TEXT PRIMARY KEY,
        bot_tag  TEXT,
        reason   TEXT,
        source   TEXT,
        added_by TEXT,
        added_at INTEGER NOT NULL
      );

      -- One row per "a known nuke bot got invited here" event. Persisted so the
      -- owner's decision buttons still work after a restart, and so the same
      -- incident cannot be actioned twice.
      CREATE TABLE nuke_incidents (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id        TEXT    NOT NULL,
        bot_id          TEXT    NOT NULL,
        bot_tag         TEXT,
        inviter_id      TEXT,
        inviter_tag     TEXT,
        bot_action      TEXT,
        inviter_action  TEXT,
        resolution      TEXT    NOT NULL DEFAULT 'pending',
        resolved_by     TEXT,
        resolved_at     INTEGER,
        created_at      INTEGER NOT NULL
      );
      CREATE INDEX idx_incidents_guild ON nuke_incidents(guild_id, created_at DESC);

      -- What happens to the inviter automatically. 'kick'is the default: it
      -- stops the account acting further without being irreversible.
      ALTER TABLE guild_config ADD COLUMN nuke_inviter_action TEXT NOT NULL DEFAULT 'kick';
    `,
  },
  {
    id: 5,
    name: 'nuke_db_requests',
    sql: `
      -- Server owners can nominate a bot for the instance-wide threat list, but
      -- nothing lands there without the operator approving it. A submission is
      -- a request, never an entry.
      CREATE TABLE nuke_db_requests (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        bot_id           TEXT    NOT NULL,
        bot_tag          TEXT,
        reason           TEXT    NOT NULL,
        requested_by     TEXT    NOT NULL,
        requested_by_tag TEXT,
        guild_id         TEXT    NOT NULL,
        guild_name       TEXT,
        status           TEXT    NOT NULL DEFAULT 'pending',
        reviewed_by      TEXT,
        reviewed_at      INTEGER,
        review_note      TEXT,
        created_at       INTEGER NOT NULL
      );
      CREATE INDEX idx_nukereq_status ON nuke_db_requests(status, created_at DESC);
      -- One open request per bot per guild: re-submitting while a review is
      -- pending should not let a guild flood the queue.
      CREATE UNIQUE INDEX idx_nukereq_open
        ON nuke_db_requests(bot_id, guild_id) WHERE status = 'pending';
    `,
  },
  {
    id: 6,
    name: 'removal_watch',
    sql: `
      -- Cached while the bot is still in the guild. After removal there is no
      -- API access left to look any of it up, so the owner cannot be DMed
      -- unless their id was already on disk.
      ALTER TABLE guild_config ADD COLUMN owner_id TEXT;
      ALTER TABLE guild_config ADD COLUMN guild_name TEXT;

      CREATE TABLE removal_events (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id     TEXT    NOT NULL,
        guild_name   TEXT,
        actor_id     TEXT,
        actor_tag    TEXT,
        actor_is_bot INTEGER NOT NULL DEFAULT 0,
        action       TEXT,
        owner_id     TEXT,
        notified     INTEGER NOT NULL DEFAULT 0,
        created_at   INTEGER NOT NULL
      );
      CREATE INDEX idx_removal_guild ON removal_events(guild_id, created_at DESC);
    `,
  },
  {
    id: 7,
    name: 'announcements',
    sql: `
      -- Where the operator's announcements land, chosen by each server, plus
      -- whether that server is willing to be @everyone pinged. Both sides have
      -- to agree before anyone is mass-mentioned.
      ALTER TABLE guild_config ADD COLUMN announce_channel_id TEXT;
      ALTER TABLE guild_config ADD COLUMN announce_allow_everyone INTEGER NOT NULL DEFAULT 0;

      CREATE TABLE announcements (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        title        TEXT,
        body         TEXT    NOT NULL,
        requested_everyone INTEGER NOT NULL DEFAULT 0,
        sent_by      TEXT    NOT NULL,
        sent_at      INTEGER NOT NULL,
        delivered    INTEGER NOT NULL DEFAULT 0,
        skipped      INTEGER NOT NULL DEFAULT 0,
        failed       INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE announcement_targets (
        announcement_id INTEGER NOT NULL,
        guild_id        TEXT    NOT NULL,
        status          TEXT    NOT NULL,
        pinged_everyone INTEGER NOT NULL DEFAULT 0,
        detail          TEXT,
        PRIMARY KEY (announcement_id, guild_id)
      );
    `,
  },
  {
    id: 8,
    name: 'blog',
    sql: `
      CREATE TABLE blog_posts (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        slug       TEXT    NOT NULL UNIQUE,
        title      TEXT    NOT NULL,
        summary    TEXT,
        body       TEXT    NOT NULL,
        published  INTEGER NOT NULL DEFAULT 0,
        author_id  TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        published_at INTEGER
      );
      CREATE INDEX idx_blog_published ON blog_posts(published, published_at DESC);
    `,
  },
  {
    id: 9,
    name: 'drift_impersonation_quorum',
    sql: `
      -- Per-guild switches for the new checks. All default to off or to the
      -- previous behaviour, so an existing server sees no change until it opts in.
      ALTER TABLE guild_config ADD COLUMN min_account_age_days INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE guild_config ADD COLUMN quorum_required INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE guild_config ADD COLUMN whitelist_expiry_days INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE guild_config ADD COLUMN impersonation_check INTEGER NOT NULL DEFAULT 1;

      -- What an approved bot's permissions looked like last time we checked.
      -- A bot is vetted once, at join; without a baseline there is no way to
      -- notice it being escalated afterwards, which is the obvious attack.
      CREATE TABLE bot_permission_state (
        guild_id    TEXT    NOT NULL,
        bot_id      TEXT    NOT NULL,
        bot_tag     TEXT,
        permissions TEXT    NOT NULL,
        dangerous   TEXT,
        checked_at  INTEGER NOT NULL,
        PRIMARY KEY (guild_id, bot_id)
      );

      -- One row per approver per pending decision. Needed for quorum, and it
      -- doubles as a record of who agreed to what.
      CREATE TABLE approval_votes (
        pending_id INTEGER NOT NULL,
        voter_id   TEXT    NOT NULL,
        decision   TEXT    NOT NULL,
        voted_at   INTEGER NOT NULL,
        PRIMARY KEY (pending_id, voter_id)
      );
    `,
  },
  {
    id: 10,
    name: 'stripe_trial_offer',
    sql: `
      -- When this server last took the free-trial offer at checkout. The offer
      -- is once per server: without this, cancelling and subscribing again
      -- would renew the free period indefinitely. Kept on the entitlement row
      -- because that row survives cancellation, unlike the subscription.
      ALTER TABLE entitlements ADD COLUMN stripe_trial_used_at INTEGER;
    `,
  },
  {
    id: 11,
    name: 'terms_acceptance',
    sql: `
      CREATE TABLE terms_acceptances (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id     TEXT    NOT NULL,
        user_id      TEXT    NOT NULL,
        document     TEXT    NOT NULL,
        version      TEXT    NOT NULL,
        key_hash     TEXT,
        accepted_at  INTEGER NOT NULL
      );
      CREATE INDEX idx_terms_acceptances_guild ON terms_acceptances (guild_id, accepted_at DESC);
    `,
  },
  {
    id: 12,
    name: 'perpetual_entitlement',
    sql: `
      ALTER TABLE entitlements ADD COLUMN perpetual INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    id: 13,
    name: 'backfill_perpetual',
    sql: `
      -- Servers that redeemed a perpetual key before the flag existed. A
      -- licence key with no expiry is unambiguously permanent, so it can be
      -- inferred safely.
      -- Stripe rows deliberately are not touched: a trialling subscription also
      -- has no expiry, and flagging one perpetual would make it impossible to
      -- ever lapse. Stripe lifetime purchases set the flag explicitly instead.
      UPDATE entitlements
         SET perpetual = 1
       WHERE perpetual = 0
         AND expires_at IS NULL
         AND source = 'license_key';
    `,
  },
  {
    id: 14,
    name: 'instance_state',
    sql: `
      -- Small key/value store for facts about this instance rather than any one
      -- guild. First use: remembering whether card payment was switched on, so
      -- the announcement about it opening is sent once and not on every boot.
      CREATE TABLE instance_state (
        key        TEXT PRIMARY KEY,
        value      TEXT,
        updated_at INTEGER NOT NULL
      );
    `,
  },
  {
    id: 15,
    name: 'tamper_response',
    sql: `
      --
      ALTER TABLE guild_config ADD COLUMN tamper_response TEXT NOT NULL DEFAULT 'defend';

      CREATE TABLE tamper_responses (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id      TEXT    NOT NULL,
        actor_id      TEXT,
        actor_tag     TEXT,
        trigger       TEXT    NOT NULL,
        outcome       TEXT    NOT NULL,
        roles_removed TEXT,
        detail        TEXT,
        created_at    INTEGER NOT NULL,
        restored_at   INTEGER
      );
      CREATE INDEX idx_tamper_guild ON tamper_responses(guild_id, created_at DESC);
    `,
  },
  {
    id: 16,
    name: 'webhook_guard_quarantine_lockdown',
    sql: `
      ALTER TABLE guild_config ADD COLUMN webhook_guard TEXT NOT NULL DEFAULT 'report';

      ALTER TABLE guild_config ADD COLUMN quarantine_role_id TEXT;

      CREATE TABLE webhook_events (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id     TEXT    NOT NULL,
        webhook_id   TEXT,
        webhook_name TEXT,
        channel_id   TEXT,
        actor_id     TEXT,
        actor_tag    TEXT,
        outcome      TEXT    NOT NULL,
        created_at   INTEGER NOT NULL
      );
      CREATE INDEX idx_webhook_guild ON webhook_events(guild_id, created_at DESC);

      CREATE TABLE lockdown_state (
        guild_id   TEXT PRIMARY KEY,
        active     INTEGER NOT NULL DEFAULT 0,
        applied    TEXT,
        started_by TEXT,
        started_at INTEGER,
        ended_at   INTEGER
      );
    `,
  },
  {
    id: 17,
    name: 'per_guild_feature_switches',
    sql: `
      CREATE TABLE guild_features (
        guild_id    TEXT    NOT NULL,
        feature_key TEXT    NOT NULL,
        enabled     INTEGER NOT NULL DEFAULT 0,
        updated_by  TEXT,
        updated_at  INTEGER NOT NULL,
        PRIMARY KEY (guild_id, feature_key)
      );

      INSERT INTO guild_features (guild_id, feature_key, enabled, updated_by, updated_at)
      SELECT e.guild_id, f.key, 1, 'migration', strftime('%s','now') * 1000
        FROM entitlements e
        CROSS JOIN (
          SELECT 'custom_keywords' AS key UNION ALL
          SELECT 'known_nuke_db' UNION ALL
          SELECT 'custom_nickname' UNION ALL
          SELECT 'auto_ban_inviters' UNION ALL
          SELECT 'dm_alerts' UNION ALL
          SELECT 'image_analysis' UNION ALL
          SELECT 'permission_drift' UNION ALL
          SELECT 'impersonation_check' UNION ALL
          SELECT 'account_age_floor' UNION ALL
          SELECT 'approval_quorum' UNION ALL
          SELECT 'whitelist_expiry' UNION ALL
          SELECT 'log_channel'
        ) f
       WHERE e.status = 'active';
    `,
  },
];

function migrate() {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id         INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL,
    applied_at INTEGER NOT NULL
  );`);

  const applied = new Set(
    db.prepare('SELECT id FROM schema_migrations').all().map((r) => r.id),
  );

  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    const run = db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)')
        .run(m.id, m.name, Date.now());
    });
    run();
    log.info('migration applied', { id: m.id, name: m.name });
  }
}

migrate();
log.info('database ready', { path: config.db.path });

export default db;
