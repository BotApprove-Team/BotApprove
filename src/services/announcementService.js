import { EmbedBuilder, PermissionsBitField } from 'discord.js';
import { guildConfig, announcements } from '../db/queries.js';
import { checkChannel } from './channelCheck.js';
import { record } from './securityService.js';
import { createLogger } from '../logger.js';

const log = createLogger('announce');

export const MAX_BODY = 3500;
export const MAX_TITLE = 200;

export function validate({ title, body }) {
  const b = String(body ?? '').trim();
  if (b.length < 3) return { ok: false, reason: 'Announcement body is empty.' };
  if (b.length > MAX_BODY) return { ok: false, reason: `Body must be under ${MAX_BODY} characters.` };
  if (String(title ?? '').length > MAX_TITLE) {
    return { ok: false, reason: `Title must be under ${MAX_TITLE} characters.` };
  }
  return { ok: true, title: String(title ?? '').trim() || null, body: b };
}

export function preview(client) {
  const rows = [];
  for (const [, guild] of client.guilds.cache) {
    const cfg = guildConfig.get(guild.id);
    rows.push({
      id: guild.id,
      name: guild.name,
      channelId: cfg.announce_channel_id,
      allowsEveryone: !!cfg.announce_allow_everyone,
      optedIn: !!cfg.announce_channel_id,
    });
  }
  return rows.sort((a, b) => Number(b.optedIn) - Number(a.optedIn));
}

export async function broadcast(client, {
  title, body, everyone, sentBy, guildIds = null, pingOwner = false,
}) {
  const valid = validate({ title, body });
  if (!valid.ok) return { ok: false, reason: valid.reason };

  const directed = Array.isArray(guildIds) && guildIds.length > 0;
  const wanted = directed ? new Set(guildIds) : null;

  const info = announcements.create({
    title: valid.title,
    body: valid.body,
    requestedEveryone: everyone,
    sentBy,
  });
  const announcementId = Number(info.lastInsertRowid);

  let delivered = 0;
  let skipped = 0;
  let failed = 0;
  let pinged = 0;

  for (const [, guild] of client.guilds.cache) {
    if (wanted && !wanted.has(guild.id)) continue;

    const cfg = guildConfig.get(guild.id);

    const candidates = directed
      ? [cfg.announce_channel_id, cfg.notify_channel_id, cfg.log_channel_id].filter(Boolean)
      : [cfg.announce_channel_id].filter(Boolean);

    if (!candidates.length) {
      skipped += 1;
      announcements.recordTarget({
        announcementId,
        guildId: guild.id,
        status: 'skipped',
        detail: directed ? 'no usable channel' : 'no channel configured',
      });
      continue;
    }

    let health = null;
    let lastReason = null;
    for (const id of candidates) {
      const probe = await checkChannel(guild, id);
      if (probe.ok) { health = probe; break; }
      lastReason = probe.reason ?? `missing ${probe.missing.join(', ')}`;
    }

    if (!health) {
      failed += 1;
      announcements.recordTarget({
        announcementId,
        guildId: guild.id,
        status: 'failed',
        detail: lastReason,
      });
      continue;
    }

    const me = guild.members.me;
    const canMention = me?.permissions.has(PermissionsBitField.Flags.MentionEveryone)
      || health.channel.permissionsFor(me)?.has(PermissionsBitField.Flags.MentionEveryone);
    const ping = !!everyone && !!cfg.announce_allow_everyone && !!canMention;

    const ownerId = pingOwner ? guild.ownerId : null;
    const mentions = [ping ? '@everyone' : null, ownerId ? `<@${ownerId}>` : null]
      .filter(Boolean).join(' ');

    const embed = new EmbedBuilder()
      .setColor(0x5e9bff)
      .setDescription(valid.body)
      .setFooter({ text: 'BotApprove announcement' })
      .setTimestamp(new Date());
    if (valid.title) embed.setTitle(valid.title);

    try {
      await health.channel.send({
        content: mentions || undefined,
        embeds: [embed],
        allowedMentions: {
          parse: ping ? ['everyone'] : [],
          users: ownerId ? [ownerId] : [],
        },
      });
      delivered += 1;
      if (ping) pinged += 1;
      announcements.recordTarget({
        announcementId,
        guildId: guild.id,
        status: 'delivered',
        pingedEveryone: ping,
        detail: everyone && !ping
          ? (cfg.announce_allow_everyone ? 'missing MentionEveryone' : 'server disallows @everyone')
          : null,
      });
    } catch (err) {
      failed += 1;
      announcements.recordTarget({
        announcementId, guildId: guild.id, status: 'failed', detail: err.message,
      });
      log.warn('announcement delivery failed', { guildId: guild.id, err: err.message });
    }
  }

  announcements.finish(announcementId, { delivered, skipped, failed });

  await record({
    actorId: sentBy,
    action: 'announcement_sent',
    severity: 'medium',
    detail: { id: announcementId, delivered, skipped, failed, pinged, requested_everyone: !!everyone },
    mirror: false,
  });

  log.info('announcement broadcast', { announcementId, delivered, skipped, failed });
  return { ok: true, id: announcementId, delivered, skipped, failed, pinged };
}
