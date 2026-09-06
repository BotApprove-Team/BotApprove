import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionsBitField,
  AuditLogEvent,
} from 'discord.js';
import {
  pendingApprovals,
  approverRoles,
  guildConfig,
  approvalVotes,
} from '../db/queries.js';
import {
  addToWhitelist,
  issueReinviteToken,
  record,
} from './securityService.js';
import { probeUserAssets } from './imageProbe.js';
import { hasFeature } from './featureService.js';
import { describe as describeImpersonation } from './impersonation.js';
import { checkChannel, describeChannelProblem } from './channelCheck.js';
import { confirmNukeBot, banNukeInviter } from './nukeDefense.js';
import { createLogger } from '../logger.js';
import { getClient } from '../bot/clientRef.js';

const log = createLogger('approval');

export const BUTTON_PREFIX = 'ba';

const DANGEROUS = [
  'Administrator',
  'ManageGuild',
  'ManageRoles',
  'ManageChannels',
  'ManageWebhooks',
  'BanMembers',
  'KickMembers',
  'ModerateMembers',
  'ManageMessages',
  'MentionEveryone',
];

export function snapshotMember(member) {
  const roles = member.roles.cache
    .filter((r) => r.id !== member.guild.id)
    .map((r) => ({ id: r.id, name: r.name, position: r.position, managed: r.managed }));

  const perms = member.permissions;
  return {
    roles,
    permissionsBitfield: perms.bitfield.toString(),
    dangerous: DANGEROUS.filter((p) => perms.has(PermissionsBitField.Flags[p])),
    isAdministrator: perms.has(PermissionsBitField.Flags.Administrator),
    joinedAt: member.joinedTimestamp,
  };
}

export async function findInviter(guild, botId) {
  try {
    const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.BotAdd, limit: 10 });
    const entry = logs.entries.find((e) => e.target?.id === botId);
    if (!entry) return { known: false, reason: 'no_matching_entry' };
    return {
      known: true,
      id: entry.executor?.id ?? null,
      tag: entry.executor?.tag ?? null,
      avatarUrl: entry.executor?.displayAvatarURL({ size: 256 }) ?? null,
      at: entry.createdTimestamp,
    };
  } catch (err) {
    log.warn('audit log lookup failed', { guildId: guild.id, botId, err: err.message });
    return { known: false, reason: 'audit_log_unavailable', error: err.message };
  }
}

function fmtTimestamp(ms) {
  if (!ms) return 'unknown';
  const s = Math.floor(ms / 1000);
  return `<t:${s}:F> (<t:${s}:R>)`;
}

export function buildApprovalMessage({
  pendingId,
  guild,
  botUser,
  snapshot,
  inviter,
  images,
  keywordMatched,
  tokenConsumed,
  kickOk,
  threshold,
  imagesGated = false,
  impersonation = null,
  whitelistExpired = false,
  accountAge = null,
  quorumRequired = 0,
}) {
  const highRisk = !!keywordMatched && !tokenConsumed;
  const embed = new EmbedBuilder()
    .setColor(highRisk ? 0xed4245 : 0xfee75c)
    .setTitle(highRisk ? '⛔ HIGH-RISK BOT BLOCKED, approval required' : 'Bot kicked, approval required')
    .setDescription(
      `**${botUser.tag}** tried to join and was removed pending review.\n` +
      'Nothing is trusted by default here, including bots invited by the owner.',
    )
    .setFooter({ text: `Approval #${pendingId} • ${guild.name}` })
    .setTimestamp(new Date());

  const files = [];

  if (images?.avatar?.buffer) {
    files.push(new AttachmentBuilder(images.avatar.buffer, { name: 'avatar.png' }));
    embed.setThumbnail('attachment://avatar.png');
  }
  if (images?.banner?.buffer) {
    files.push(new AttachmentBuilder(images.banner.buffer, { name: 'banner.png' }));
    embed.setImage('attachment://banner.png');
  }

  embed.addFields(
    // The tag rather than a mention: by the time this card is posted the bot has
    // already been kicked, so Discord cannot resolve <@id> and renders it as
    // raw text. A mention to something no longer in the server is useless even
    // when it does resolve.
    {
      name: 'Bot',
      value: `**${botUser.tag ?? botUser.username ?? 'unknown'}**\n\`${botUser.id}\``,
      inline: true,
    },
    { name: 'Account created', value: fmtTimestamp(botUser.createdTimestamp), inline: true },
    {
      name: 'Discord verified',
      value: botUser.flags?.has?.('VerifiedBot')
      ? 'Verified, *shown for context only, not trusted*'
      : 'Not verified',
      inline: true,
    },
    {
      name: 'Added by',
      value: inviter?.known
        ? `<@${inviter.id}> \`${inviter.id}\``
        : `Unknown (${inviter?.reason ?? 'not found'})`,
      inline: true,
    },
    {
      name: 'Removed from server',
      value: kickOk ? 'Yes' : '**NO, kick failed, bot may still be present**',
      inline: true,
    },
  );

  const permLines = [];
  if (snapshot?.roles?.length) {
    permLines.push(`Roles: ${snapshot.roles.map((r) => `\`${r.name}\``).join(', ')}`);
  }
  if (snapshot?.isAdministrator) {
    permLines.push('**ADMINISTRATOR**, full control of the server');
  } else if (snapshot?.dangerous?.length) {
    permLines.push(`Sensitive: ${snapshot.dangerous.map((p) => `\`${p}\``).join(', ')}`);
  } else {
    permLines.push('No sensitive permissions detected.');
  }
  embed.addFields({
    name: 'Permissions it was granted (post-join)',
    value: permLines.join('\n').slice(0, 1024),
  });

  if (keywordMatched) {
    embed.addFields({
      name: 'NAME MATCHES HIGH-RISK KEYWORD',
      value:
        `Username contains \`${keywordMatched}\`, a blocklisted term.\n` +
        (tokenConsumed
          ? 'A single-use re-invite token was spent to let it reach this review.'
          : 'Blocked **before** the whitelist was consulted. A verified badge does not exempt it.'),
    });
  }

  const imageFlags = images?.flags ?? [];
  if (imageFlags.length) {
    const lines = imageFlags.map((f) => {
      if (f.level === 'unknown') return `• ${f.kind}: could not be verified (\`${f.reason}\`)`;
      return `• ${f.kind}: ${f.width}×${f.height}px, below the ${threshold}px threshold`;
    });
    embed.addFields({
      name: 'Low-resolution image heuristic',
      value:
        `${lines.join('\n')}\n` +
        '_Discord does not upscale, so these are the true stored sizes. This **may** ' +
        'indicate a spoofed or reused image, it is a hint, not a verdict._',
    });
  }

  if (impersonation?.matches?.length) {
    embed.addFields({
      name: 'NAME RESEMBLES AN APPROVED BOT',
      value: [
        describeImpersonation(impersonation),
        ...impersonation.matches.map((m) => `• \`${m.name}\` (${m.botId})`),
      ].join('\n').slice(0, 1024),
    });
  }

  if (accountAge?.tooNew) {
    embed.addFields({
      name: 'Very new application',
      value: `Created ${Math.floor(accountAge.days)} day(s) ago, under this server's ` +
        `${accountAge.minDays} day floor. Throwaway nuke bots are usually brand new.`,
    });
  }

  if (whitelistExpired) {
    embed.addFields({
      name: 'Approval had lapsed',
      value: 'This bot was approved here before, but the approval expired and needs ' +
        'reconfirming. It is not a new bot.',
    });
  }

  if (quorumRequired > 1) {
    embed.addFields({
      name: `Two-person approval, ${quorumRequired} needed`,
      value: `Approving records your vote. The bot is whitelisted once ${quorumRequired} ` +
        'different approvers agree. Denying takes effect immediately.',
    });
  }

  if (imagesGated) {
    embed.addFields({
      name: 'Avatar & banner analysis',
      value: 'Spoofed-image detection is a premium feature and is currently inactive ' +
        'for this server.',
    });
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${BUTTON_PREFIX}:approve:${pendingId}`)
      .setLabel('Approve & whitelist')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${BUTTON_PREFIX}:deny:${pendingId}`)
      .setLabel('Deny')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`${BUTTON_PREFIX}:nuke:${pendingId}`)
      .setLabel('Deny + confirm nuke bot')
      .setStyle(ButtonStyle.Danger),
  );

  return { embeds: [embed], files, components: [row] };
}

export async function deliverApprovalPrompt({ guild, pendingId, payload }) {
  const cfg = guildConfig.get(guild.id);
  const roleIds = approverRoles.list(guild.id);
  const content = roleIds.length ? roleIds.map((id) => `<@&${id}>`).join(' ') : undefined;

  let delivered = false;

  let deliveryProblem = null;

  if (cfg.notify_channel_id) {
    const health = await checkChannel(guild, cfg.notify_channel_id);
    if (!health.ok) deliveryProblem = describeChannelProblem(health, cfg.notify_channel_id);

    const channel = health.ok ? health.channel : null;
    if (channel?.isTextBased?.()) {
      const msg = await channel.send({
        ...payload,
        content,
        allowedMentions: { roles: roleIds },
      }).catch((err) => {
        log.error('approval prompt send failed', { guildId: guild.id, err: err.message });
        return null;
      });
      if (msg) {
        pendingApprovals.attachMessage(pendingId, channel.id, msg.id);
        delivered = true;
      }
    } else {
      log.warn('notify channel unusable', {
        guildId: guild.id, channelId: cfg.notify_channel_id, problem: deliveryProblem,
      });
    }
  } else {
    deliveryProblem = 'No approval channel is configured.';
  }

  if (cfg.notify_via_dm && roleIds.length && hasFeature(guild.id, 'dm_alerts')) {
    const { components, ...dmPayload } = payload;
    const members = await guild.members.fetch().catch(() => null);
    if (members) {
      const targets = members.filter(
        (m) => !m.user.bot && m.roles.cache.some((r) => roleIds.includes(r.id)),
      );
      await Promise.allSettled([...targets.values()].map((m) => m.send({
        ...dmPayload,
        content: `Approval needed in **${guild.name}** (#${pendingId}).`,
      })));
    }
  }

  if (!delivered) {
    await record({
      guildId: guild.id,
      action: 'approval_undelivered',
      severity: 'high',
      title: 'Approval prompt could not be delivered',
      description:
        `${deliveryProblem ?? 'Delivery failed.'} The bot was still kicked, because protection ` +
        'never depends on delivery, but no approver was notified in Discord.',
      detail: { pending_id: pendingId, problem: deliveryProblem },
      mirror: false,
    });
  }

  return delivered;
}

export async function resolveApproval({ pendingId, decision, actorId, via = 'discord' }) {
  const status = decision === 'approve' ? 'approved' : 'denied';
  const row = pendingApprovals.resolve(pendingId, status, actorId);

  if (!row) {
    const existing = pendingApprovals.byId(pendingId);
    return {
      ok: false,
      reason: existing ? 'already_resolved' : 'not_found',
      existing,
    };
  }

  if (decision === 'approve') {
    const voters = approvalVotes.list(pendingId).map((v) => v.voter_id);
    await addToWhitelist(row.guild_id, row.bot_id, actorId, {
      via, pending_id: pendingId, ...(voters.length > 1 ? { quorum_voters: voters } : {}),
    });

    if (row.keyword_matched) {
      const expiresAt = await issueReinviteToken(row.guild_id, row.bot_id, actorId, {
        keyword: row.keyword_matched,
        pending_id: pendingId,
        via,
      });
      return { ok: true, row, status, reinviteExpiresAt: expiresAt };
    }
    return { ok: true, row, status };
  }

  await record({
    guildId: row.guild_id,
    botId: row.bot_id,
    actorId,
    action: decision === 'nuke' ? 'approval_denied_nuke' : 'approval_denied',
    severity: decision === 'nuke' ? 'critical' : 'medium',
    title: decision === 'nuke' ? 'Bot denied and confirmed as a nuke bot' : 'Bot denied',
    description: 'Not whitelisted. No re-invite token issued.',
    detail: { pending_id: pendingId, via, keyword: row.keyword_matched ?? undefined },
  });

  let nuke = null;
  if (decision === 'nuke') {
    await confirmNukeBot(row.guild_id, row.bot_id, {
      botTag: row.bot_tag,
      confirmedBy: actorId,
      reason: `confirmed while resolving approval #${pendingId}`,
    });

    const guild = getClient()?.guilds.cache.get(row.guild_id);
    nuke = guild && row.added_by
      ? await banNukeInviter(guild, row.added_by, {
        botId: row.bot_id,
        botTag: row.bot_tag,
        actorId,
        viaConfirmation: true,
      })
      : { banned: false, reason: row.added_by ? 'guild_unavailable' : 'inviter_unknown' };
  }

  if (row.added_by) {
    const client = getClient();
    const user = await client?.users.fetch(row.added_by).catch(() => null);
    await user?.send(
      `Your bot request (\`${row.bot_tag ?? row.bot_id}\`) was denied by the approvers.`,
    ).catch(() => {});
  }

  return { ok: true, row, status, nuke };
}

export async function gatherImages(botUser, guildId) {
  const cfg = guildConfig.get(guildId);
  const threshold = cfg.low_res_threshold_px ?? 512;

  if (!hasFeature(guildId, 'image_analysis')) {
    return { images: null, threshold, gated: true };
  }

  const images = await probeUserAssets(botUser, threshold);
  return { images, threshold, gated: false };
}
