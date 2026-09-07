import { EmbedBuilder } from 'discord.js';
import { guildConfig, webhookEvents } from '../db/queries.js';
import { record } from './securityService.js';
import { createLogger } from '../logger.js';

const log = createLogger('webhook-guard');

export const MODES = ['off', 'report', 'delete'];

export const MODE_LABELS = {
  off: 'Do nothing',
  report: 'Tell me when one is created',
  delete: 'Delete it and tell me',
};

export function mode(guildId) {
  const cfg = guildConfig.get(guildId);
  const value = cfg?.webhook_guard;
  return MODES.includes(value) ? value : 'report';
}

async function alert(guild, { webhook, actor, outcome, channelId }) {
  const cfg = guildConfig.get(guild.id);
  const channelId2 = cfg?.log_channel_id ?? cfg?.notify_channel_id;
  if (!channelId2) return;

  const channel = await guild.channels.fetch(channelId2).catch(() => null);
  if (!channel?.isTextBased?.()) return;

  const outcomeText = {
    deleted: 'Deleted it.',
    reported: 'Left in place. This server is set to report only.',
    delete_failed: '**Could not delete it.** BotApprove may lack Manage Webhooks.',
    owner_created: 'Left in place: the server owner created it.',
  }[outcome] ?? outcome;

  await channel.send({
    embeds: [new EmbedBuilder()
      .setColor(outcome === 'deleted' ? 0xcf222e : 0xd29922)
      .setTitle('A webhook was created')
      .setDescription(
        `${actor ? `<@${actor.id}> (\`${actor.tag ?? actor.id}\`)` : 'Someone'} created ` +
        `**${webhook?.name ?? 'a webhook'}**${channelId ? ` in <#${channelId}>` : ''}.\n\n` +
        'A webhook can post to that channel forever, without an account and without an ' +
        'invite. If you did not expect this one, delete it.',
      )
      .addFields({ name: 'Response', value: outcomeText })
      .setTimestamp(new Date())],
    allowedMentions: { parse: [] },
  }).catch((err) => log.warn('could not post webhook alert', { err: err.message }));
}

export async function onWebhookCreated(guild, { webhookId, name, channelId, actor }) {
  const configured = mode(guild.id);
  if (configured === 'off') return { outcome: 'disabled' };

  if (actor?.id === guild.client.user?.id) return { outcome: 'self' };

  let outcome = 'reported';

  if (configured === 'delete' && actor?.id !== guild.ownerId) {
    const hook = await guild.fetchWebhooks()
      .then((hooks) => hooks.get(webhookId))
      .catch(() => null);
    if (hook) {
      outcome = await hook.delete('BotApprove: webhook guard')
        .then(() => 'deleted')
        .catch((err) => {
          log.warn('could not delete webhook', { guildId: guild.id, webhookId, err: err.message });
          return 'delete_failed';
        });
    } else {
      outcome = 'delete_failed';
    }
  } else if (configured === 'delete') {
    outcome = 'owner_created';
  }

  webhookEvents.create({
    guildId: guild.id,
    webhookId,
    webhookName: name,
    channelId,
    actorId: actor?.id,
    actorTag: actor?.tag,
    outcome,
  });

  await record({
    guildId: guild.id,
    actorId: actor?.id,
    action: 'webhook_created',
    severity: outcome === 'deleted' ? 'high' : 'medium',
    title: 'A webhook was created',
    description: `${actor?.tag ?? 'Someone'} created \`${name ?? webhookId}\`. Response: ${outcome}.`,
    detail: { webhook_id: webhookId, name, channel_id: channelId, outcome },
  }).catch(() => {});

  await alert(guild, { webhook: { name }, actor, outcome, channelId }).catch(() => {});

  log.alert('webhook created', { guildId: guild.id, webhookId, outcome, actorId: actor?.id });
  return { outcome };
}
