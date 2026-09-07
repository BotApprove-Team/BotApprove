import { EmbedBuilder } from 'discord.js';
import { guildConfig } from '../db/queries.js';
import { config } from '../config.js';
import { featureSwitches } from './featureService.js';
import { record } from './securityService.js';
import { getClient } from '../bot/clientRef.js';
import { createLogger } from '../logger.js';

const log = createLogger('premium-welcome');

function buildEmbed(guild, dormant) {
  const lines = dormant.slice(0, 10).map((f) => `• **${f.name}** ${f.blurb}`);
  const more = dormant.length > 10 ? `\n…and ${dormant.length - 10} more.` : '';

  return new EmbedBuilder()
    .setColor(0x5e9bff)
    .setTitle('Premium is active on your server')
    .setDescription(
      `**${guild.name}** now has premium. Nothing has switched on by itself, because these `
      + 'change how BotApprove behaves and that should be your decision, not a surprise.',
    )
    .addFields(
      {
        name: `Waiting to be turned on (${dormant.length})`,
        value: (lines.join('\n') + more).slice(0, 1024) || 'Everything is already on.',
      },
      {
        name: 'Turn them on',
        value: `${config.web.baseUrl}/g/${guild.id}/protection`,
      },
      {
        name: 'The gate did not change',
        value: 'The approval gate, keyword blocking, the audit trail and tamper detection were '
          + 'already running and are unaffected.',
      },
    )
    .setFooter({ text: 'Sent once, when premium is first activated.' })
    .setTimestamp(new Date());
}

export async function announcePremium(guildId, { actorId = null } = {}) {
  const client = getClient();
  const guild = client?.guilds.cache.get(guildId);
  if (!guild) return { sent: false, reason: 'guild_unavailable' };

  const dormant = featureSwitches(guildId).filter((f) => f.entitled && !f.enabled);
  if (!dormant.length) return { sent: false, reason: 'nothing_dormant' };

  const embed = buildEmbed(guild, dormant);
  const cfg = guildConfig.get(guildId);
  const ownerId = guild.ownerId;

  let via = null;
  for (const id of [cfg?.announce_channel_id, cfg?.notify_channel_id, cfg?.log_channel_id]) {
    if (!id) continue;
    const channel = await guild.channels.fetch(id).catch(() => null);
    if (!channel?.isTextBased?.()) continue;
    const ok = await channel.send({
      content: ownerId ? `<@${ownerId}>` : undefined,
      embeds: [embed],
      allowedMentions: ownerId ? { users: [ownerId] } : { parse: [] },
    }).then(() => true).catch(() => false);
    if (ok) { via = 'channel'; break; }
  }

  if (!via) {
    const owner = await guild.fetchOwner().catch(() => null);
    if (owner) {
      const ok = await owner.send({ embeds: [embed] }).then(() => true).catch(() => false);
      if (ok) via = 'dm';
    }
  }

  await record({
    guildId,
    actorId,
    action: 'premium_activated_notice',
    severity: 'info',
    detail: { dormant: dormant.length, via: via ?? 'failed' },
    mirror: false,
  }).catch(() => {});

  log.info('premium welcome', { guildId, dormant: dormant.length, via });
  return { sent: !!via, via, dormant: dormant.length };
}
