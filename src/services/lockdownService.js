import { PermissionsBitField } from 'discord.js';
import { lockdown } from '../db/queries.js';
import { record } from './securityService.js';
import { createLogger } from '../logger.js';

const log = createLogger('lockdown');

const MAX_CHANNELS = 60;

const targets = (guild) => [...guild.channels.cache.values()]
  .filter((ch) => !ch.parentId && ch.permissionOverwrites)
  .slice(0, MAX_CHANNELS);

export async function start(guild, actorId) {
  const me = guild.members.me;
  if (!me?.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
    return { ok: false, reason: 'no_manage_channels' };
  }
  if (lockdown.isActive(guild.id)) return { ok: false, reason: 'already_active' };

  const everyone = guild.roles.everyone;
  const applied = [];
  let failed = 0;

  for (const channel of targets(guild)) {
    const existing = channel.permissionOverwrites.cache.get(everyone.id);
    const before = existing
      ? existing.deny.has(PermissionsBitField.Flags.SendMessages) ? false
        : existing.allow.has(PermissionsBitField.Flags.SendMessages) ? true : null
      : null;

    const ok = await channel.permissionOverwrites.edit(everyone, {
      SendMessages: false,
    }, { reason: `BotApprove: lockdown by ${actorId ?? 'operator'}` })
      .then(() => true).catch(() => false);

    if (ok) applied.push({ id: channel.id, before });
    else failed += 1;
  }

  if (!applied.length) return { ok: false, reason: 'nothing_changed', failed };

  lockdown.start(guild.id, { applied, startedBy: actorId });

  await record({
    guildId: guild.id,
    actorId,
    action: 'lockdown_started',
    severity: 'high',
    title: 'Server locked down',
    description: `Sending was disabled in ${applied.length} channel(s).`,
    detail: { channels: applied.length, failed },
  }).catch(() => {});

  log.alert('lockdown started', { guildId: guild.id, channels: applied.length, failed });
  return { ok: true, channels: applied.length, failed };
}

export async function lift(guild, actorId) {
  const state = lockdown.get(guild.id);
  if (!state?.active) return { ok: false, reason: 'not_active' };

  let applied;
  try { applied = JSON.parse(state.applied ?? '[]'); } catch { applied = []; }

  const everyone = guild.roles.everyone;
  let restored = 0;
  let failed = 0;

  for (const entry of applied) {
    const channel = guild.channels.cache.get(entry.id);
    if (!channel?.permissionOverwrites) { failed += 1; continue; }

    const ok = await channel.permissionOverwrites.edit(everyone, {
      SendMessages: entry.before,
    }, { reason: `BotApprove: lockdown lifted by ${actorId ?? 'operator'}` })
      .then(() => true).catch(() => false);

    if (ok) restored += 1; else failed += 1;
  }

  lockdown.end(guild.id);

  await record({
    guildId: guild.id,
    actorId,
    action: 'lockdown_lifted',
    severity: 'medium',
    title: 'Server lockdown lifted',
    description: `Restored ${restored} channel(s).`,
    detail: { restored, failed },
  }).catch(() => {});

  log.info('lockdown lifted', { guildId: guild.id, restored, failed });
  return { ok: true, restored, failed };
}

export const isActive = (guildId) => lockdown.isActive(guildId);
