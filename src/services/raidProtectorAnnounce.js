/**
 * Tell servers holding a licence that it now covers RaidProtector.
 *
 * Deliberately not on a sweep. This goes to real people once, so it is run by
 * hand from scripts/announce-raidprotector.js and refuses to run twice.
 *
 * Shaped like billingOpened.js because that shape is right: a mention in a
 * channel the server nominated, a DM only where there is no usable channel.
 * Bulk unsolicited DM is against Discord's developer policy and is what gets a
 * bot reported, so it is the exception rather than the mechanism.
 */
import { EmbedBuilder, PermissionsBitField } from 'discord.js';
import { instanceState, guildConfig } from '../db/queries.js';
import { config } from '../config.js';
import { resolveEntitlement } from './entitlementService.js';
import { guildIds as raidProtectorGuilds } from './raidprotector.js';
import { record } from './securityService.js';
import { createLogger } from '../logger.js';
import { blocked as isBlocked } from './safeMode.js';

const log = createLogger('rp-announce');

const KEY = 'raidprotector_beta_announced_at';
const GAP_MS = 1200;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const alreadySent = () => instanceState.get(KEY);

export function buildEmbed() {
  return new EmbedBuilder()
    .setColor(0x0b95d6)
    .setTitle('Your licence now covers RaidProtector')
    .setDescription(
      'You are getting this because this server holds a Protection Suite licence. It now '
      + 'includes **RaidProtector**, our raid detection bot, while its beta runs. There is '
      + 'nothing more to pay and no second checkout.',
    )
    .addFields(
      {
        name: 'What it does',
        value: 'Two independent signals before it touches anyone, thresholds learned from your '
          + 'server rather than guessed, timeouts instead of bans, and one button that undoes a '
          + 'whole incident.',
      },
      {
        name: 'It will not act on its own',
        value: 'It starts in **report mode**, which means it watches and tells you what it would '
          + 'have done without touching a single member. You decide if and when that changes.',
      },
      {
        name: 'It is a separate bot',
        value: 'It needs permissions BotApprove deliberately does not ask for, so it has its own '
          + 'invite rather than being folded into this one. Adding it changes nothing here.',
      },
      {
        name: 'Add it',
        value: config.raidProtector.inviteUrl || `${config.web.baseUrl}/raidprotector`,
      },
      {
        name: 'Read first, if you would rather',
        value: `${config.web.baseUrl}/raidprotector`,
      },
    )
    .setFooter({ text: 'Sent once, to servers with a licence. There is no mailing list and this is not repeated.' })
    .setTimestamp(new Date());
}

export async function findChannel(guild) {
  const cfg = guildConfig.get(guild.id);
  const me = guild.members.me;

  for (const id of [cfg.announce_channel_id, cfg.notify_channel_id, cfg.log_channel_id]) {
    if (!id) continue;
    const channel = await guild.channels.fetch(id).catch(() => null);
    if (!channel?.isTextBased?.()) continue;
    const perms = channel.permissionsFor(me);
    if (perms?.has(PermissionsBitField.Flags.SendMessages)
      && perms?.has(PermissionsBitField.Flags.ViewChannel)) {
      return channel;
    }
  }
  return null;
}

/**
 * Who should hear this: servers with a licence that do not already have the bot.
 *
 * Telling somebody about something they already have is noise, so RaidProtector
 * is asked which servers it is in and those are dropped. If it cannot be
 * reached, nobody is dropped and the caller is told the list is unfiltered,
 * because guessing would mean messaging people twice.
 */
export async function targets(client) {
  const licensed = [...client.guilds.cache.values()]
    .filter((g) => resolveEntitlement(g.id).licensed);

  const listed = await raidProtectorGuilds();
  const has = listed.ok ? new Set(listed.body?.ids ?? []) : null;

  return {
    guilds: has ? licensed.filter((g) => !has.has(g.id)) : licensed,
    licensed: licensed.length,
    alreadyHave: has ? licensed.filter((g) => has.has(g.id)).length : 0,
    filtered: Boolean(has),
    reason: listed.ok ? null : listed.reason,
  };
}

/**
 * @param {object} client
 * @param {object} opts
 * @param {boolean} opts.send        actually deliver. Off by default on purpose.
 * @param {string}  [opts.onlyGuild] deliver to one server, for looking at it first
 */
export async function announce(client, { send = false, onlyGuild = null } = {}) {
  if (send && isBlocked('broadcast', { fn: 'announceRaidProtector' })) {
    return { ok: false, reason: 'safe_mode' };
  }

  const found = await targets(client);
  const list = onlyGuild
    ? [...client.guilds.cache.values()].filter((g) => g.id === onlyGuild)
    : found.guilds;

  if (!send) {
    return { ok: true, dryRun: true, ...found, would: list.map((g) => ({ id: g.id, name: g.name })) };
  }

  // The one-time guard covers the real run only. Sending a single copy
  // somewhere to look at it should not burn the announcement for everybody.
  if (!onlyGuild && alreadySent()) {
    return { ok: false, reason: 'already_sent', at: alreadySent() };
  }

  const embed = buildEmbed();
  let inChannel = 0;
  let byDm = 0;
  let failed = 0;

  for (const guild of list) {
    const channel = await findChannel(guild).catch(() => null);
    const ownerId = guild.ownerId ?? (await guild.fetchOwner().catch(() => null))?.id;

    if (channel) {
      const ok = await channel.send({
        content: ownerId ? `<@${ownerId}>` : undefined,
        embeds: [embed],
        allowedMentions: ownerId ? { users: [ownerId] } : { parse: [] },
      }).then(() => true).catch(() => false);
      if (ok) inChannel += 1; else failed += 1;
    } else if (ownerId) {
      const owner = await client.users.fetch(ownerId).catch(() => null);
      const ok = owner
        ? await owner.send({ embeds: [embed] }).then(() => true).catch(() => false)
        : false;
      if (ok) byDm += 1; else failed += 1;
    } else {
      failed += 1;
    }

    await sleep(GAP_MS);
  }

  if (!onlyGuild) {
    instanceState.set(KEY, new Date().toISOString());
    await record({
      actorId: null,
      action: 'raidprotector_beta_announced',
      severity: 'low',
      detail: { inChannel, byDm, failed, guilds: list.length },
      mirror: false,
    }).catch(() => {});
  }

  log.info('raidprotector beta announced', { inChannel, byDm, failed, guilds: list.length, onlyGuild });
  return { ok: true, sent: inChannel + byDm, inChannel, byDm, failed, guilds: list.length };
}
