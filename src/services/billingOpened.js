import { EmbedBuilder, PermissionsBitField } from 'discord.js';
import { instanceState, guildConfig } from '../db/queries.js';
import { config } from '../config.js';
import { isEnabled as stripeEnabled, availablePlans } from './stripeService.js';
import { record } from './securityService.js';
import { createLogger } from '../logger.js';

const log = createLogger('billing-opened');

const KEY = 'stripe_enabled_last_seen';

// Discord treats bulk unsolicited DMs as spam, so these go out slowly.
const GAP_MS = 1200;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Has card payment just been switched on?
 *
 * Compared against what was last seen rather than assumed from the current
 * value, so a fresh install that has always had Stripe enabled announces
 * nothing. Only a real off-to-on transition counts.
 */
export function transition() {
  const seen = instanceState.get(KEY);
  const now = stripeEnabled() ? 'enabled' : 'disabled';
  return { seen, now, opened: seen === 'disabled' && now === 'enabled', firstRun: seen === null };
}

function buildEmbed() {
  const plans = availablePlans();
  const price = (amount) => `${config.paywall.priceSymbol}${amount}`;

  const lines = [];
  if (plans.includes('monthly')) lines.push(`${price(config.paywall.priceAmount)} a month`);
  if (plans.includes('yearly')) lines.push(`${price(config.stripe.priceAmountYearly)} a year, two months free`);
  if (plans.includes('lifetime')) lines.push(`${price(config.stripe.priceAmountLifetime)} once, for as long as BotApprove operates`);

  return new EmbedBuilder()
    .setColor(0x5e9bff)
    .setTitle('Card payment is now available for BotApprove')
    .setDescription(
      'You are getting this because you run a server with BotApprove in it. When card payment ' +
      'was unavailable, the pricing page said everyone would be told once it opened. This is that.',
    )
    .addFields(
      { name: 'Plans', value: lines.length ? lines.map((l) => `• ${l}`).join('\n') : 'See the pricing page.' },
      {
        name: 'Nothing has changed for you',
        value: 'The approval gate, keyword blocking, the audit trail and tamper detection are ' +
          'free forever and always were. Nothing has been switched off, and nothing will be.',
      },
      {
        name: 'Already hold a licence key?',
        value: 'Keep using it. Keys are unaffected and you do not need to pay for anything you ' +
          'already have.',
      },
      { name: 'Pricing', value: `${config.web.baseUrl}/pricing` },
    )
    .setFooter({ text: 'Sent once. There is no mailing list and this is not repeated.' })
    .setTimestamp(new Date());
}

/**
 * Somewhere in the server the owner will see, preferring channels they chose.
 *
 * The announcement channel is opted into explicitly for exactly this sort of
 * message, so it comes first; the others are at least channels the server
 * nominated for BotApprove to post in.
 */
async function findChannel(guild) {
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
 * Announce once, to the person who runs each server BotApprove is in.
 *
 * A mention in a channel the server nominated, falling back to a DM only where
 * there is no usable channel. Bulk unsolicited DM is against Discord's
 * developer policy and is what gets a bot reported, so it is the exception here
 * rather than the mechanism.
 */
export async function announceIfOpened(client) {
  const state = transition();

  if (!state.opened) {
    // Record the current state either way, so the next flip is detectable.
    instanceState.set(KEY, state.now);
    return { announced: false, reason: state.firstRun ? 'first_run' : 'no_change', ...state };
  }

  const embed = buildEmbed();
  let inChannel = 0;
  let byDm = 0;
  let failed = 0;
  let guilds = 0;

  for (const [, guild] of client.guilds.cache) {
    guilds += 1;

    // Posting in a channel the server nominated is not an unsolicited message,
    // and a mention reaches the owner just as surely as a DM would. DMs are the
    // fallback rather than the default, because bulk DM is what gets a bot
    // reported.
    const channel = await findChannel(guild).catch(() => null);
    const ownerId = guild.ownerId ?? (await guild.fetchOwner().catch(() => null))?.id;

    if (channel) {
      const ok = await channel.send({
        content: ownerId ? `<@${ownerId}>` : undefined,
        embeds: [embed],
        allowedMentions: ownerId ? { users: [ownerId] } : { parse: [] },
      }).then(() => true).catch(() => false);

      if (ok) { inChannel += 1; await sleep(GAP_MS); continue; }
    }

    const owner = await guild.fetchOwner().catch(() => null);
    if (!owner) { failed += 1; continue; }

    const sent = await owner.send({ embeds: [embed] }).then(() => true).catch(() => false);
    if (sent) byDm += 1; else failed += 1;
    await sleep(GAP_MS);
  }

  const delivered = inChannel + byDm;

  // Written after the run so a crash mid-announcement retries rather than
  // silently skipping everyone who had not been reached yet.
  instanceState.set(KEY, 'enabled');

  log.info('billing opened announcement sent', { guilds, inChannel, byDm, failed });
  await record({
    action: 'billing_opened_announced',
    severity: 'medium',
    detail: { guilds, in_channel: inChannel, by_dm: byDm, failed },
    mirror: false,
  }).catch(() => {});

  return { announced: true, guilds, delivered, inChannel, byDm, failed };
}
