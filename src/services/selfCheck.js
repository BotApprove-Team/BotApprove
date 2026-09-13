import crypto from 'node:crypto';
import { EmbedBuilder, PermissionsBitField } from 'discord.js';
import { selfCheckState, approverRoles, guildConfig } from '../db/queries.js';
import { config } from '../config.js';
import { record } from './securityService.js';
import { checkChannel, describeChannelProblem } from './channelCheck.js';
import { createLogger } from '../logger.js';

const log = createLogger('self-check');

const REQUIRED = ['KickMembers', 'ViewAuditLog'];

const PERM_LABEL = {
  KickMembers: 'Kick Members',
  ViewAuditLog: 'View Audit Log',
};

const INCIDENT_COOLDOWN_MS = 15 * 60_000;
const RENAG_MS = 7 * 86_400_000;

const IMPAIRED = ['perms', 'demoted', 'unreachable', 'channel_broken'];

function fingerprint(codes) {
  return crypto.createHash('sha1').update([...codes].sort().join('|')).digest('hex').slice(0, 16);
}

function headline(codes, tampering) {
  if (tampering) return 'BotApprove was weakened, likely compromise attempt';
  if (codes.includes('perms')) return 'BotApprove is missing permissions it needs';
  if (codes.includes('unreachable')) return 'BotApprove is not correctly positioned';
  if (codes.includes('channel_broken')) return 'BotApprove cannot reach the approval channel';
  return 'BotApprove is not finished being set up';
}

export async function checkGuild(guild, { reason = 'periodic', announce = true } = {}) {
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

  const found = [];
  const notes = [];
  const problem = (code, text) => found.push({ code, text });

  if (missing.length) {
    problem('perms', `Missing ${missing.map((p) => PERM_LABEL[p] ?? p).join(' and ')}. `
      + 'Grant them in Server Settings, Roles, BotApprove. Without them a bot that joins '
      + 'cannot be removed at all.');
  }
  if (demoted) {
    problem('demoted', `Role position dropped from ${previous.role_position} to ${position}.`);
  }

  if (rolesAbove.size) {
    const humans = [...guild.members.cache.values()]
      .filter((m) => !m.user?.bot && m.id !== guild.ownerId);
    const outOfReach = humans.filter((m) => m.roles.highest.position >= position);
    const held = [...rolesAbove.values()]
      .filter((r) => humans.some((m) => m.roles.cache.has(r.id)))
      .sort((a2, b2) => b2.position - a2.position);

    if (outOfReach.length) {
      const top = held.slice(0, 3).map((r) => r.name).join(', ');
      notes.push(
        `${outOfReach.length} member(s) cannot be kicked or banned by the nuke-inviter actions, `
        + `because their top role sits above BotApprove. Only ${held.length} of the `
        + `${rolesAbove.size} roles above it are held by anyone`
        + (top ? `, the highest being ${top}` : '')
        + '. Bot screening is unaffected.',
      );
    } else {
      notes.push(
        `${rolesAbove.size} role(s) rank above BotApprove, but nobody other than you holds any `
        + 'of them, so nobody is out of reach. Bot screening is unaffected.',
      );
    }
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
    problem('unreachable',
      `BotApprove cannot remove ${unreachable.size} bot(s) here: ${names}${more}. ` +
      (sharing
        ? `They share its own **${me.roles.highest.name}** role, and level is not above. ` +
          'Give BotApprove a role of its own, positioned higher.'
        : 'Their roles rank at or above BotApprove. Drag its role above them in ' +
          'Server Settings, Roles.'));
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
      `${[...threats.values()].slice(0, 6).map((m) => m.user.tag).join(', ')}` +
      `${threats.size > 6 ? ` and ${threats.size - 6} more` : ''}. ` +
      'If one of them is compromised it can remove BotApprove. Moving BotApprove above them, ' +
      'or removing their kick and ban permissions, closes that path.',
    );
  }

  const everyone = guild.roles.everyone;
  if (everyone?.permissions?.has(PermissionsBitField.Flags.UseExternalApps, false)) {
    notes.push(
      '@everyone can use apps installed to their own account. Those never join the server, so '
      + 'they never go through the approval gate, and someone can post with one without '
      + 'inviting a bot. Server Settings, Roles, Apps Permissions, turn off Use External Apps.',
    );
  }

  const cfg = guildConfig.get(guild.id);
  const notify = await checkChannel(guild, cfg.notify_channel_id);
  if (cfg.notify_channel_id && !notify.ok) {
    problem('channel_broken', describeChannelProblem(notify, cfg.notify_channel_id));
  } else if (!cfg.notify_channel_id) {
    problem('no_channel', 'No approval channel is set, so nobody is notified when a bot is '
      + 'held. Use /config notify-channel.');
  }

  if (!approverRoles.list(guild.id).length) {
    problem('no_approvers',
      'No approver roles are set, so the approval card is posted with nobody mentioned. It is '
      + 'the same as not being told: anyone with Manage Server can still press the buttons, but '
      + 'nothing points them at it. Use /approvers add. Until then the server owner is pinged '
      + 'instead, as a stand-in.');
  }
  const logCh = await checkChannel(guild, cfg.log_channel_id);
  if (cfg.log_channel_id && !logCh.ok) {
    notes.push(`${describeChannelProblem(logCh, cfg.log_channel_id)} ` +
      'The audit trail is still recorded and readable on the dashboard.');
  }

  selfCheckState.save(guild.id, {
    rolePosition: position,
    permissions: JSON.stringify(REQUIRED.filter((p) => !missing.includes(p))),
    lastOkAt: found.length ? null : Date.now(),
  });

  if (!found.length) {
    if (previous?.problems_hash) selfCheckState.noteProblems(guild.id, null, null);
    return { ok: true, position, notes };
  }

  const codes = found.map((p) => p.code);
  const problems = found.map((p) => p.text);
  const tampering = demoted || lostPerms.length > 0;
  const result = { ok: false, problems, codes, notes, tampering };

  if (!announce) return result;

  const now = Date.now();
  const hash = fingerprint(codes);
  const since = previous?.last_alert_at ? now - previous.last_alert_at : Infinity;
  const changed = hash !== previous?.problems_hash;
  const speak = changed || since >= (tampering ? INCIDENT_COOLDOWN_MS : RENAG_MS);

  if (!speak) return { ...result, suppressed: true };

  selfCheckState.noteProblems(guild.id, hash, now);

  await record({
    guildId: guild.id,
    action: tampering ? 'self_check_tampering' : 'self_check_misconfigured',
    severity: tampering ? 'critical' : 'high',
    title: headline(codes, tampering),
    description: problems.join('\n'),
    detail: {
      reason,
      problems: codes.join(', '),
      missing: missing.length ? missing.join(', ') : undefined,
      position,
      roles_above: rolesAbove.size || undefined,
    },
    mirror: false,
  });

  await pingApprovers(guild, { problems, codes, tampering }).catch(() => {});

  return result;
}

async function pingApprovers(guild, { problems, codes, tampering }) {
  const cfg = guildConfig.get(guild.id);
  const channelId = cfg.log_channel_id ?? cfg.notify_channel_id;
  if (!channelId) return;

  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return;

  const impaired = codes.some((c) => IMPAIRED.includes(c));
  const roleIds = approverRoles.list(guild.id);

  const embed = new EmbedBuilder()
    .setColor(tampering ? 0x992d22 : (impaired ? 0xed4245 : 0xd29922))
    .setTitle(tampering
      ? 'BotApprove has been weakened'
      : (impaired
        ? 'BotApprove cannot fully protect this server'
        : 'BotApprove is not finished being set up'))
    .setDescription(
      problems.map((p) => `• ${p}`).join('\n\n') +
      (tampering
        ? '\n\n**Someone reduced BotApprove\'s power after it was working.** Treat this as an '
          + 'in-progress attack: check the audit log for who changed roles or permissions.'
        : ''),
    )
    .setFooter({
      text: tampering
        ? 'Repeats every 15 minutes until it is resolved.'
        : 'Said once. It will not repeat unless something changes.',
    })
    .setTimestamp(new Date());

  if (!tampering) {
    embed.addFields({
      name: 'Fix it on the dashboard',
      value: `${config.web.baseUrl}/g/${guild.id}/setup`,
    });
  }

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
