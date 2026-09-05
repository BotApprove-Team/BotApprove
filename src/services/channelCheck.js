import { PermissionsBitField } from 'discord.js';

export const REQUIRED_CHANNEL_PERMS = [
  'ViewChannel',
  'SendMessages',
  'EmbedLinks',
  'AttachFiles',
];

const LABEL = {
  ViewChannel: 'View Channel',
  SendMessages: 'Send Messages',
  EmbedLinks: 'Embed Links',
  AttachFiles: 'Attach Files',
};

export async function checkChannel(guild, channelId) {
  if (!channelId) return { ok: true, missing: [], unset: true };

  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel) return { ok: false, reason: 'not_found', missing: [] };
  if (!channel.isTextBased?.()) return { ok: false, reason: 'not_text', missing: [], channel };

  const me = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
  if (!me) return { ok: false, reason: 'self_member_unavailable', missing: [], channel };

  const perms = channel.permissionsFor(me);
  if (!perms) return { ok: false, reason: 'permissions_unresolvable', missing: [], channel };

  const missing = REQUIRED_CHANNEL_PERMS
    .filter((p) => !perms.has(PermissionsBitField.Flags[p]));

  return { ok: missing.length === 0, missing, channel };
}

export function describeChannelProblem(result, channelId) {
  if (result.ok) return null;
  if (result.reason === 'not_found') {
    return `Channel <#${channelId}> no longer exists, or BotApprove cannot see it at all.`;
  }
  if (result.reason === 'not_text') return `<#${channelId}> is not a text channel.`;
  if (result.missing.length) {
    return `BotApprove is missing ${result.missing.map((p) => `**${LABEL[p] ?? p}**`).join(', ')} ` +
      `in <#${channelId}>.` +
      (result.missing.includes('ViewChannel')
        ? ' Without View Channel it cannot post there at all, even with Send Messages.'
        : '');
  }
  return `BotApprove cannot post in <#${channelId}>.`;
}
