import { EmbedBuilder } from 'discord.js';
import { instanceState, approverRoles, guildConfig } from '../db/queries.js';
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

async function recipients(guild) {
  const targets = new Map();

  const owner = await guild.fetchOwner().catch(() => null);
  if (owner) targets.set(owner.id, owner);

  const roleIds = approverRoles.list(guild.id);
  if (roleIds.length) {
    const members = await guild.members.fetch().catch(() => null);
    if (members) {
      for (const [, m] of members) {
        if (m.user.bot) continue;
        if (m.roles.cache.some((r) => roleIds.includes(r.id))) targets.set(m.id, m);
      }
    }
  }
  return [...targets.values()];
}

/**
 * Announce once, to the people who actually run the servers BotApprove is in.
 *
 * Deliberately not every member of every server: that is bulk unsolicited DM,
 * which is against Discord's developer policy and would put verification at
 * risk. Owners and approvers already have a relationship with the bot.
 */
export async function announceIfOpened(client) {
  const state = transition();

  if (!state.opened) {
    // Record the current state either way, so the next flip is detectable.
    instanceState.set(KEY, state.now);
    return { announced: false, reason: state.firstRun ? 'first_run' : 'no_change', ...state };
  }

  const embed = buildEmbed();
  let delivered = 0;
  let failed = 0;
  let guilds = 0;

  for (const [, guild] of client.guilds.cache) {
    guilds += 1;
    const people = await recipients(guild).catch(() => []);
    for (const member of people) {
      const ok = await member.send({ embeds: [embed] }).then(() => true).catch(() => false);
      if (ok) delivered += 1; else failed += 1;
      await sleep(GAP_MS);
    }

    // A fallback for servers whose owner has DMs closed, so the notice is not
    // simply lost.
    if (!people.length) {
      const cfg = guildConfig.get(guild.id);
      const channelId = cfg.notify_channel_id ?? cfg.log_channel_id;
      const channel = channelId ? await guild.channels.fetch(channelId).catch(() => null) : null;
      if (channel?.isTextBased?.()) {
        await channel.send({ embeds: [embed] }).catch(() => {});
      }
    }
  }

  // Written after the run so a crash mid-announcement retries rather than
  // silently skipping everyone who had not been reached yet.
  instanceState.set(KEY, 'enabled');

  log.info('billing opened announcement sent', { guilds, delivered, failed });
  await record({
    action: 'billing_opened_announced',
    severity: 'medium',
    detail: { guilds, delivered, failed },
    mirror: false,
  }).catch(() => {});

  return { announced: true, guilds, delivered, failed };
}
