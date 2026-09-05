import { EmbedBuilder, PermissionsBitField } from 'discord.js';
import { guildConfig } from '../db/queries.js';
import { record } from './securityService.js';
import { createLogger } from '../logger.js';

const log = createLogger('welcome');

/**
 * Where BotApprove sits in the role list, and what that costs.
 *
 * Discord will not let a bot remove a member whose highest role outranks its
 * own. A newly added bot's managed role lands at the bottom, so on arrival
 * BotApprove usually cannot remove anything, which is the one setup step that
 * silently breaks the entire gate.
 */
export function roleStanding(guild) {
  const me = guild.members.me;
  if (!me) return null;

  const mine = me.roles.highest;
  const above = guild.roles.cache.filter((r) => r.position > mine.position);

  const botRolesAbove = [...above.values()].filter((r) => r.managed);

  // A bot is out of reach when its own highest role outranks ours. That is the
  // set the gate cannot act on, whatever permissions those bots happen to hold.
  const ungateable = guild.members.cache
    .filter((m) => m.user.bot
      && m.id !== me.id
      && m.roles.highest.position > mine.position)
    .map((m) => m.user.tag);

  return {
    roleName: mine.name,
    position: mine.position,
    highest: guild.roles.cache.size,
    botRolesAbove: botRolesAbove.map((r) => r.name),
    ungateable,
    ok: botRolesAbove.length === 0,
  };
}

function buildEmbed(guild, standing) {
  const embed = new EmbedBuilder()
    .setColor(standing?.ok ? 0x3ba55d : 0xd9a441)
    .setTitle('BotApprove is in. One thing before it works.')
    .setDescription(
      `**${guild.name}**\n\n` +
      'Discord will not let a bot remove anyone whose highest role sits above its own, and a ' +
      "newly added bot's role starts at the bottom of the list. Until BotApprove's role is " +
      'moved up, it cannot kick the bots it is meant to be gating.',
    );

  embed.addFields({
    name: '1. Move the BotApprove role up',
    value:
      'Server Settings → Roles, and drag **BotApprove** above your bot roles. Above a dedicated ' +
      '"Bots" role is ideal. It has to sit above wherever new bots land, or the gate cannot ' +
      'remove them.',
  });

  if (standing && !standing.ok) {
    const names = standing.botRolesAbove.slice(0, 8).join(', ');
    const extra = standing.botRolesAbove.length > 8
      ? ` and ${standing.botRolesAbove.length - 8} more` : '';
    embed.addFields({
      name: 'Right now',
      value:
        `**${standing.roleName}** is at position ${standing.position}, below ` +
        `${standing.botRolesAbove.length} bot role(s): ${names}${extra}.` +
        (standing.ungateable.length
          ? `\nBotApprove cannot remove: ${standing.ungateable.slice(0, 6).join(', ')}.`
          : ''),
    });
  } else if (standing) {
    embed.addFields({
      name: 'Right now',
      value: `**${standing.roleName}** is at position ${standing.position}, above every bot role. ` +
        'Nothing to change.',
    });
  }

  embed.addFields(
    {
      name: '2. Pick where approvals appear',
      value: 'Run `/config notify-channel` and choose a channel your moderators watch. Without ' +
        'one, bots are still kicked but nobody is told.',
    },
    {
      name: '3. Say who can approve',
      value: 'Run `/approvers add` with a role. Anyone in it can let a bot back in.',
    },
    {
      name: 'Check it worked',
      value: 'Run `/selfcheck`. It reports anything still standing between BotApprove and a ' +
        'working gate.',
    },
  );

  return embed.setFooter({ text: 'BotApprove' }).setTimestamp(new Date());
}

/** Somewhere the owner will actually see it. */
async function deliver(guild, embed) {
  const owner = await guild.fetchOwner().catch(() => null);
  if (owner) {
    const sent = await owner.send({ embeds: [embed] }).then(() => true).catch(() => false);
    if (sent) return { via: 'dm', to: owner.id };
  }

  const me = guild.members.me;
  const postable = (c) => c?.isTextBased?.()
    && c.permissionsFor(me)?.has(PermissionsBitField.Flags.SendMessages)
    && c.permissionsFor(me)?.has(PermissionsBitField.Flags.ViewChannel);

  const candidates = [
    guild.systemChannel,
    ...guild.channels.cache.filter(postable).sort((a, b) => a.rawPosition - b.rawPosition).values(),
  ];

  for (const channel of candidates) {
    if (!postable(channel)) continue;
    const sent = await channel.send({ embeds: [embed] }).then(() => true).catch(() => false);
    if (sent) return { via: 'channel', to: channel.id };
  }

  return { via: 'nowhere' };
}

export async function sendSetupGuide(guild) {
  guildConfig.ensure(guild.id);

  const standing = roleStanding(guild);
  const result = await deliver(guild, buildEmbed(guild, standing));

  log.info('setup guide sent', {
    guildId: guild.id,
    via: result.via,
    roleOk: standing?.ok ?? null,
    botRolesAbove: standing?.botRolesAbove.length ?? null,
  });

  await record({
    guildId: guild.id,
    action: 'setup_guide_sent',
    severity: standing?.ok ? 'info' : 'medium',
    detail: {
      via: result.via,
      position: standing?.position,
      bot_roles_above: standing?.botRolesAbove.length,
      ungateable: standing?.ungateable.length || undefined,
    },
    mirror: false,
  }).catch(() => {});

  return { ...result, standing };
}
