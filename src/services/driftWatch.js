import { PermissionsBitField } from 'discord.js';
import { whitelist, botPermissions, guildConfig } from '../db/queries.js';
import { record } from './securityService.js';
import { hasFeature } from './featureService.js';
import { createLogger } from '../logger.js';

const log = createLogger('drift');

const SENSITIVE = [
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

function snapshot(member) {
  const perms = member.permissions;
  return {
    botTag: member.user.tag,
    permissions: perms.bitfield.toString(),
    dangerous: SENSITIVE.filter((p) => perms.has(PermissionsBitField.Flags[p], false)),
  };
}

export function baseline(member) {
  try {
    botPermissions.save(member.guild.id, member.id, snapshot(member));
  } catch (err) {
    log.warn('could not store permission baseline', { botId: member.id, err: err.message });
  }
}

export async function checkBot(member, { reason = 'periodic' } = {}) {
  const guildId = member.guild.id;
  if (!member.user.bot) return null;
  if (member.id === member.client.user?.id) return null;
  if (!whitelist.has(guildId, member.id)) return null;

  const current = snapshot(member);
  const previous = botPermissions.get(guildId, member.id);

  if (!previous) {
    botPermissions.save(guildId, member.id, current);
    return null;
  }

  const had = (() => {
    try { return JSON.parse(previous.dangerous ?? '[]'); } catch { return []; }
  })();
  const gained = current.dangerous.filter((p) => !had.includes(p));
  const lost = had.filter((p) => !current.dangerous.includes(p));

  botPermissions.save(guildId, member.id, current);

  if (!gained.length) {
    if (lost.length) {
      log.info('approved bot lost permissions', { guildId, botId: member.id, lost });
    }
    return null;
  }

  if (!hasFeature(guildId, 'permission_drift')) {
    log.info('drift detected but premium inactive', { guildId, botId: member.id, gained });
    return { gained, lost, alerted: false, reason: 'premium_required' };
  }

  const critical = gained.includes('Administrator') || gained.includes('ManageGuild');

  await record({
    guildId,
    botId: member.id,
    action: 'bot_permission_drift',
    severity: critical ? 'critical' : 'high',
    title: critical
      ? 'Approved bot was granted server-control permissions'
      : 'Approved bot gained sensitive permissions',
    description:
      `\`${member.user.tag}\` was approved without ${gained.join(', ')} and now holds ` +
      `${gained.length === 1 ? 'it' : 'them'}. Someone changed its role after the review. ` +
      'If that was not deliberate, treat it as an escalation attempt.',
    detail: { bot_tag: member.user.tag, gained, lost: lost.length ? lost : undefined, reason },
  });

  log.alert('approved bot gained permissions', { guildId, botId: member.id, gained });
  return { gained, lost, alerted: true, critical };
}

export async function checkGuild(guild, opts) {
  if (!hasFeature(guild.id, 'permission_drift')) return { skipped: 'premium_required' };
  guildConfig.ensure(guild.id);
  let checked = 0;
  let alerted = 0;
  for (const botId of whitelist.list(guild.id).map((r) => r.bot_id)) {
    const member = guild.members.cache.get(botId)
      ?? await guild.members.fetch(botId).catch(() => null);
    if (!member) continue;
    checked += 1;
    const result = await checkBot(member, opts).catch((err) => {
      log.warn('drift check failed', { botId, err: err.message });
      return null;
    });
    if (result?.alerted) alerted += 1;
  }
  return { checked, alerted };
}

export async function checkAll(client, opts) {
  for (const [, guild] of client.guilds.cache) {
    await checkGuild(guild, opts).catch(() => {});
  }
}
