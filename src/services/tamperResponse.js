import { EmbedBuilder, PermissionsBitField } from 'discord.js';
import { guildConfig, tamperResponses } from '../db/queries.js';
import { apply as applyQuarantine, lift as liftQuarantine } from './quarantine.js';
import { record } from './securityService.js';
import { createLogger } from '../logger.js';

const log = createLogger('tamper');

export const MODES = ['off', 'defend', 'strip', 'quarantine'];

export const MODE_LABELS = {
  off: 'Do nothing',
  defend: 'Report it',
  strip: 'Report it and remove the roles of whoever did it',
  quarantine: 'Report it, remove their roles, and cut off their channel access',
};

const BREAKER_WINDOW_MS = 10 * 60_000;
const BREAKER_MAX = 3;

const REQUIRED = ['KickMembers', 'ViewAuditLog'];

export function mode(guildId) {
  const cfg = guildConfig.get(guildId);
  const value = cfg?.tamper_response;
  return MODES.includes(value) ? value : 'defend';
}

export function removableRoles(me, member) {
  const ceiling = me.roles.highest.position;
  return [...member.roles.cache.values()].filter(
    (r) => r.id !== member.guild.id && !r.managed && r.position < ceiling,
  );
}

function describe(trigger) {
  return {
    role_position: "BotApprove's role was moved down",
    permissions_removed: 'A permission BotApprove needs was taken away',
    role_deleted: "BotApprove's role was deleted",
    role_removed: "BotApprove's role was taken off it",
  }[trigger] ?? 'BotApprove was weakened';
}

async function alert(guild, { trigger, actor, outcome, removed, note }) {
  const cfg = guildConfig.get(guild.id);
  const channelId = cfg?.log_channel_id ?? cfg?.notify_channel_id;
  if (!channelId) return;

  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return;

  const outcomeText = {
    stripped: `Removed ${removed?.length ?? 0} role(s) from them.`,
    quarantined: `Removed ${removed?.length ?? 0} role(s) and quarantined them.`,
    reported: 'No action taken against them: this server is set to report only.',
    owner_exempt: 'No action taken: the server owner is allowed to do this.',
    unreachable: 'Could not act: their roles rank at or above BotApprove.',
    actor_unknown: 'Could not tell who did it. Check the audit log.',
    actor_left: 'They are no longer in the server.',
    breaker_open: '**Stopped acting.** Too many responses in a short window, so '
      + 'BotApprove has stood down here to avoid being used to strip roles. '
      + 'Review what is triggering this before re-enabling.',
    no_permission: 'Could not act: BotApprove no longer holds Manage Roles.',
    disabled: 'No action taken: responses are switched off for this server.',
  }[outcome] ?? outcome;

  const embed = new EmbedBuilder()
    .setColor(['stripped', 'quarantined'].includes(outcome) ? 0xcf222e : 0xd29922)
    .setTitle(describe(trigger))
    .setDescription(
      actor
        ? `<@${actor.id}> (\`${actor.tag ?? actor.id}\`) did this.`
        : 'The audit log did not name who did this.',
    )
    .addFields({ name: 'Response', value: outcomeText })
    .setTimestamp(new Date());

  if (removed?.length) {
    embed.addFields({
      name: 'Roles removed',
      value: removed.map((r) => `<@&${r.id}>`).join(' ').slice(0, 1024),
    });
  }
  if (note) embed.addFields({ name: 'Note', value: note.slice(0, 1024) });

  await channel.send({
    embeds: [embed],
    allowedMentions: { parse: [] },
  }).catch((err) => log.warn('could not post tamper alert', { guildId: guild.id, err: err.message }));
}

async function finish(guild, { trigger, actor, outcome, removed = null, note, detail }) {
  tamperResponses.create({
    guildId: guild.id,
    actorId: actor?.id,
    actorTag: actor?.tag,
    trigger,
    outcome,
    rolesRemoved: removed?.length ? removed.map((r) => ({ id: r.id, name: r.name })) : null,
    detail,
  });

  await record({
    guildId: guild.id,
    actorId: actor?.id,
    action: 'tamper_response',
    severity: ['stripped', 'quarantined', 'breaker_open'].includes(outcome) ? 'critical' : 'high',
    title: describe(trigger),
    description: `${actor ? `${actor.tag ?? actor.id} ` : 'Someone '}weakened BotApprove. `
      + `Response: ${outcome}.`,
    detail: { trigger, outcome, actor_id: actor?.id, removed: removed?.length ?? 0, ...detail },
  }).catch(() => {});

  await alert(guild, { trigger, actor, outcome, removed, note }).catch(() => {});

  log.alert('tamper response', { guildId: guild.id, trigger, outcome, actorId: actor?.id });
  return { outcome, removed: removed?.length ?? 0, actorId: actor?.id ?? null };
}

export async function respond(guild, { trigger, actor = null, detail = null }) {
  const configured = mode(guild.id);
  const me = guild.members.me ?? await guild.members.fetchMe().catch(() => null);

  if (configured === 'off') {
    return finish(guild, { trigger, actor, outcome: 'disabled', detail });
  }
  if (!me) return { outcome: 'self_unavailable' };

  if (actor && actor.id === me.id) return { outcome: 'self_inflicted' };

  if (!actor) {
    return finish(guild, { trigger, actor, outcome: 'actor_unknown', detail });
  }

  if (actor.id === guild.ownerId) {
    return finish(guild, { trigger, actor, outcome: 'owner_exempt', detail });
  }

  if (configured === 'defend') {
    return finish(guild, { trigger, actor, outcome: 'reported', detail });
  }

  const since = Date.now() - BREAKER_WINDOW_MS;

  if (tamperResponses.countSince(guild.id, since) >= BREAKER_MAX) {
    return finish(guild, { trigger, actor, outcome: 'breaker_open', detail });
  }

  if (!me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
    return finish(guild, { trigger, actor, outcome: 'no_permission', detail });
  }

  const member = guild.members.cache.get(actor.id)
    ?? await guild.members.fetch(actor.id).catch(() => null);
  if (!member) {
    return finish(guild, { trigger, actor, outcome: 'actor_left', detail });
  }

  const removable = removableRoles(me, member);
  if (!removable.length) {
    return finish(guild, { trigger, actor, outcome: 'unreachable', detail });
  }

  const removed = [];
  for (const role of removable) {
    const ok = await member.roles.remove(role, `BotApprove: ${describe(trigger)}`)
      .then(() => true)
      .catch((err) => {
        log.warn('could not remove role', { guildId: guild.id, roleId: role.id, err: err.message });
        return false;
      });
    if (ok) removed.push(role);
  }

  if (!removed.length) {
    return finish(guild, { trigger, actor, outcome: 'unreachable', detail });
  }

  const kept = removable.length - removed.length;
  const notes = kept ? [`${kept} role(s) could not be removed.`] : [];

  if (configured === 'quarantine') {
    const q = await applyQuarantine(guild, member);
    notes.push(q.ok
      ? 'Quarantine role applied; they cannot see or post in channels.'
      : `Roles were removed but the quarantine role could not be applied (${q.reason}).`);
  }

  return finish(guild, {
    trigger,
    actor,
    outcome: configured === 'quarantine' && removed.length ? 'quarantined' : 'stripped',
    removed,
    note: notes.length ? notes.join(' ') : undefined,
    detail,
  });
}

export async function restore(guild, actorId) {
  const rows = tamperResponses.restorable(guild.id, actorId);
  if (!rows.length) return { restored: 0, reason: 'nothing_to_restore' };

  const member = await guild.members.fetch(actorId).catch(() => null);
  if (!member) return { restored: 0, reason: 'not_a_member' };

  await liftQuarantine(guild, member).catch(() => {});

  let restored = 0;
  let missing = 0;
  for (const row of rows) {
    let roles;
    try { roles = JSON.parse(row.roles_removed ?? '[]'); } catch { roles = []; }
    for (const r of roles) {
      if (!guild.roles.cache.has(r.id)) { missing += 1; continue; }
      const ok = await member.roles.add(r.id, 'BotApprove: tamper response reversed')
        .then(() => true).catch(() => false);
      if (ok) restored += 1; else missing += 1;
    }
    tamperResponses.markRestored(row.id);
  }

  await record({
    guildId: guild.id,
    actorId,
    action: 'tamper_response_reversed',
    severity: 'medium',
    title: 'Tamper response reversed',
    detail: { restored, missing },
  }).catch(() => {});

  return { restored, missing };
}

export { REQUIRED };
