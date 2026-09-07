import { entitlements, guildFeatures } from '../db/queries.js';
import { config } from '../config.js';

export const FREE = 'free';
export const PREMIUM = 'premium';

export const FEATURES = {
  core_gate: {
    tier: FREE,
    name: 'Bot approval gate',
    blurb: 'Every joining bot is kicked and held for a human decision.',
  },
  keyword_block: {
    tier: FREE,
    name: 'High-risk keyword blocking',
    blurb: 'Default blocklist, checked before the whitelist.',
  },
  audit_trail: {
    tier: FREE,
    name: 'Audit trail',
    blurb: 'Every kick, approval and denial recorded durably.',
  },
  tamper_detection: {
    tier: FREE,
    name: 'Tamper detection',
    blurb: 'Alerts if BotApprove’s own permissions or role position are lowered.',
  },
  dashboard: {
    tier: FREE,
    name: 'Web dashboard',
    blurb: 'Review, approve and read the full security log at any time.',
  },

  custom_keywords: {
    tier: PREMIUM,
    name: 'Custom keywords',
    blurb: 'Add your own blocklist terms. Terms already saved keep working if this lapses.',
  },
  known_nuke_db: {
    tier: PREMIUM,
    name: 'Known nuke bot database',
    blurb: 'Bots on the shared threat list are banned on sight and the inviter is dealt with.',
  },
  custom_nickname: {
    tier: PREMIUM,
    name: 'Custom nickname',
    blurb: 'BotApprove wears the name you choose in your server.',
  },
  auto_ban_inviters: {
    tier: PREMIUM,
    name: 'Auto-ban nuke bot inviters',
    blurb: 'Ban whoever invites a bot you have confirmed as a nuke bot.',
  },
  dm_alerts: {
    tier: PREMIUM,
    name: 'DM alerts',
    blurb: 'Approvers are DMed as well as pinged in channel.',
  },
  image_analysis: {
    tier: PREMIUM,
    name: 'Avatar & banner analysis',
    blurb: 'True-resolution spoof heuristics on the approval card.',
  },
  permission_drift: {
    tier: PREMIUM,
    name: 'Permission drift alerts',
    blurb: 'Warns when an already-approved bot is later granted sensitive permissions.',
  },
  impersonation_check: {
    tier: PREMIUM,
    name: 'Impersonation detection',
    blurb: 'Flags a joining bot whose name mimics one you already approved.',
  },
  account_age_floor: {
    tier: PREMIUM,
    name: 'Account age floor',
    blurb: 'Treat bots with brand-new applications as high risk automatically.',
  },
  approval_quorum: {
    tier: PREMIUM,
    name: 'Two-person approval',
    blurb: 'Require a second approver before a high-risk bot is let in.',
  },
  whitelist_expiry: {
    tier: PREMIUM,
    name: 'Approval expiry',
    blurb: 'Approvals lapse after a set period and need reconfirming.',
  },
  log_channel: {
    tier: PREMIUM,
    name: 'Log channel mirroring',
    blurb: 'Mirror the audit trail into Discord. It is always readable on the dashboard.',
  },
};

export const premiumKeys = Object.keys(FEATURES).filter((k) => FEATURES[k].tier === PREMIUM);

export function resolveEntitlement(guildId) {
  if (!config.paywall.enabled) {
    return { licensed: true, tier: 'unmetered', state: 'paywall_disabled' };
  }
  if (config.freeGuildIds.includes(guildId)) {
    return { licensed: true, tier: 'owner', state: 'owner_allowlist' };
  }

  const row = entitlements.get(guildId);
  if (!row || row.status === 'inactive') {
    return { licensed: false, tier: 'none', state: 'never_licensed', row };
  }
  if (row.status === 'revoked') {
    return { licensed: false, tier: row.tier, state: 'revoked', row };
  }
  if (row.expires_at && row.expires_at <= Date.now()) {
    const state = row.tier === 'trial' ? 'trial_ended' : 'expired';
    return { licensed: false, tier: row.tier, state, row, expiresAt: row.expires_at };
  }
  return { licensed: true, tier: row.tier, state: 'active', row, expiresAt: row.expires_at };
}

export function isEntitled(guildId, key) {
  const feature = FEATURES[key];
  if (!feature) return false;
  if (feature.tier === FREE) return true;
  if (!config.paywall.enabled) return true;
  return resolveEntitlement(guildId).licensed;
}

export function hasFeature(guildId, key) {
  const feature = FEATURES[key];
  if (!feature) return false;
  if (feature.tier === FREE) return true;
  if (!isEntitled(guildId, key)) return false;
  return guildFeatures.isEnabled(guildId, key);
}

export function setFeature(guildId, key, enabled, actorId = null) {
  const feature = FEATURES[key];
  if (!feature) return { ok: false, reason: 'unknown_feature' };
  if (feature.tier === FREE) return { ok: false, reason: 'always_on' };
  if (enabled && !isEntitled(guildId, key)) return { ok: false, reason: 'not_entitled' };
  guildFeatures.set(guildId, key, enabled, actorId);
  return { ok: true, enabled: !!enabled };
}

export function featureSwitches(guildId) {
  const enabled = guildFeatures.map(guildId);
  return premiumKeys.map((key) => ({
    key,
    ...FEATURES[key],
    entitled: isEntitled(guildId, key),
    enabled: !!enabled[key],
  }));
}

export function dormantCount(guildId) {
  return featureSwitches(guildId).filter((f) => f.entitled && !f.enabled).length;
}

export function disabledFeatures(guildId) {
  if (!config.paywall.enabled) return [];
  if (resolveEntitlement(guildId).licensed) return [];
  return premiumKeys.map((k) => ({ key: k, ...FEATURES[k] }));
}

export function activeFeatureUsage({ cfg, customKeywordCount = 0, nukeCount = 0 }) {
  const used = [];
  if (customKeywordCount > 0) used.push('custom_keywords');
  if (cfg?.nickname) used.push('custom_nickname');
  if (cfg?.auto_ban_nuke_inviters || nukeCount > 0) used.push('auto_ban_inviters');
  if (cfg?.notify_via_dm) used.push('dm_alerts');
  if (cfg?.min_account_age_days) used.push('account_age_floor');
  if (cfg?.quorum_required) used.push('approval_quorum');
  if (cfg?.whitelist_expiry_days) used.push('whitelist_expiry');
  if (cfg?.impersonation_check) used.push('impersonation_check');
  if (cfg?.log_channel_id) used.push('log_channel');
  used.push('image_analysis', 'known_nuke_db', 'permission_drift');
  return [...new Set(used)].map((k) => ({ key: k, ...FEATURES[k] }));
}

export function featureState(guildId) {
  const ent = resolveEntitlement(guildId);
  const live = !config.paywall.enabled || ent.licensed;
  return Object.entries(FEATURES).map(([key, f]) => ({
    key,
    ...f,
    enabled: f.tier === FREE || live,
  }));
}
