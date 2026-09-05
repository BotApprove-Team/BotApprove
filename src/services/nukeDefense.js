import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionsBitField,
} from 'discord.js';
import {
  nukeRegistry,
  knownNukeBots,
  nukeIncidents,
  nukeDbRequests,
  guildConfig,
} from '../db/queries.js';
import { record } from './securityService.js';
import { hasFeature } from './featureService.js';
import { createLogger } from '../logger.js';

const log = createLogger('nuke-defense');

export const INCIDENT_PREFIX = 'ba:inc';
export const INVITER_ACTIONS = ['none', 'kick', 'ban'];

export function isConfirmedNukeBot(guildId, botId) {
  return nukeRegistry.has(guildId, botId);
}

export function isKnownNukeBot(guildId, botId) {
  if (!hasFeature(guildId, 'known_nuke_db')) return false;
  return knownNukeBots.has(botId);
}

export async function confirmNukeBot(guildId, botId, { botTag, confirmedBy, reason }) {
  nukeRegistry.add(guildId, botId, { botTag, confirmedBy, reason });
  await record({
    guildId,
    botId,
    actorId: confirmedBy,
    action: 'nuke_bot_confirmed',
    severity: 'critical',
    title: '☢️ Bot confirmed as a nuke bot',
    description:
      'Future joins of this bot id are kicked on sight, and, where enabled, whoever ' +
      'invites it is banned.',
    detail: { bot_tag: botTag, reason },
  });
  return true;
}

export async function unconfirmNukeBot(guildId, botId, actorId) {
  const info = nukeRegistry.remove(guildId, botId);
  if (info.changes) {
    await record({
      guildId, botId, actorId, action: 'nuke_bot_unconfirmed', severity: 'medium',
      title: 'Nuke bot confirmation withdrawn',
    });
  }
  return info.changes > 0;
}

export async function addKnownNukeBot({ botId, botTag, reason, addedBy, source = 'manual' }) {
  knownNukeBots.add({ botId, botTag, reason, source, addedBy });
  await record({
    botId, actorId: addedBy, action: 'known_nuke_bot_added', severity: 'high',
    detail: { bot_tag: botTag, reason, source }, mirror: false,
  });
}

export async function removeKnownNukeBot(botId, actorId) {
  const info = knownNukeBots.remove(botId);
  if (info.changes) {
    await record({
      botId, actorId, action: 'known_nuke_bot_removed', severity: 'medium', mirror: false,
    });
  }
  return info.changes > 0;
}

export async function requestKnownNukeBot({ botId, botTag, reason, requestedBy, requestedByTag, guild }) {
  if (knownNukeBots.has(botId)) return { ok: false, reason: 'already_listed' };
  if (nukeDbRequests.openFor(botId, guild.id)) return { ok: false, reason: 'already_requested' };

  const trimmed = String(reason ?? '').trim();
  if (trimmed.length < 10) return { ok: false, reason: 'reason_too_short' };

  const info = nukeDbRequests.create({
    botId,
    botTag,
    reason: trimmed.slice(0, 1000),
    requestedBy,
    requestedByTag,
    guildId: guild.id,
    guildName: guild.name,
  });

  await record({
    guildId: guild.id,
    botId,
    actorId: requestedBy,
    action: 'nuke_db_requested',
    severity: 'medium',
    title: 'Submitted to the shared threat list for review',
    description: 'Pending operator approval. Nothing changes on other servers until then.',
    detail: { request_id: Number(info.lastInsertRowid), reason: trimmed.slice(0, 200) },
  });

  return { ok: true, id: Number(info.lastInsertRowid) };
}

export async function reviewNukeRequest({ id, decision, reviewerId, note }) {
  const status = decision === 'approve' ? 'approved' : 'rejected';
  const row = nukeDbRequests.resolve(id, status, reviewerId, note);
  if (!row) {
    const existing = nukeDbRequests.byId(id);
    return { ok: false, reason: existing ? 'already_reviewed' : 'not_found', existing };
  }

  if (status === 'approved') {
    knownNukeBots.add({
      botId: row.bot_id,
      botTag: row.bot_tag,
      reason: row.reason,
      source: `request#${row.id}`,
      addedBy: reviewerId,
    });
  }

  await record({
    guildId: row.guild_id,
    botId: row.bot_id,
    actorId: reviewerId,
    action: status === 'approved' ? 'nuke_db_request_approved' : 'nuke_db_request_rejected',
    severity: status === 'approved' ? 'high' : 'info',
    title: status === 'approved'
      ? 'Added to the shared threat list'
      : 'Threat list submission rejected',
    detail: { request_id: row.id, note: note ?? undefined },
  });

  return { ok: true, row, status };
}

async function inviterEligibility(guild, userId, action) {
  if (action === 'none') return { allowed: false, reason: 'action_disabled' };
  if (!userId) return { allowed: false, reason: 'inviter_unknown' };
  if (userId === guild.client.user.id) return { allowed: false, reason: 'target_is_self' };
  if (userId === guild.ownerId) return { allowed: false, reason: 'target_is_guild_owner' };

  const me = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
  if (!me) return { allowed: false, reason: 'self_member_unavailable' };

  const needed = action === 'ban'
    ? PermissionsBitField.Flags.BanMembers
    : PermissionsBitField.Flags.KickMembers;
  if (!me.permissions.has(needed)) {
    return { allowed: false, reason: action === 'ban' ? 'missing_ban_members' : 'missing_kick_members' };
  }

  if (action === 'ban') {
    const existing = await guild.bans.fetch(userId).catch(() => null);
    if (existing) return { allowed: false, reason: 'already_banned' };
  }

  const member = await guild.members.fetch(userId).catch(() => null);
  if (action === 'kick' && !member) return { allowed: false, reason: 'not_in_server' };
  if (member && me.roles.highest.comparePositionTo(member.roles.highest) <= 0) {
    return { allowed: false, reason: 'target_role_is_higher' };
  }

  return { allowed: true, member };
}

export async function actOnInviter(guild, userId, action, { botId, botTag, actorId = null, incidentId = null }) {
  const eligibility = await inviterEligibility(guild, userId, action);

  if (!eligibility.allowed) {
    await record({
      guildId: guild.id,
      botId,
      actorId: userId,
      action: 'nuke_inviter_action_skipped',
      severity: eligibility.reason === 'action_disabled' ? 'medium' : 'high',
      title: `Inviter was NOT ${action === 'ban' ? 'banned' : 'kicked'}`,
      description: `Reason: \`${eligibility.reason}\`. Review this account manually.`,
      detail: { bot_id: botId, bot_tag: botTag, attempted: action, incident: incidentId },
    });
    return { done: false, action, reason: eligibility.reason };
  }

  const reason = `BotApprove: invited nuke bot ${botTag ?? botId}`;
  try {
    if (action === 'ban') {
      await guild.bans.create(userId, { reason, deleteMessageSeconds: 0 });
    } else {
      await eligibility.member.kick(reason);
    }

    await record({
      guildId: guild.id,
      botId,
      actorId: userId,
      action: action === 'ban' ? 'nuke_inviter_banned' : 'nuke_inviter_kicked',
      severity: 'critical',
      title: action === 'ban' ? '🔨 Nuke bot inviter banned' : 'Nuke bot inviter kicked',
      description: `<@${userId}> invited \`${botTag ?? botId}\`.`,
      detail: { bot_id: botId, bot_tag: botTag, decided_by: actorId, incident: incidentId },
    });
    return { done: true, action };
  } catch (err) {
    await record({
      guildId: guild.id,
      botId,
      actorId: userId,
      action: 'nuke_inviter_action_failed',
      severity: 'critical',
      title: `${action === 'ban' ? 'Ban' : 'Kick'} of a nuke bot inviter FAILED`,
      description: 'The account is untouched. Handle it manually.',
      detail: { bot_id: botId, attempted: action, error: err.message },
    });
    log.error('inviter action failed', { guildId: guild.id, userId, action, err: err.message });
    return { done: false, action, reason: 'api_error', error: err };
  }
}

export async function banNukeInviter(guild, userId, { botId, botTag, actorId = null, viaConfirmation = false }) {
  const cfg = guildConfig.get(guild.id);
  if (!cfg.auto_ban_nuke_inviters) {
    await record({
      guildId: guild.id, botId, actorId: userId,
      action: 'nuke_inviter_ban_skipped', severity: 'medium',
      title: 'Nuke bot inviter was NOT banned',
      description: 'Reason: `not_enabled`. Turn on `/config auto-ban` to ban inviters.',
      detail: { bot_id: botId, bot_tag: botTag },
    });
    return { banned: false, reason: 'not_enabled' };
  }
  if (!hasFeature(guild.id, 'auto_ban_inviters')) {
    return { banned: false, reason: 'premium_required' };
  }
  const result = await actOnInviter(guild, userId, 'ban', { botId, botTag, actorId });
  return { banned: result.done, reason: result.reason, viaConfirmation };
}

export async function handleKnownNukeBotJoin(member, { resolveInviter }) {
  const guild = member.guild;
  const botId = member.id;
  const botTag = member.user.tag;
  const entry = knownNukeBots.get(botId);
  const cfg = guildConfig.get(guild.id);

  let botAction = 'failed';
  const me = guild.members.me;
  const canBan = me?.permissions.has(PermissionsBitField.Flags.BanMembers);
  try {
    if (canBan) {
      await guild.bans.create(botId, {
        reason: `BotApprove: known nuke bot (${entry?.reason ?? 'on threat list'})`,
        deleteMessageSeconds: 0,
      });
      botAction = 'banned';
    } else {
      await member.kick('BotApprove: known nuke bot');
      botAction = 'kicked';
    }
  } catch (err) {
    log.error('failed to remove known nuke bot', { guildId: guild.id, botId, err: err.message });
  }

  const found = await resolveInviter?.().catch(() => null);
  const inviter = found?.known ? found : null;

  await record({
    guildId: guild.id,
    botId,
    action: 'known_nuke_bot_blocked',
    severity: 'critical',
    title: '☢️ KNOWN NUKE BOT BLOCKED',
    description: `\`${botTag}\`is on the shared threat list` +
      (entry?.reason ? `: ${entry.reason}` : '.') +
      (botAction === 'banned' ? '\nBanned from this server.'
        : botAction === 'kicked' ? '\nKicked, grant Ban Members to block it permanently.'
        : '\n**Removal FAILED, it may still be in the server.**'),
    detail: { bot_tag: botTag, bot_action: botAction, inviter: inviter?.id ?? 'unknown' },
  });

  const configured = INVITER_ACTIONS.includes(cfg.nuke_inviter_action)
    ? cfg.nuke_inviter_action
    : 'kick';
  const inviterResult = await actOnInviter(guild, inviter?.id, configured, { botId, botTag });

  const info = nukeIncidents.create({
    guildId: guild.id,
    botId,
    botTag,
    inviterId: inviter?.id ?? null,
    inviterTag: inviter?.tag ?? null,
    botAction,
    inviterAction: inviterResult.done ? configured : `${configured}_failed:${inviterResult.reason}`,
  });
  const incidentId = Number(info.lastInsertRowid);

  await notifyOwnerOfIncident(guild, {
    incidentId, botId, botTag, entry, botAction, inviter, inviterResult, configured,
  }).catch((err) => log.warn('owner DM failed', { guildId: guild.id, err: err.message }));

  return { incidentId, botAction, inviterResult };
}

function buildIncidentEmbed(guild, { botTag, botId, entry, botAction, inviter, inviterResult, configured }) {
  const embed = new EmbedBuilder()
    .setColor(0x992d22)
    .setTitle('☢️ A nuke bot was invited to your server')
    .setDescription(
      inviter?.id
        ? `<@${inviter.id}> (**${inviter.tag ?? 'unknown'}**) invited a nuke bot to ` +
          `**${guild.name}**.`
        : `A nuke bot was invited to **${guild.name}**, but the audit log did not say by whom.`,
    )
    .addFields(
      { name: 'Bot', value: `\`${botTag}\`\n\`${botId}\``, inline: true },
      {
        name: 'Bot removed',
        value: botAction === 'banned' ? 'Banned'
        : botAction === 'kicked' ? 'Kicked only'
        : '**Removal failed**',
        inline: true,
      },
      {
        name: 'Listed because',
        value: entry?.reason ?? 'On the shared nuke bot threat list.',
      },
      {
        name: 'Action taken on the inviter',
        value: inviterResult?.done
        ? (configured === 'ban' ? 'Banned' : 'Kicked')
          : `None, \`${inviterResult?.reason ?? 'unknown'}\``,
      },
    )
    .setFooter({ text: `${guild.name} · incident #` })
    .setTimestamp(new Date());

  if (inviter?.avatarUrl) embed.setThumbnail(inviter.avatarUrl);
  return embed;
}

async function notifyOwnerOfIncident(guild, ctx) {
  const owner = await guild.fetchOwner().catch(() => null);
  const embed = buildIncidentEmbed(guild, ctx)
    .setFooter({ text: `${guild.name} · incident #${ctx.incidentId}` });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${INCIDENT_PREFIX}:ban:${ctx.incidentId}`)
      .setLabel('Ban inviter').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`${INCIDENT_PREFIX}:kick:${ctx.incidentId}`)
      .setLabel('Kick inviter').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${INCIDENT_PREFIX}:unban:${ctx.incidentId}`)
      .setLabel('Undo, unban').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${INCIDENT_PREFIX}:dismiss:${ctx.incidentId}`)
      .setLabel('Leave as is').setStyle(ButtonStyle.Secondary),
  );

  const payload = { embeds: [embed], components: ctx.inviter?.id ? [row] : [] };

  let delivered = false;
  if (owner) delivered = await owner.send(payload).then(() => true).catch(() => false);

  if (!delivered) {
    const cfg = guildConfig.get(guild.id);
    const id = cfg.notify_channel_id ?? cfg.log_channel_id;
    const channel = id ? await guild.channels.fetch(id).catch(() => null) : null;
    const target = channel?.isTextBased?.() ? channel : guild.systemChannel;
    await target?.send({
      content: owner ? `<@${owner.id}>` : undefined,
      ...payload,
    }).catch(() => {});
  }

  return delivered;
}

export async function resolveIncident({ incidentId, choice, actorId, guild }) {
  const incident = nukeIncidents.byId(incidentId);
  if (!incident) return { ok: false, reason: 'not_found' };
  if (incident.guild_id !== guild.id) return { ok: false, reason: 'wrong_guild' };
  if (actorId !== guild.ownerId) return { ok: false, reason: 'not_owner' };

  const { inviter_id: inviterId, bot_id: botId, bot_tag: botTag } = incident;
  if (!inviterId && choice !== 'dismiss') return { ok: false, reason: 'inviter_unknown' };

  let outcome;
  if (choice === 'dismiss') {
    outcome = { done: true, action: 'none' };
  } else if (choice === 'unban') {
    outcome = await guild.bans.remove(inviterId, `BotApprove: owner reversed incident #${incidentId}`)
      .then(() => ({ done: true, action: 'unban' }))
      .catch((err) => ({ done: false, action: 'unban', reason: err.message }));
    if (outcome.done) {
      await record({
        guildId: guild.id, botId, actorId,
        action: 'nuke_inviter_unbanned', severity: 'high',
        title: 'Owner reversed a nuke bot inviter ban',
        detail: { inviter: inviterId, incident: incidentId },
      });
    }
  } else {
    outcome = await actOnInviter(guild, inviterId, choice, {
      botId, botTag, actorId, incidentId,
    });
  }

  if (!outcome.done) return { ok: false, reason: outcome.reason ?? 'failed', outcome };

  const resolved = nukeIncidents.resolve(incidentId, choice, actorId);
  if (!resolved) return { ok: false, reason: 'already_resolved', existing: incident };

  return { ok: true, choice, outcome, incident: resolved };
}

export async function handleConfirmedNukeRejoin(guild, { botId, botTag, inviterId }) {
  await record({
    guildId: guild.id,
    botId,
    action: 'nuke_bot_rejoin',
    severity: 'critical',
    title: '☢️ A confirmed nuke bot tried to rejoin',
    description: 'Kicked on sight, the whitelist and any token were not consulted.',
    detail: { bot_tag: botTag, inviter: inviterId ?? 'unknown' },
  });

  if (!inviterId) return { banned: false, reason: 'inviter_unknown' };
  return banNukeInviter(guild, inviterId, { botId, botTag });
}
