import { EmbedBuilder, PermissionsBitField } from 'discord.js';
import { guildConfig, externalAppEvents, externalAppRules } from '../db/queries.js';
import { record } from './securityService.js';
import { createLogger } from '../logger.js';
import { blocked } from './safeMode.js';

const log = createLogger('external-app');

export const ACTIONS = ['off', 'report', 'delete', 'timeout', 'kick', 'ban'];

export const ACTION_LABELS = {
  off: 'Do nothing, and do not tell me',
  report: 'Tell me, leave the message up',
  delete: 'Delete the message',
  timeout: 'Delete it and time the person out',
  kick: 'Delete it and kick the person',
  ban: 'Delete it and ban the person',
};

const DELETES = ['delete', 'timeout', 'kick', 'ban'];
const HITS_PERSON = ['timeout', 'kick', 'ban'];

const TIMEOUT_MS = 10 * 60_000;

const BREAKER_WINDOW_MS = 10 * 60_000;
const BREAKER_MAX = 5;

const ALERT_QUIET_MS = 30 * 60_000;

export function action(guildId) {
  const cfg = guildConfig.get(guildId);
  const value = cfg?.external_app_action;
  return ACTIONS.includes(value) ? value : 'report';
}

export function fromUserInstalledApp(message) {
  const owners = message?.interactionMetadata?.authorizingIntegrationOwners;
  if (!owners) return null;
  if (!owners.userId || owners.guildId) return null;
  return {
    appId: message.applicationId ?? null,
    installedBy: owners.userId,
    actor: message.interactionMetadata.user ?? null,
  };
}

async function alert(guild, { actor, appId, channelId, outcome, deleted, burst, repeat }) {
  const cfg = guildConfig.get(guild.id);
  const target = cfg?.log_channel_id ?? cfg?.notify_channel_id;
  if (!target) return;
  const channel = await guild.channels.fetch(target).catch(() => null);
  if (!channel?.isTextBased?.()) return;

  const outcomeText = {
    reported: 'Left in place. This server is set to report only.',
    deleted: 'Message deleted.',
    timeout: 'Message deleted and the person timed out for 10 minutes.',
    kick: 'Message deleted and the person kicked.',
    ban: 'Message deleted and the person banned.',
    below_burst: 'Message deleted. Not enough activity yet to act on the person.',
    owner_exempt: 'No action: the server owner is allowed to do this.',
    unreachable: 'Could not act: they rank at or above BotApprove.',
    no_permission: 'Could not act: BotApprove lacks the permission for it.',
    breaker_open: '**Stopped acting.** Too many responses in a short window, so BotApprove has '
      + 'stood down here rather than keep punishing people. Review before re-enabling.',
    failed: 'The action did not go through.',
  }[outcome] ?? outcome;

  await channel.send({
    embeds: [new EmbedBuilder()
      .setColor(HITS_PERSON.includes(outcome) ? 0xcf222e : 0xd29922)
      .setTitle('An app posted here without being in the server')
      .setDescription(
        `${actor ? `<@${actor.id}> (\`${actor.tag ?? actor.id}\`)` : 'Someone'} used an app they `
        + 'installed to their own account, not to this server. It never went through the '
        + 'approval gate because it never joined.'
        + (channelId ? `\n\nIn <#${channelId}>.` : ''),
      )
      .addFields(
        { name: 'App', value: appId ? `\`${appId}\`` : 'unknown', inline: true },
        { name: 'Recent messages', value: String(burst ?? 1), inline: true },
        { name: 'Response', value: outcomeText },
        {
          name: repeat ? 'Seen before' : 'If this one is fine',
          value: repeat
            ? 'This app has posted here before. Further messages from it are recorded but not '
              + 'reported again for half an hour, so this channel does not fill up.'
            : 'Allow it on the Threats tab and it stops being flagged here at all. Otherwise, '
              + 'turning off **Use External Apps** for @everyone in Server Settings, Roles, '
              + 'Apps Permissions prevents all of this rather than cleaning up after it.',
        },
      )
      .setTimestamp(new Date())],
    allowedMentions: { parse: [] },
  }).catch((err) => log.warn('could not post alert', { guildId: guild.id, err: err.message }));
}

function reachable(me, member) {
  if (!member) return false;
  return me.roles.highest.comparePositionTo(member.roles.highest) > 0;
}

export async function onExternalAppMessage(message) {
  const guild = message.guild;
  if (!guild) return { outcome: 'not_a_guild' };

  const found = fromUserInstalledApp(message);
  if (!found) return { outcome: 'not_external' };

  const configured = action(guild.id);

  const rule = found.appId ? externalAppRules.get(guild.id, found.appId) : null;
  if (rule?.rule === 'allow') return { outcome: 'allowed_app' };

  if (configured === 'off' && rule?.rule !== 'block') return { outcome: 'disabled' };

  const me = guild.members.me;
  const actor = found.actor;
  const actorId = actor?.id ?? found.installedBy;

  const effective = rule?.rule === 'block' && !HITS_PERSON.includes(configured)
    ? 'delete'
    : configured;

  let deleted = false;
  if ((DELETES.includes(effective) || rule?.rule === 'block')
    && me?.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
    deleted = await message.delete().then(() => true).catch(() => false);
  }

  const since = Date.now() - (guildConfig.get(guild.id)?.external_app_window_s ?? 15) * 1000;
  const burst = externalAppEvents.burstCount(guild.id, actorId, since) + 1;
  const threshold = guildConfig.get(guild.id)?.external_app_burst ?? 3;

  let outcome = deleted ? 'deleted' : 'reported';

  if (HITS_PERSON.includes(effective)) {
    if (blocked('act_on_member', { guildId: guild.id, effective })) {
      outcome = deleted ? 'deleted' : 'safe_mode';
    } else if (actorId === guild.ownerId) {
      outcome = 'owner_exempt';
    } else if (externalAppEvents.actedSince(guild.id, Date.now() - BREAKER_WINDOW_MS) >= BREAKER_MAX) {
      outcome = 'breaker_open';
    } else if (burst < threshold && rule?.rule !== 'block') {
      outcome = 'below_burst';
    } else {
      const member = guild.members.cache.get(actorId)
        ?? await guild.members.fetch(actorId).catch(() => null);

      if (!reachable(me, member)) {
        outcome = 'unreachable';
      } else if (effective === 'timeout') {
        outcome = me.permissions.has(PermissionsBitField.Flags.ModerateMembers)
          ? await member.timeout(TIMEOUT_MS, 'BotApprove: raiding with a user-installed app')
            .then(() => 'timeout').catch(() => 'failed')
          : 'no_permission';
      } else if (effective === 'kick') {
        outcome = me.permissions.has(PermissionsBitField.Flags.KickMembers)
          ? await member.kick('BotApprove: raiding with a user-installed app')
            .then(() => 'kick').catch(() => 'failed')
          : 'no_permission';
      } else if (effective === 'ban') {
        outcome = me.permissions.has(PermissionsBitField.Flags.BanMembers)
          ? await guild.bans.create(actorId, {
            reason: 'BotApprove: raiding with a user-installed app',
            deleteMessageSeconds: 3600,
          }).then(() => 'ban').catch(() => 'failed')
          : 'no_permission';
      }
    }
  }

  externalAppEvents.create({
    guildId: guild.id,
    channelId: message.channelId,
    messageId: message.id,
    appId: found.appId,
    actorId,
    actorTag: actor?.tag ?? null,
    deleted,
    action: effective,
    outcome,
  });

  await record({
    guildId: guild.id,
    actorId,
    action: 'external_app_message',
    severity: HITS_PERSON.includes(outcome) ? 'critical' : 'high',
    title: 'An app posted without being in the server',
    description: `${actor?.tag ?? actorId} used a user-installed app. Response: ${outcome}.`,
    detail: { app_id: found.appId, deleted, burst, configured, effective, outcome, rule: rule?.rule ?? null },
  }).catch(() => {});

  const alreadyAlerted = found.appId
    ? externalAppEvents.alertedSince(guild.id, found.appId, Date.now() - ALERT_QUIET_MS) > 1
    : false;
  const worthSaying = HITS_PERSON.includes(outcome) || outcome === 'breaker_open';

  if (worthSaying || !alreadyAlerted) {
    await alert(guild, {
      actor: actor ? { id: actor.id, tag: actor.tag } : { id: actorId },
      appId: found.appId,
      channelId: message.channelId,
      outcome,
      deleted,
      burst,
      repeat: alreadyAlerted,
    }).catch(() => {});
  }

  log.alert('external app message', {
    guildId: guild.id, actorId, appId: found.appId, outcome, burst,
  });
  return { outcome, deleted, burst };
}

export { TIMEOUT_MS, DELETES, HITS_PERSON };
