import crypto from 'node:crypto';
import { EmbedBuilder } from 'discord.js';
import {
  entitlements,
  licenseKeys,
  guildConfig,
  keywords,
  nukeRegistry,
  approverRoles,
} from '../db/queries.js';
import { config } from '../config.js';
import { record } from './securityService.js';
import { resolveEntitlement, activeFeatureUsage, premiumKeys, FEATURES } from './featureService.js';
import { createLogger } from '../logger.js';

const log = createLogger('entitlement');

export const TIERS = ['none', 'trial', 'pro', 'owner'];

export { resolveEntitlement };

const normalizeKey = (raw) => String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const hashKey = (raw) => crypto.createHash('sha256').update(normalizeKey(raw)).digest('hex');

export function generateLicenseKey({ tier = 'pro', durationDays = null, maxGuilds = 1, note = null, createdBy = null } = {}) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const group = () => Array.from(crypto.randomBytes(5))
    .map((b) => alphabet[b % alphabet.length]).join('');
  const key = `BA-${group()}-${group()}-${group()}-${group()}`;

  licenseKeys.create({ keyHash: hashKey(key), tier, durationDays, maxGuilds, note, createdBy });
  log.info('license key created', { tier, durationDays, maxGuilds, note });
  return key;
}

export async function redeemLicenseKey(guildId, rawKey, actorId) {
  const keyHash = hashKey(rawKey);
  const result = licenseKeys.redeem(keyHash, guildId, actorId);

  if (!result.ok) {
    await record({
      guildId, actorId, action: 'license_redeem_failed', severity: 'medium',
      detail: { reason: result.reason }, mirror: false,
    });
    return result;
  }

  const expiresAt = result.key.duration_days
    ? Date.now() + result.key.duration_days * 86_400_000
    : null;

  entitlements.upsert(guildId, {
    tier: result.key.tier,
    status: 'active',
    expiresAt,
    source: 'license_key',
    note: result.key.note,
  });
  entitlements.clearDowngradeNotice(guildId);

  await record({
    guildId, actorId, action: 'license_redeemed', severity: 'medium',
    title: 'Licence activated',
    detail: { tier: result.key.tier, expires_at: expiresAt, reused: result.reused },
  });

  return { ok: true, tier: result.key.tier, expiresAt, reused: result.reused };
}

export async function startTrial(guildId, actorId) {
  if (config.paywall.trialDays <= 0) {
    return { ok: false, reason: 'trials_disabled' };
  }
  const existing = entitlements.get(guildId);
  if (existing && existing.source !== 'owner_allowlist') {
    return { ok: false, reason: 'already_has_entitlement', existing };
  }
  const expiresAt = Date.now() + config.paywall.trialDays * 86_400_000;
  entitlements.upsert(guildId, {
    tier: 'trial', status: 'active', expiresAt, source: 'manual', note: 'auto trial on install',
  });
  await record({
    guildId, actorId, action: 'trial_started', severity: 'info',
    detail: { days: config.paywall.trialDays, expires_at: expiresAt },
  });
  return { ok: true, expiresAt };
}

export async function grantEntitlement(guildId, { tier = 'pro', expiresAt = null, note, actorId, source = 'manual' }) {
  entitlements.upsert(guildId, { tier, status: 'active', expiresAt, source, note });
  entitlements.clearDowngradeNotice(guildId);
  await record({
    guildId, actorId, action: 'entitlement_granted', severity: 'medium',
    detail: { tier, expires_at: expiresAt, source },
  });
}

export async function revokeEntitlement(guildId, actorId, note) {
  entitlements.revoke(guildId, note);
  entitlements.setLapseReason(guildId, 'revoked');
  await record({
    guildId, actorId, action: 'entitlement_revoked', severity: 'medium', detail: { note },
  });
}

export async function markBillingLapse(guildId, reason, { externalId = null } = {}) {
  if (!['payment_failed', 'cancelled'].includes(reason)) {
    throw new Error(`unsupported billing lapse reason: ${reason}`);
  }
  const row = entitlements.get(guildId);
  entitlements.upsert(guildId, {
    tier: row?.tier ?? 'pro',
    status: 'expired',
    expiresAt: Date.now(),
    source: row?.source ?? 'stripe',
    externalId: externalId ?? row?.external_id ?? null,
    note: row?.note ?? null,
  });
  entitlements.setLapseReason(guildId, reason);
  await record({
    guildId, action: 'billing_lapse', severity: 'medium', detail: { reason },
  });
}

const LAPSE_SENTENCE = {
  payment_failed:
    'The following features have been automatically disabled due to failure to pay ' +
    'BotApprove subscription:',
  cancelled:
    'The following features have been automatically disabled due to the subscription being ' +
    'cancelled and the billing period ending:',
  expired:
    'The following features have been automatically disabled due to your BotApprove licence ' +
    'expiring:',
  trial_ended:
    'The following features have been automatically disabled due to your BotApprove trial ' +
    'ending:',
  revoked:
    'The following features have been automatically disabled because your BotApprove licence ' +
    'was revoked:',
};

function lapseReasonFor(state, row) {
  const explicit = row?.lapse_reason;
  if (explicit && LAPSE_SENTENCE[explicit]) return explicit;
  if (LAPSE_SENTENCE[state]) return state;
  return null;
}

async function notifyTargets(guild) {
  const targets = new Map();

  const owner = await guild.fetchOwner().catch(() => null);
  if (owner) targets.set(owner.id, owner);

  const roleIds = approverRoles.list(guild.id);
  if (roleIds.length) {
    const members = await guild.members.fetch().catch(() => null);
    if (members) {
      for (const [, m] of members) {
        if (m.user.bot) continue;
        if (m.roles.cache.some((r) => roleIds.includes(r.id))) targets.set(m.id, m);
      }
    }
  }
  return [...targets.values()];
}

async function sendDowngradeNotice(guild, { reason, features }) {
  const embed = new EmbedBuilder()
    .setColor(0xd9a441)
    .setTitle('BotApprove, premium features disabled')
    .setDescription(
      `**${guild.name}**\n\n${LAPSE_SENTENCE[reason]}\n\n` +
      features.map((f) => `• **${f.name}**, ${f.blurb}`).join('\n'),
    )
    .addFields({
      name: 'Still active, free forever',
      value:
        'Bot approval gate · high-risk keyword blocking · audit trail · tamper detection · ' +
        'critical alerts.\n**Your server is still guarded.**',
    })
    .setTimestamp(new Date());

  if (config.paywall.purchaseUrl) {
    embed.addFields({ name: 'Reactivate', value: config.paywall.purchaseUrl });
  }

  const targets = await notifyTargets(guild);
  let delivered = 0;
  for (const member of targets) {
    const sent = await member.send({ embeds: [embed] }).then(() => true).catch(() => false);
    if (sent) delivered += 1;
  }

  if (!delivered) {
    const cfg = guildConfig.get(guild.id);
    const channelId = cfg.notify_channel_id ?? cfg.log_channel_id;
    const channel = channelId ? await guild.channels.fetch(channelId).catch(() => null) : null;
    const target = channel?.isTextBased?.() ? channel : guild.systemChannel;
    await target?.send({ embeds: [embed] }).catch(() => {});
  }

  return { targets: targets.length, delivered };
}

async function sendRestoreNotice(guild) {
  const embed = new EmbedBuilder()
    .setColor(0x3ba55d)
    .setTitle('BotApprove, premium features restored')
    .setDescription(`**${guild.name}**\n\nYour subscription is active again and every premium ` +
      'feature has been re-enabled. No reconfiguration is needed, your settings were kept.')
    .setTimestamp(new Date());

  for (const member of await notifyTargets(guild)) {
    await member.send({ embeds: [embed] }).catch(() => {});
  }
}

export async function enforceEntitlements(client) {
  if (!config.paywall.enabled) return { checked: 0, notified: 0, restored: 0 };

  let checked = 0;
  let notified = 0;
  let restored = 0;

  for (const [, guild] of client.guilds.cache) {
    checked += 1;
    try {
      const state = resolveEntitlement(guild.id);
      const row = entitlements.get(guild.id);

      if (state.licensed) {
        if (row?.downgrade_notified_at) {
          entitlements.clearDowngradeNotice(guild.id);
          entitlements.clearLapsed(guild.id);
          await sendRestoreNotice(guild).catch(() => {});
          await record({
            guildId: guild.id, action: 'premium_restored', severity: 'info',
            detail: { tier: state.tier },
          });
          restored += 1;
        }
        continue;
      }

      const reason = lapseReasonFor(state.state, row);
      if (!reason) continue;

      entitlements.markLapsed(guild.id, reason);
      if (row?.downgrade_notified_reason === reason) continue;

      const features = activeFeatureUsage({
        cfg: guildConfig.get(guild.id),
        customKeywordCount: keywords.rows(guild.id).filter((k) => k.added_by !== 'system').length,
        nukeCount: nukeRegistry.count(guild.id),
      });

      const delivery = await sendDowngradeNotice(guild, { reason, features });
      entitlements.markDowngradeNotified(guild.id, reason);
      notified += 1;

      await record({
        guildId: guild.id,
        action: 'premium_disabled',
        severity: 'medium',
        title: 'Premium features disabled',
        description: LAPSE_SENTENCE[reason],
        detail: {
          reason,
          features: features.map((f) => f.key),
          notified: delivery.delivered,
          targets: delivery.targets,
        },
      });
    } catch (err) {
      log.error('entitlement enforcement failed for guild', {
        guildId: guild.id, err: err.message,
      });
    }
  }

  if (notified || restored) {
    log.info('entitlement sweep complete', { checked, notified, restored });
  }
  return { checked, notified, restored };
}

export { hashKey, premiumKeys, FEATURES };
