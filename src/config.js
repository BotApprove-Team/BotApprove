import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function bool(v, fallback) {
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

function int(v, fallback) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function idList(v) {
  return String(v ?? '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => /^\d{15,25}$/.test(s));
}

export const config = {
  root: ROOT,
  discord: {
    token: process.env.DISCORD_TOKEN ?? '',
    clientId: process.env.DISCORD_CLIENT_ID ?? '',
    clientSecret: process.env.DISCORD_CLIENT_SECRET ?? '',
  },
  web: {
    enabled: bool(process.env.WEB_ENABLED, true),
    port: int(process.env.WEB_PORT, 8420),
    host: process.env.WEB_HOST || '127.0.0.1',
    baseUrl: (process.env.BASE_URL || 'http://localhost:8420').replace(/\/+$/, ''),
    sessionSecret: process.env.SESSION_SECRET ?? '',
    trustProxy: int(process.env.TRUST_PROXY, 1),
    // The landing page count is hidden below the minimum, so a small number is
    // not advertised while the instance is still growing.
    serverCount: {
      show: bool(process.env.SHOW_SERVER_COUNT, true),
      min: int(process.env.SERVER_COUNT_MIN, 25),
    },
  },
  db: {
    path: path.isAbsolute(process.env.DATABASE_PATH ?? '')
      ? process.env.DATABASE_PATH
      : path.join(ROOT, process.env.DATABASE_PATH || './data/botapprove.db'),
  },
  logLevel: process.env.LOG_LEVEL || 'info',

  botStatus: process.env.BOT_STATUS
    ?? (process.env.BASE_URL || 'https://botapprove.mikuuu.xyz').replace(/^https?:\/\//, '').replace(/\/+$/, ''),

  ownerIds: idList(process.env.OWNER_IDS),
  freeGuildIds: idList(process.env.FREE_GUILD_IDS),

  paywall: {
    enabled: bool(process.env.PAYWALL_ENABLED, false),
    trialDays: int(process.env.TRIAL_DAYS, 0),
    purchaseUrl: process.env.PURCHASE_URL || '',
    priceAmount: process.env.PRICE_AMOUNT || '5',
    priceSymbol: process.env.PRICE_SYMBOL || '$',
  },

  reinviteTokenTtlMs: int(process.env.REINVITE_TOKEN_TTL_MINUTES, 12) * 60_000,

  supportUrl: process.env.SUPPORT_URL || 'https://discord.gg/p884kxJFkZ',
  repoUrl: process.env.REPO_URL || 'https://github.com/BotApprove-Team/BotApprove',

  inviteUrl: `https://discord.com/oauth2/authorize?client_id=${process.env.DISCORD_CLIENT_ID ?? ''}` +
    `&permissions=${process.env.INVITE_PERMISSIONS || '1100384169110'}` +
    '&scope=bot%20applications.commands',

  stripe: {
    enabled: bool(process.env.STRIPE_ENABLED, false),
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    priceId: process.env.STRIPE_PRICE_ID || '',
    priceIdYearly: process.env.STRIPE_PRICE_ID_YEARLY || '',
    priceIdLifetime: process.env.STRIPE_PRICE_ID_LIFETIME || '',
    priceAmountYearly: process.env.PRICE_AMOUNT_YEARLY || '50',
    priceAmountLifetime: process.env.PRICE_AMOUNT_LIFETIME || '150',
    // How many lifetime licences may be sold in total. 0 means no limit. Only
    // paid purchases count: complimentary perpetual keys are a separate
    // programme and would otherwise mark this sold out on day one.
    lifetimeCap: int(process.env.LIFETIME_CAP, 0),
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    portalUrl: process.env.STRIPE_PORTAL_URL || '',
    trialDays: int(process.env.STRIPE_TRIAL_DAYS, 7),
  },

  admin: {
    passwordHash: process.env.ADMIN_PASSWORD_HASH || '',
    passwordHash2: process.env.ADMIN_PASSWORD_HASH_2 || '',
    unlockTtlMs: int(process.env.ADMIN_UNLOCK_MINUTES, 30) * 60_000,
    stageTtlMs: int(process.env.ADMIN_STAGE_SECONDS, 120) * 1000,
  },

  // The sibling bot. It runs as its own service with its own database, and the
  // dashboard reaches it over loopback rather than opening its files.
  /**
   * Bots recognised by application id, so the card can say which one this is.
   *
   * This grants nothing. Every one of them is still kicked, still reviewed and
   * still needs approving, and the name filter still fires. All it changes is
   * whether the card shouts, because an owner who deliberately added a well
   * known anti-raid bot should not be told a high-risk stranger turned up.
   *
   * Keyed on the id and never on the name. An impostor calling itself
   * RaidProtect gets the full red treatment, which is the entire point: the
   * name is what an attacker copies, the id is what they cannot.
   *
   *   RECOGNISED_BOTS=id:kind:name,id:kind:name
   *   kind is first_party for ours, or known for somebody else's.
   */
  recognisedBots: (process.env.RECOGNISED_BOTS
    || '1548844974693552179:first_party:RaidProtector'
    + ',466578580449525760:known:RaidProtect'
    + ',858308969998974987:known:AntiRaid')
    .split(',').map((entry) => entry.split(':')).reduce((acc, [id, kind, name]) => {
      if (id && kind && name) acc[id.trim()] = { kind: kind.trim(), name: name.trim() };
      return acc;
    }, {}),

  raidProtector: {
    url: process.env.RAIDPROTECTOR_URL || '',
    token: process.env.RAIDPROTECTOR_TOKEN || '',
    inviteUrl: process.env.RAIDPROTECTOR_INVITE_URL || '',
  },

  legal: {
    operator: process.env.LEGAL_OPERATOR || 'hs.ypp',
    contactUrl: process.env.LEGAL_CONTACT_URL || 'https://github.com/cfm-miku-en',
    contactEmail: process.env.LEGAL_CONTACT_EMAIL || 'miku@mikuuu.xyz',
    updated: process.env.LEGAL_UPDATED || '15 September 2026',
    // Per document. Changing one policy should not restate the other three as
    // freshly reviewed when nobody touched them.
    updatedByDoc: {
      'rp-privacy': '17 September 2026',
    },
    // Set while a change is recent enough to be worth telling people about.
    // The date doubles as the version a reader dismissed, so the next change
    // shows the notice again rather than staying hidden forever.
    noticeVersion: process.env.LEGAL_NOTICE_VERSION || '2026-09-17',
    noticeDate: process.env.LEGAL_NOTICE_DATE || '17 September 2026',
    // Shown until the start of this day, UTC, so the last day it appears is the
    // 18th. A banner nobody can get rid of stops being read and starts being
    // scrolled past, which is worse than not having one.
    noticeUntil: process.env.LEGAL_NOTICE_UNTIL || '2026-09-19',
  },

  // Anthropic's published egress ranges, from their IP addresses documentation.
  // Every Claude bot shares them, which is what separates the web app fetching
  // a page from its own machines and Claude Code fetching it from somebody's
  // desk. Only ever used to choose which greeting to print, so a stale entry
  // costs a mislabelled joke. Check the docs if it ever looks wrong.
  anthropicRanges: (process.env.ANTHROPIC_IP_RANGES
    || '160.79.104.0/21,160.79.104.0/23,2607:6bc0::/48'
    + ',34.162.46.92/32,34.162.102.82/32,34.162.136.91/32'
    + ',34.162.142.92/32,34.162.183.95/32')
    .split(',').map((s) => s.trim()).filter(Boolean),

  defaults: {
    lowResThresholdPx: 512,
    keywords: ['security', 'verify', 'mod-shield', 'protection', 'anti-nuke', 'raid'],
  },
};

export function assertConfig({ requireWeb = config.web.enabled } = {}) {
  const missing = [];
  if (!config.discord.token) missing.push('DISCORD_TOKEN');
  if (!config.discord.clientId) missing.push('DISCORD_CLIENT_ID');
  if (requireWeb) {
    if (!config.discord.clientSecret) missing.push('DISCORD_CLIENT_SECRET');
    if (!config.web.sessionSecret) missing.push('SESSION_SECRET');
  }
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  if (requireWeb && config.web.sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters (openssl rand -hex 32).');
  }
  if (config.paywall.enabled && !config.ownerIds.length) {
    throw new Error('PAYWALL_ENABLED=true requires OWNER_IDS, or you lock yourself out of admin.');
  }
}
