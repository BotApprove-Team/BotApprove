import { EmbedBuilder } from 'discord.js';
import {
  whitelist,
  keywords,
  reinviteTokens,
  guildConfig,
  securityLog,
} from '../db/queries.js';
import { config } from '../config.js';
import { hasFeature } from './featureService.js';
import { createLogger } from '../logger.js';
import { getClient } from '../bot/clientRef.js';

const log = createLogger('security');

const SEVERITY_COLOR = {
  info: 0x5865f2,
  low: 0x57f287,
  medium: 0xfee75c,
  high: 0xed4245,
  critical: 0x992d22,
};

export async function record({
  guildId,
  botId,
  actorId,
  action,
  severity = 'info',
  detail = {},
  mirror = true,
  title,
  description,
}) {
  try {
    securityLog.write({ guildId, botId, actorId, action, severity, detail });
  } catch (err) {
    log.error('security_log write failed', { action, guildId, err: err.message });
  }

  const level = severity === 'critical' || severity === 'high' ? 'alert' : 'info';
  log[level === 'alert' ? 'alert' : 'info'](action, { guildId, botId, actorId, severity, ...detail });

  if (!mirror || !guildId) return;

  try {
    const cfg = guildConfig.get(guildId);
    if (!cfg?.log_channel_id) return;

    if (!hasFeature(guildId, 'log_channel')) return;

    const client = getClient();
    if (!client) return;

    const channel = await client.channels.fetch(cfg.log_channel_id).catch(() => null);
    if (!channel?.isTextBased?.()) return;

    const embed = new EmbedBuilder()
      .setColor(SEVERITY_COLOR[severity] ?? SEVERITY_COLOR.info)
      .setTitle(title ?? action.replace(/_/g, ' ').toUpperCase())
      .setTimestamp(new Date());

    if (description) embed.setDescription(description);
    if (botId) embed.addFields({ name: 'Bot', value: `<@${botId}> \`${botId}\``, inline: true });
    if (actorId) embed.addFields({ name: 'Actor', value: `<@${actorId}> \`${actorId}\``, inline: true });

    const extra = Object.entries(detail).filter(([, v]) => v !== undefined && v !== null);
    if (extra.length) {
      embed.addFields({
        name: 'Detail',
        value: extra.map(([k, v]) => `\`${k}\`: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
          .join('\n').slice(0, 1024),
      });
    }

    await channel.send({ embeds: [embed] });
  } catch (err) {
    log.warn('log channel mirror failed', { guildId, action, err: err.message });
  }
}

export function seedDefaultKeywords(guildId) {
  const cfg = guildConfig.get(guildId);
  if (cfg.seeded_keywords) return false;
  for (const word of config.defaults.keywords) {
    keywords.add(guildId, word, 'system');
  }
  guildConfig.markSeeded(guildId);
  log.info('seeded default keywords', { guildId, count: config.defaults.keywords.length });
  return true;
}

export function matchKeyword(guildId, username) {
  const name = String(username ?? '').toLowerCase();
  if (!name) return null;

  for (const keyword of keywords.list(guildId)) {
    if (keyword && name.includes(keyword.toLowerCase())) return keyword;
  }
  return null;
}

export async function kickBot(member, { reason, actorId = null, severity = 'medium', detail = {} }) {
  const guildId = member.guild.id;
  const botId = member.id;

  try {
    await member.kick(reason?.slice(0, 512) ?? 'BotApprove: bot not approved');
    await record({
      guildId,
      botId,
      actorId,
      action: 'kick',
      severity,
      title: 'Bot kicked',
      description: reason,
      detail: { ...detail, bot_tag: member.user?.tag },
    });
    return { ok: true };
  } catch (err) {
    await record({
      guildId,
      botId,
      actorId,
      action: 'kick_failed',
      severity: 'critical',
      title: 'KICK FAILED, unapproved bot is still in the server',
      description:
        'BotApprove could not remove this bot. Check that it still has Kick Members and that ' +
        'its role sits above the new bot. This is a likely tampering signal.',
      detail: { ...detail, error: err.message, bot_tag: member.user?.tag },
    });
    return { ok: false, error: err };
  }
}

export async function isWhitelisted(guildId, botId) {
  return whitelist.has(guildId, botId);
}

export async function addToWhitelist(guildId, botId, approvedBy, detail = {}) {
  whitelist.add(guildId, botId, approvedBy);
  await record({
    guildId,
    botId,
    actorId: approvedBy,
    action: 'whitelist_add',
    severity: 'medium',
    title: 'Bot whitelisted',
    detail,
  });
}

export async function removeFromWhitelist(guildId, botId, actorId, detail = {}) {
  const info = whitelist.remove(guildId, botId);
  await record({
    guildId,
    botId,
    actorId,
    action: 'whitelist_remove',
    severity: 'medium',
    title: 'Bot removed from whitelist',
    detail: { ...detail, removed: info.changes },
  });
  return info.changes > 0;
}

export async function issueReinviteToken(guildId, botId, issuedBy, detail = {}) {
  const expiresAt = reinviteTokens.issue(guildId, botId, issuedBy);
  await record({
    guildId,
    botId,
    actorId: issuedBy,
    action: 'token_issue',
    severity: 'high',
    title: 'Re-invite token issued',
    description:
      `Single-use pass for this bot only, valid until <t:${Math.floor(expiresAt / 1000)}:T>. ` +
      'Re-invite the bot manually before it expires.',
    detail: { ...detail, expires_at: expiresAt },
  });
  return expiresAt;
}

export async function consumeReinviteToken(guildId, botId, detail = {}) {
  const result = reinviteTokens.consume(guildId, botId);

  if (result.consumed) {
    await record({
      guildId,
      botId,
      action: 'token_consume',
      severity: 'high',
      title: 'Re-invite token consumed',
      description: 'Keyword-flagged bot passed the hard gate using its one-shot token.',
      detail: { ...detail, issued_at: result.row.issued_at, issued_by: result.row.issued_by },
    });
  } else if (result.reason === 'expired') {
    await record({
      guildId,
      botId,
      action: 'token_expired',
      severity: 'high',
      title: 'Re-invite token had expired',
      description: 'The bot rejoined after its window closed. Treated as unapproved.',
      detail: { ...detail, expired_at: result.row?.expires_at },
    });
  }

  return result;
}

export async function revokeReinviteToken(guildId, botId, actorId) {
  const info = reinviteTokens.revoke(guildId, botId);
  if (info.changes) {
    await record({
      guildId,
      botId,
      actorId,
      action: 'token_revoke',
      severity: 'medium',
      title: 'Re-invite token revoked',
    });
  }
  return info.changes > 0;
}
