import { AuditLogEvent, PermissionsBitField } from 'discord.js';
import { respond, REQUIRED } from './tamperResponse.js';
import { createLogger } from '../logger.js';

const log = createLogger('tamper-watch');

const DEDUP_MS = 10_000;
const recent = new Map();

function alreadyHandled(guildId, trigger) {
  const key = `${guildId}:${trigger}`;
  const at = recent.get(key);
  if (at && Date.now() - at < DEDUP_MS) return true;
  recent.set(key, Date.now());

  if (recent.size > 500) {
    const cutoff = Date.now() - DEDUP_MS;
    for (const [k, t] of recent) if (t < cutoff) recent.delete(k);
  }
  return false;
}

async function findActor(guild, types) {
  for (const type of types) {
    const logs = await guild.fetchAuditLogs({ type, limit: 8 }).catch(() => null);
    if (!logs) continue;
    const entry = [...(logs.entries?.values() ?? [])]
      .filter((e) => Date.now() - e.createdTimestamp < 20_000)
      .sort((a, b) => b.createdTimestamp - a.createdTimestamp)[0];
    if (entry?.executor) {
      return { id: entry.executor.id, tag: entry.executor.tag, bot: !!entry.executor.bot };
    }
  }
  return null;
}

const isMine = (guild, roleId) => guild.members.me?.roles.highest.id === roleId;

export async function onRoleUpdate(oldRole, newRole) {
  const guild = newRole.guild;
  const me = guild.members.me;
  if (!me) return null;

  if (!isMine(guild, newRole.id) && !isMine(guild, oldRole.id)) return null;

  const demoted = newRole.position < oldRole.position;
  const lost = REQUIRED.filter(
    (p) => oldRole.permissions.has(PermissionsBitField.Flags[p], false)
      && !newRole.permissions.has(PermissionsBitField.Flags[p], false),
  );

  if (!demoted && !lost.length) return null;

  const trigger = lost.length ? 'permissions_removed' : 'role_position';
  if (alreadyHandled(guild.id, trigger)) return null;

  log.alert('own role weakened', {
    guildId: guild.id,
    from: oldRole.position,
    to: newRole.position,
    lost,
  });

  const actor = await findActor(guild, [AuditLogEvent.RoleUpdate]);
  return respond(guild, {
    trigger,
    actor,
    detail: { from: oldRole.position, to: newRole.position, lost: lost.length ? lost : undefined },
  });
}

export async function onRoleDelete(role) {
  const guild = role.guild;
  const me = guild.members.me;
  if (!me) return null;

  if (!role.members?.has?.(me.id) && me.roles.highest.id !== role.id) return null;
  if (alreadyHandled(guild.id, 'role_deleted')) return null;

  log.alert('own role deleted', { guildId: guild.id, roleId: role.id, name: role.name });

  const actor = await findActor(guild, [AuditLogEvent.RoleDelete]);
  return respond(guild, {
    trigger: 'role_deleted',
    actor,
    detail: { role_name: role.name },
  });
}

export async function onSelfMemberUpdate(oldMember, newMember) {
  const guild = newMember.guild;
  if (newMember.id !== guild.client.user?.id) return null;

  const removedRoles = [...oldMember.roles.cache.keys()]
    .filter((id) => !newMember.roles.cache.has(id));
  if (!removedRoles.length) return null;

  const lostHeight = newMember.roles.highest.position < oldMember.roles.highest.position;
  const lost = REQUIRED.filter(
    (p) => oldMember.permissions.has(PermissionsBitField.Flags[p], false)
      && !newMember.permissions.has(PermissionsBitField.Flags[p], false),
  );
  if (!lostHeight && !lost.length) return null;
  if (alreadyHandled(guild.id, 'role_removed')) return null;

  log.alert('own roles taken', { guildId: guild.id, removed: removedRoles.length, lost });

  const actor = await findActor(guild, [AuditLogEvent.MemberRoleUpdate]);
  return respond(guild, {
    trigger: 'role_removed',
    actor,
    detail: {
      removed: removedRoles.length,
      from: oldMember.roles.highest.position,
      to: newMember.roles.highest.position,
      lost: lost.length ? lost : undefined,
    },
  });
}
