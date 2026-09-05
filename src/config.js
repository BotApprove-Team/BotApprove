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

  inviteUrl: `https://discord.com/oauth2/authorize?client_id=${process.env.DISCORD_CLIENT_ID ?? ''}` +
    '&permissions=67226758&scope=bot%20applications.commands',

  stripe: {
    enabled: bool(process.env.STRIPE_ENABLED, false),
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    priceId: process.env.STRIPE_PRICE_ID || '',
    priceIdYearly: process.env.STRIPE_PRICE_ID_YEARLY || '',
    priceIdLifetime: process.env.STRIPE_PRICE_ID_LIFETIME || '',
    priceAmountYearly: process.env.PRICE_AMOUNT_YEARLY || '50',
    priceAmountLifetime: process.env.PRICE_AMOUNT_LIFETIME || '150',
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

  legal: {
    operator: process.env.LEGAL_OPERATOR || 'hs.ypp',
    contactUrl: process.env.LEGAL_CONTACT_URL || 'https://github.com/cfm-miku-en',
    updated: process.env.LEGAL_UPDATED || '5 September 2026',
  },

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
