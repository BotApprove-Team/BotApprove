import { PermissionsBitField } from 'discord.js';
import { guildConfig } from '../db/queries.js';
import { createLogger } from '../logger.js';

const log = createLogger('quarantine');

const ROLE_NAME = 'BotApprove Quarantine';

const DENY = new PermissionsBitField([
  PermissionsBitField.Flags.ViewChannel,
  PermissionsBitField.Flags.SendMessages,
  PermissionsBitField.Flags.Connect,
  PermissionsBitField.Flags.AddReactions,
  PermissionsBitField.Flags.CreatePublicThreads,
  PermissionsBitField.Flags.CreatePrivateThreads,
  PermissionsBitField.Flags.SendMessagesInThreads,
]);

const MAX_CHANNELS = 60;

export async function ensureRole(guild) {
  const cfg = guildConfig.get(guild.id);
  const me = guild.members.me;
  if (!me?.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
    return { ok: false, reason: 'no_manage_roles' };
  }

  const existing = cfg?.quarantine_role_id
    ? guild.roles.cache.get(cfg.quarantine_role_id)
    : guild.roles.cache.find((r) => r.name === ROLE_NAME && !r.managed);

  if (existing) {
    if (cfg?.quarantine_role_id !== existing.id) {
      guildConfig.set(guild.id, { quarantine_role_id: existing.id });
    }
    return { ok: true, role: existing, created: false };
  }

  const role = await guild.roles.create({
    name: ROLE_NAME,
    permissions: [],
    color: 0x8a6100,
    hoist: false,
    mentionable: false,
    reason: 'BotApprove: quarantine role',
  }).catch((err) => {
    log.warn('could not create quarantine role', { guildId: guild.id, err: err.message });
    return null;
  });

  if (!role) return { ok: false, reason: 'create_failed' };

  guildConfig.set(guild.id, { quarantine_role_id: role.id });
  return { ok: true, role, created: true };
}

export async function applyOverwrites(guild, role) {
  const me = guild.members.me;
  if (!me?.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
    return { applied: 0, skipped: 0, reason: 'no_manage_channels' };
  }

  const targets = [...guild.channels.cache.values()]
    .filter((ch) => !ch.parentId)
    .slice(0, MAX_CHANNELS);

  let applied = 0;
  let skipped = 0;
  for (const channel of targets) {
    const ok = await channel.permissionOverwrites?.edit(role, {
      ViewChannel: false,
      SendMessages: false,
      Connect: false,
      AddReactions: false,
    }, { reason: 'BotApprove: quarantine' }).then(() => true).catch(() => false);
    if (ok) applied += 1; else skipped += 1;
  }

  return { applied, skipped };
}

export async function apply(guild, member) {
  const ensured = await ensureRole(guild);
  if (!ensured.ok) return { ok: false, reason: ensured.reason };

  const { role } = ensured;

  let overwrites = null;
  if (ensured.created) overwrites = await applyOverwrites(guild, role);

  const added = await member.roles.add(role, 'BotApprove: quarantined')
    .then(() => true)
    .catch((err) => {
      log.warn('could not add quarantine role', { guildId: guild.id, err: err.message });
      return false;
    });

  return { ok: added, role, overwrites };
}

export async function lift(guild, member) {
  const cfg = guildConfig.get(guild.id);
  if (!cfg?.quarantine_role_id) return { ok: true, removed: false };
  const removed = await member.roles.remove(cfg.quarantine_role_id, 'BotApprove: quarantine lifted')
    .then(() => true).catch(() => false);
  return { ok: removed, removed };
}

export { ROLE_NAME, DENY };
