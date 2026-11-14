import { ChannelType, PermissionsBitField } from 'discord.js';

export const REQUIRED_CHANNEL_PERMS = [
  'ViewChannel',
  'SendMessages',
  'EmbedLinks',
  'AttachFiles',
];

// A channel a server keeps as bait for spam bots, where posting gets you banned.
// Only the automatic fallback avoids these: falling into one gets the bot
// banned for doing its job and leaves the alert where nobody looks. A channel
// someone chose on purpose is still used.
//
// Servers often spell these with lookalike letters so spam scripts cannot skip
// them by name (#hօneурot is Armenian and Cyrillic), so names are folded back
// to plain letters before matching.
const LOOKALIKE = new Map();
for (const [chars, plain] of [
  ['аɑα@4', 'a'], ['вʙβ', 'b'], ['сϲᴄ', 'c'], ['ԁᴅ', 'd'], ['еεᴇ3', 'e'], ['ғ', 'f'],
  ['ɡɢց', 'g'], ['һнʜհΗ', 'h'], ['іıɪιɩ1', 'i'], ['јᴊ', 'j'], ['кκᴋ', 'k'], ['ӏʟ', 'l'],
  ['мᴍΜ', 'm'], ['ոռɴηΝ', 'n'], ['оοօᴏ0', 'o'], ['рρᴘ', 'p'], ['ԛǫզ', 'q'], ['ʀг', 'r'],
  ['ѕꜱ$5', 's'], ['тτᴛ7', 't'], ['υսᴜ', 'u'], ['νᴠ', 'v'], ['ԝᴡ', 'w'], ['хχ', 'x'],
  ['уүʏγΥ', 'y'], ['ᴢΖ', 'z'],
]) for (const c of chars) LOOKALIKE.set(c, plain);

const fold = (text) => String(text ?? '')
  .normalize('NFKD')
  .replace(/\p{M}/gu, '')
  .replace(/./gsu, (c) => LOOKALIKE.get(c) ?? LOOKALIKE.get(c.toLowerCase()) ?? c)
  .toLowerCase()
  .replace(/['’`]/g, '')
  .replace(/[^a-z0-9]+/g, ' ');

const TRAP_NAME = /honey ?pot|\bbot ?trap\b|\btrap\b|\bdo ?no?t ?(type|talk|post|chat|speak|send|write)/;
const TRAP_TOPIC = /honey ?pot|\bdo ?no?t ?(type|talk|post|chat|speak|send|write)|\b(instant(ly)?|auto(matically)?) ?(get )?ban|\byou will be (banned|kicked)/;
export const looksLikeTrap = (channel) => {
  const name = fold(channel?.name);
  return (channel?.name ?? '').includes('🍯')
    || TRAP_NAME.test(name)
    || name.replace(/ /g, '').includes('honeypot')
    || TRAP_TOPIC.test(fold(channel?.topic));
};

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

export async function resolveDeliveryChannel(guild, preferred = []) {
  for (const id of preferred) {
    if (!id) continue;
    const health = await checkChannel(guild, id);
    if (health.ok) return { channel: health.channel, picked: false, problem: null };
  }

  const firstProblem = await (async () => {
    for (const id of preferred) {
      if (!id) continue;
      const health = await checkChannel(guild, id);
      if (!health.ok) return describeChannelProblem(health, id);
    }
    return null;
  })();

  const me = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
  if (!me) return { channel: null, picked: false, problem: firstProblem };

  const ordered = [...guild.channels.cache.values()]
    .filter((c) => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement)
    .sort((a, b) => a.rawPosition - b.rawPosition);

  const candidates = [guild.systemChannel, guild.publicUpdatesChannel, ...ordered];

  for (const channel of candidates) {
    if (!channel?.isTextBased?.() || looksLikeTrap(channel)) continue;
    const perms = channel.permissionsFor(me);
    if (!perms) continue;
    if (REQUIRED_CHANNEL_PERMS.every((p) => perms.has(PermissionsBitField.Flags[p]))) {
      return { channel, picked: true, problem: firstProblem };
    }
  }

  return { channel: null, picked: false, problem: firstProblem };
}
