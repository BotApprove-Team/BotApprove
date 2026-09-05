import { EmbedBuilder, PermissionsBitField } from 'discord.js';
import { selfCheckState, approverRoles, guildConfig } from '../db/queries.js';
import { record } from './securityService.js';
import { checkChannel, describeChannelProblem } from './channelCheck.js';
import { createLogger } from '../logger.js';

const log = createLogger('self-check');

const REQUIRED = ['KickMembers', 'ViewAuditLog'];

const ALERT_COOLDOWN_MS = 15 * 60_000;

export async function checkGuild(guild, { reason = 'periodic' } = {}) {
  const me = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
  if (!me) {
    log.warn('cannot resolve self member', { guildId: guild.id });
    return { ok: false, reason: 'self_member_unavailable' };
  }

  const missing = REQUIRED.filter((p) => !me.permissions.has(PermissionsBitField.Flags[p]));
  const position = me.roles.highest.position;

  const rolesAbove = guild.roles.cache.filter(
    (r) => r.position >= position && r.id !== me.roles.highest.id && !r.managed,
  );

  const previous = selfCheckState.get(guild.id);
  const previousPerms = previous?.permissions ? JSON.parse(previous.permissions) : null;
  const demoted = previous?.role_position != null && position < previous.role_position;
  const lostPerms = previousPerms
    ? REQUIRED.filter((p) => previousPerms.includes(p) && missing.includes(p))
    : [];

  const problems = [];
  const notes = [];

  if (missing.length) problems.push(`Missing permission(s): ${missing.join(', ')}`);
  if (demoted) {
    problems.push(`Role position dropped from ${previous.role_position} to ${position}`);
  }

  if (rolesAbove.size) {
    notes.push(
      `${rolesAbove.size} role(s) rank above BotApprove: ` +
      `${[...rolesAbove.values()].map((r) => r.name).join(', ')}. ` +
      'Bot screening is unaffected, but members holding them cannot be kicked or banned ' +
      'by the nuke-inviter actions.',
    );
  }

  // A bot we cannot remove is the gate failing for that bot, not a limit on an
  // optional extra, so it belongs with the problems rather than the notes.
  // Discord needs a strictly higher top role, so a bot level with us is just as
  // far out of reach as one above us. Sharing a "Bots" role with the bots being
  // gated is the usual cause, and it looks tidy while removing nothing.
  const unreachable = guild.members.cache.filter(
    (m) => m.user.bot && m.id !== me.id && m.roles.highest.position >= position,
  );
  if (unreachable.size) {
    const sharing = unreachable.some((m) => m.roles.highest.id === me.roles.highest.id);
    const names = [...unreachable.values()].map((m) => m.user.tag).slice(0, 6).join(', ');
    const more = unreachable.size > 6 ? ` and ${unreachable.size - 6} more` : '';
    problems.push(
      `BotApprove cannot remove ${unreachable.size} bot(s) here: ${names}${more}. ` +
      (sharing
        ? `They share its own **${me.roles.highest.name}** role, and level is not above. ` +
          'Give BotApprove a role of its own, positioned higher.'
        : 'Their roles rank at or above BotApprove. Drag its role above them in ' +
          'Server Settings, Roles.'),
    );
  }

  const threats = guild.members.cache.filter((m) => {
    if (!m.user.bot || m.id === me.id) return false;
    const canRemove = m.permissions.has(PermissionsBitField.Flags.KickMembers)
      || m.permissions.has(PermissionsBitField.Flags.BanMembers)
      || m.permissions.has(PermissionsBitField.Flags.Administrator);
    return canRemove && m.roles.highest.comparePositionTo(me.roles.highest) > 0;
  });
  if (threats.size) {
    notes.push(
      `${threats.size} bot(s) outrank BotApprove and hold kick or ban power: ` +
      `${[...threats.values()].map((m) => m.user.tag).join(', ')}. ` +
      'If one of them is compromised it can remove BotApprove. Moving BotApprove above them, ' +
      'or removing their kick and ban permissions, closes that path.',
    );
  }

  const cfg = guildConfig.get(guild.id);
  const notify = await checkChannel(guild, cfg.notify_channel_id);
  if (cfg.notify_channel_id && !notify.ok) {
    problems.push(describeChannelProblem(notify, cfg.notify_channel_id));
  } else if (!cfg.notify_channel_id) {
    problems.push('No approval channel is set, so nobody is notified when a bot is held. ' +
      'Use /config notify-channel.');
  }
  const logCh = await checkChannel(guild, cfg.log_channel_id);
  if (cfg.log_channel_id && !logCh.ok) {
    notes.push(`${describeChannelProblem(logCh, cfg.log_channel_id)} ` +
      'The audit trail is still recorded and readable on the dashboard.');
  }

  selfCheckState.save(guild.id, {
    rolePosition: position,
    permissions: JSON.stringify(REQUIRED.filter((p) => !missing.includes(p))),
    lastOkAt: problems.length ? null : Date.now(),
  });

  if (!problems.length) return { ok: true, position, notes };

  const tampering = demoted || lostPerms.length > 0;
  const severity = tampering ? 'critical' : 'high';

  const now = Date.now();
  const cooling = previous?.last_alert_at && now - previous.last_alert_at < ALERT_COOLDOWN_MS;
  if (cooling) return { ok: false, problems, notes, suppressed: true };

  selfCheckState.save(guild.id, { rolePosition: position, lastAlertAt: now });

  await record({
    guildId: guild.id,
    action: tampering ? 'self_check_tampering' : 'self_check_misconfigured',
    severity,
    title: tampering
    ? 'BotApprove was weakened, likely compromise attempt'
    : 'BotApprove is not correctly positioned',
    description: problems.join('\n'),
    detail: { reason, missing, position, roles_above: rolesAbove.size },
  });

  await pingApprovers(guild, { problems, tampering }).catch(() => {});

  return { ok: false, problems, notes, tampering };
}

async function pingApprovers(guild, { problems, tampering }) {
  const cfg = guildConfig.get(guild.id);
  const channelId = cfg.log_channel_id ?? cfg.notify_channel_id;
  if (!channelId) return;

  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return;

  const roleIds = approverRoles.list(guild.id);
  const embed = new EmbedBuilder()
    .setColor(tampering ? 0x992d22 : 0xed4245)
    .setTitle(tampering
    ? 'BotApprove has been weakened'
    : 'BotApprove cannot fully protect this server')
    .setDescription(
      `${problems.map((p) => `• ${p}`).join('\n')}\n\n` +
      (tampering
        ? '**Someone reduced BotApprove\'s power after it was working.** Treat this as an ' +
          'in-progress attack: check the audit log for who changed roles or permissions.'
        : 'Grant Kick Members + View Audit Log and drag BotApprove\'s role above where new ' +
          'bots land.'),
    )
    .setTimestamp(new Date());

  await channel.send({
    content: roleIds.length ? roleIds.map((id) => `<@&${id}>`).join(' ') : undefined,
    embeds: [embed],
    allowedMentions: { roles: roleIds },
  });
}

export async function checkAllGuilds(client, opts) {
  const results = [];
  for (const [, guild] of client.guilds.cache) {
    results.push({ guildId: guild.id, ...(await checkGuild(guild, opts).catch((err) => ({
      ok: false, error: err.message,
    }))) });
  }
  return results;
}
