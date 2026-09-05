import { EmbedBuilder } from 'discord.js';
import { AuditLogEvent } from 'discord.js';
import { guildConfig, removalEvents, nukeRegistry } from '../db/queries.js';
import { record } from './securityService.js';
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { getClient } from '../bot/clientRef.js';

const log = createLogger('removal-watch');

const pendingActor = new Map();
const ACTOR_TTL_MS = 30_000;

export function rememberGuild(guild) {
  try {
    guildConfig.set(guild.id, {
      owner_id: guild.ownerId ?? null,
      guild_name: guild.name ?? null,
    });
  } catch (err) {
    log.warn('could not cache guild identity', { guildId: guild.id, err: err.message });
  }
}

export function rememberAll(client) {
  for (const [, guild] of client.guilds.cache) rememberGuild(guild);
}

export async function onMemberRemoved(member) {
  const client = getClient();
  if (!client || member.id !== client.user?.id) return;

  const guild = member.guild;
  log.alert('BotApprove was removed from a guild', { guildId: guild.id, name: guild.name });

  let actor = null;
  try {
    for (const type of [AuditLogEvent.MemberKick, AuditLogEvent.MemberBanAdd]) {
      const logs = await guild.fetchAuditLogs({ type, limit: 6 }).catch(() => null);
      const entry = logs?.entries?.find(
        (e) => e.target?.id === client.user.id && Date.now() - e.createdTimestamp < 30_000,
      );
      if (entry?.executor) {
        actor = {
          id: entry.executor.id,
          tag: entry.executor.tag,
          bot: !!entry.executor.bot,
          action: type === AuditLogEvent.MemberKick ? 'kick' : 'ban',
        };
        break;
      }
    }
  } catch (err) {
    log.warn('audit lookup during removal failed', { guildId: guild.id, err: err.message });
  }

  if (actor) {
    pendingActor.set(guild.id, { ...actor, at: Date.now() });
    setTimeout(() => pendingActor.delete(guild.id), ACTOR_TTL_MS).unref?.();
  }
}

export async function onGuildRemoved(guild) {
  if (guild.available === false) {
    log.info('guild unavailable, treating as outage not removal', { guildId: guild.id });
    return { ignored: 'outage' };
  }

  const cached = guildConfig.get(guild.id);
  const ownerId = guild.ownerId ?? cached?.owner_id ?? null;
  const guildName = guild.name ?? cached?.guild_name ?? guild.id;

  const actor = pendingActor.get(guild.id) ?? null;
  pendingActor.delete(guild.id);

  const info = removalEvents.create({
    guildId: guild.id,
    guildName,
    actorId: actor?.id,
    actorTag: actor?.tag,
    actorIsBot: actor?.bot,
    action: actor?.action ?? 'unknown',
    ownerId,
  });
  const eventId = Number(info.lastInsertRowid);

  await record({
    guildId: guild.id,
    actorId: actor?.id,
    action: 'botapprove_removed',
    severity: 'critical',
    title: 'BotApprove was removed from a server',
    description: actor
      ? `Removed by ${actor.tag} (${actor.bot ? 'bot' : 'user'}) via ${actor.action}.`
      : 'The responsible account could not be identified before access was lost.',
    detail: { guild: guildName, event_id: eventId, actor_is_bot: actor?.bot },
    mirror: false,
  });

  if (actor?.bot) {
    try {
      nukeRegistry.add(guild.id, actor.id, {
        botTag: actor.tag,
        confirmedBy: 'system',
        reason: `Removed BotApprove from this server via ${actor.action}`,
      });
      log.alert('bot that removed us added to this guild nuke registry', {
        guildId: guild.id, botId: actor.id,
      });
    } catch (err) {
      log.warn('could not register removing bot', { err: err.message });
    }
  }

  const delivered = await notifyOwner({ ownerId, guildName, actor });
  if (delivered) removalEvents.markNotified(eventId);

  return { removed: true, actor, notified: delivered };
}

async function notifyOwner({ ownerId, guildName, actor }) {
  if (!ownerId) {
    log.warn('no cached owner to notify about removal', { guildName });
    return false;
  }

  const client = getClient();
  const owner = await client?.users.fetch(ownerId).catch(() => null);
  if (!owner) return false;

  const who = actor
    ? `**${actor.tag}**${actor.bot ? ' (a bot)' : ''}`
    : '**someone**';

  const embed = new EmbedBuilder()
    .setColor(0xf85149)
    .setTitle('BotApprove has been removed from your server')
    .setDescription(
      `BotApprove has been ${actor?.action === 'ban' ? 'banned' : 'kicked'} from ` +
      `**${guildName}** by ${who}. **Your server is at risk.**\n\n` +
      'Until it is re-added, any bot can join without approval.',
    )
    .addFields({
      name: 'If this was not you',
      value: actor?.bot
        ? 'A bot removed it, which is what a nuke tool does first. Check your audit log and ' +
          'remove that bot before re-inviting BotApprove. It has been added to this server\'s ' +
          'blocklist and will be kicked on sight once BotApprove is back.'
        : 'Check your audit log for what else that account changed, and review who holds ' +
          'Kick Members and Manage Server.',
    })
    .addFields({
      name: 'Re-invite',
      value: config.inviteUrl,
    })
    .setFooter({ text: 'Your settings, whitelist and keyword list were all kept.' })
    .setTimestamp(new Date());

  const sent = await owner.send({ embeds: [embed] }).then(() => true).catch(() => false);
  if (!sent) log.warn('owner DM about removal failed', { ownerId, guildName });
  return sent;
}
