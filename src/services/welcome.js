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

  // Discord requires a STRICTLY higher top role to remove someone, so equal
  // counts as too low. Sharing a "Bots" role with the bots being gated is the
  // common way this goes wrong: everything looks tidy and nothing can be
  // removed. Hence >= rather than >.
  const blocked = guild.members.cache
    .filter((m) => m.user.bot
      && m.id !== me.id
      && m.roles.highest.position >= mine.position);

  const unreachable = [...blocked.values()].map((m) => ({
    tag: m.user.tag,
    role: m.roles.highest.name,
    shared: m.roles.highest.id === mine.id,
  }));

  // True when the bots we cannot reach are sitting in our own role rather than
  // above it, which needs a different fix: a role of its own, not a drag.
  const sharing = unreachable.some((b) => b.shared);

  const botRolesAtOrAbove = [...guild.roles.cache.values()]
    .filter((r) => r.position >= mine.position && r.managed && r.id !== mine.id)
    .map((r) => r.name);

  return {
    roleName: mine.name,
    position: mine.position,
    ownRoleIsManaged: mine.managed,
    botRolesAtOrAbove,
    unreachable: unreachable.map((b) => b.tag),
    unreachableDetail: unreachable,
    sharing,
    ok: unreachable.length === 0 && botRolesAtOrAbove.length === 0,
  };
}

function buildEmbed(guild, standing) {
  const embed = new EmbedBuilder()
    .setColor(standing?.ok ? 0x3ba55d : 0xd9a441)
    .setTitle(standing?.ok
      ? 'BotApprove is set up and gating this server'
      : 'BotApprove is in, but it cannot remove anything yet')
    .setDescription(
      `**${guild.name}**\n\n` +
      'Discord only lets a bot remove someone whose highest role is **below** its own. Level ' +
      'with it is not enough. A bot arrives at the bottom of the role list, so until ' +
      'BotApprove outranks the bots it is meant to be gating, it will hold them for approval ' +
      'and then fail to kick them.',
    );

  if (standing?.sharing) {
    // The fix here is not "drag it up": it is already as high as that role goes.
    embed.addFields({
      name: `1. Give BotApprove a role of its own, above ${standing.roleName}`,
      value:
        `BotApprove is sitting **inside** your **${standing.roleName}** role, the same one the ` +
        'other bots use. Level with them means it cannot remove any of them.\n\n' +
        'Server Settings → Roles → **Create Role**, call it BotApprove, drag it **above ' +
        `${standing.roleName}**, then assign it to BotApprove. It does not need any extra ` +
        'permissions; the position is the whole point.',
    });
  } else if (standing && !standing.ok) {
    embed.addFields({
      name: '1. Drag the BotApprove role above your bots',
      value:
        'Server Settings → Roles, and drag **BotApprove** so it sits above every bot role, ' +
        'ideally above a dedicated **Bots** role if you use one. Anything level with it or ' +
        'above it is out of reach.',
    });
  } else {
    embed.addFields({
      name: '1. Role position',
      value: `**${standing?.roleName}** outranks every other bot here, so the gate can remove ` +
        'them. If you add a bot with a higher role later, move BotApprove back above it.',
    });
  }

  if (standing && !standing.ok) {
    const shown = standing.unreachableDetail.slice(0, 8)
      .map((b) => `\`${b.tag}\`${b.shared ? '' : ` (${b.role})`}`)
      .join(', ');
    const more = standing.unreachable.length > 8
      ? ` and ${standing.unreachable.length - 8} more` : '';
    embed.addFields({
      name: `Cannot be removed right now: ${standing.unreachable.length}`,
      value: `${shown}${more}\n\nThese are the bots the gate would fail on today.`,
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

  // A partial member cache would under-report which bots are out of reach, and
  // "you are fine" is the one answer this must not get wrong.
  await guild.members.fetch().catch((err) =>
    log.warn('member fetch failed, standing may be incomplete', {
      guildId: guild.id, err: err.message,
    }));

  const standing = roleStanding(guild);
  const result = await deliver(guild, buildEmbed(guild, standing));

  log.info('setup guide sent', {
    guildId: guild.id,
    via: result.via,
    roleOk: standing?.ok ?? null,
    unreachable: standing?.unreachable.length ?? null,
    sharing: standing?.sharing ?? null,
  });

  await record({
    guildId: guild.id,
    action: 'setup_guide_sent',
    severity: standing?.ok ? 'info' : 'medium',
    detail: {
      via: result.via,
      position: standing?.position,
      sharing_role: standing?.sharing || undefined,
      unreachable: standing?.unreachable.length || undefined,
    },
    mirror: false,
  }).catch(() => {});

  return { ...result, standing };
}
