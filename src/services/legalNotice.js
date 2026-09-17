/**
 * Tell every server that the Terms and Privacy Policy changed.
 *
 * Goes to every server, not just paying ones: the documents govern everybody
 * using either bot.
 *
 * It does not list what changed. A notice that recites its own diff gets
 * skimmed and dismissed, and the documents are a click away and are the thing
 * that actually binds. What it does say is the date, that carrying on means
 * accepting them, and where to read them.
 *
 * Keyed on the version rather than a plain "sent" flag, so the next change can
 * be announced without unpicking this one, and this one still cannot repeat.
 */
import { EmbedBuilder } from 'discord.js';
import { instanceState } from '../db/queries.js';
import { config } from '../config.js';
import { findChannel } from './raidProtectorAnnounce.js';
import { record } from './securityService.js';
import { createLogger } from '../logger.js';
import { blocked as isBlocked } from './safeMode.js';

const log = createLogger('legal-notice');

const KEY = 'legal_notice_sent_version';
const GAP_MS = 1200;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const version = () => config.legal.noticeVersion;
export const sentVersion = () => instanceState.get(KEY);
export const alreadySent = () => Boolean(version()) && sentVersion() === version();

export function buildEmbed() {
  const base = config.web.baseUrl;
  return new EmbedBuilder()
    .setColor(0xd29922)
    .setTitle('The Terms and Privacy Policy have changed')
    .setDescription(
      `Both documents were updated on **${config.legal.noticeDate}**. Carrying on using `
      + 'BotApprove or RaidProtector means you accept them as they now stand. If you would '
      + 'rather not, you can remove the bot at any time and nothing further is kept.',
    )
    .addFields(
      { name: 'BotApprove', value: `Terms: ${base}/terms\nPrivacy: ${base}/privacy` },
      {
        name: 'RaidProtector',
        value: `Terms: ${base}/raidprotector/terms\nPrivacy: ${base}/raidprotector/privacy`,
      },
      {
        name: 'Nothing you need to do',
        value: 'No setting changed, nothing was switched on, and no feature was taken away. '
          + 'This is a notice, not a request.',
      },
    )
    .setFooter({ text: 'Sent once per change. There is no mailing list and this is not repeated.' })
    .setTimestamp(new Date());
}

/**
 * @param {object} client
 * @param {object} opts
 * @param {boolean} opts.send        actually deliver. Off by default on purpose.
 * @param {string}  [opts.onlyGuild] deliver to one server, for looking at it first
 */
export async function announce(client, { send = false, onlyGuild = null } = {}) {
  if (!version()) return { ok: false, reason: 'no_version_configured' };
  if (send && isBlocked('broadcast', { fn: 'announceLegalNotice' })) {
    return { ok: false, reason: 'safe_mode' };
  }

  const all = [...client.guilds.cache.values()];
  const list = onlyGuild ? all.filter((g) => g.id === onlyGuild) : all;

  if (!send) {
    return {
      ok: true,
      dryRun: true,
      version: version(),
      sentVersion: sentVersion(),
      would: list.map((g) => ({ id: g.id, name: g.name })),
    };
  }

  // A single copy sent somewhere to look at must not burn the version for
  // everybody else.
  if (!onlyGuild && alreadySent()) {
    return { ok: false, reason: 'already_sent', at: sentVersion() };
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
    instanceState.set(KEY, version());
    await record({
      actorId: null,
      action: 'legal_notice_announced',
      severity: 'low',
      detail: { version: version(), inChannel, byDm, failed, guilds: list.length },
      mirror: false,
    }).catch(() => {});
  }

  log.info('legal notice announced', { version: version(), inChannel, byDm, failed, guilds: list.length, onlyGuild });
  return { ok: true, sent: inChannel + byDm, inChannel, byDm, failed, guilds: list.length };
}
