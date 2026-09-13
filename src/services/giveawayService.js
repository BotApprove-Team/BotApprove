import crypto from 'node:crypto';
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionsBitField,
} from 'discord.js';
import {
  giveaways, giveawayEntries, giveawayWinners, guildConfig, approverRoles,
} from '../db/queries.js';
import { config } from '../config.js';
import { resolveEntitlement, grantEntitlement } from './entitlementService.js';
import { record } from './securityService.js';
import { getClient } from '../bot/clientRef.js';
import { createLogger } from '../logger.js';

const log = createLogger('giveaway');

export const BUTTON = 'gw';

const GAP_MS = 1200;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function prizeLabel(row) {
  if (!row) return 'premium';
  if (row.duration_days === null) return 'premium forever';
  if (row.duration_days === 1) return 'premium for a day';
  return `premium for ${row.duration_days} days`;
}

export function eligible(guildId) {
  return !resolveEntitlement(guildId).licensed;
}

export function weighFor(guild) {
  const reasons = [{ why: 'Entered', entries: 1 }];
  const missing = [];
  const cfg = guildConfig.get(guild.id);
  const me = guild.members?.me;

  if (cfg?.notify_channel_id) {
    reasons.push({ why: 'Approval channel set', entries: 1 });
  } else {
    missing.push({
      why: 'No approval channel',
      how: 'Run `/config notify-channel` and pick a channel your moderators read. Without one, '
        + 'bots are still kicked but nobody is told about it.',
    });
  }

  if (approverRoles.list(guild.id).length) {
    reasons.push({ why: 'Approvers chosen', entries: 1 });
  } else {
    missing.push({
      why: 'Nobody can approve a bot',
      how: 'Run `/approvers add` with a role. Until then every bot stays kicked, because there '
        + 'is nobody allowed to let one back in.',
    });
  }

  if (me) {
    const position = me.roles.highest.position;
    const stuck = [...(guild.members.cache?.values?.() ?? [])]
      .filter((m) => m.user?.bot && m.id !== me.id && m.roles.highest.position >= position);

    if (!stuck.length) {
      reasons.push({ why: 'Can remove every bot here', entries: 1 });
    } else {
      const names = stuck.slice(0, 4).map((m) => m.user?.tag ?? m.id).join(', ');
      const more = stuck.length > 4 ? ` and ${stuck.length - 4} more` : '';
      missing.push({
        why: `Cannot remove ${stuck.length} bot(s) here`,
        how: `${names}${more} rank at or above BotApprove, so the gate would fail on them. `
          + 'Server Settings, Roles, drag BotApprove above them.',
      });
    }

    if (me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
      reasons.push({ why: 'Can defend itself', entries: 1 });
    } else {
      missing.push({
        why: 'Cannot defend itself',
        how: 'Grant Manage Roles in Server Settings, Roles, BotApprove. Without it, anyone who '
          + 'weakens BotApprove can only be reported, not stopped.',
      });
    }
  }

  return { weight: reasons.reduce((n, r) => n + r.entries, 0), reasons, missing };
}

function entryRow(giveawayId, closed = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${BUTTON}:enter:${giveawayId}`)
      .setLabel(closed ? 'Closed' : 'Enter this server')
      .setStyle(closed ? ButtonStyle.Secondary : ButtonStyle.Success)
      .setDisabled(closed),
  );
}

function buildEmbed(row) {
  const closes = Math.floor(row.closes_at / 1000);
  return new EmbedBuilder()
    .setColor(0x5e9bff)
    .setTitle(row.title || `Giveaway: ${prizeLabel(row)}`)
    .setDescription(
      `**${row.winners} server${row.winners === 1 ? '' : 's'}** will get **${prizeLabel(row)}**.\n\n`
      + 'Only the server owner can enter, and only servers without premium are eligible. '
      + 'Entering costs nothing and there is no catch.',
    )
    .addFields(
      { name: 'Closes', value: `<t:${closes}:R>`, inline: true },
      { name: 'Winners', value: String(row.winners), inline: true },
      {
        name: 'Better odds',
        value: 'Extra entries for a server that is actually set up: an approval channel, '
          + 'approver roles, a role position that can remove every bot, and Manage Roles so '
          + 'BotApprove can defend itself. Press the button to see what this server gets.',
      },
    )
    .setFooter({ text: 'Free forever with or without this. Premium is extras, not protection.' })
    .setTimestamp(new Date(row.closes_at));
}

async function reachFor(guild) {
  const cfg = guildConfig.get(guild.id);
  for (const id of [cfg?.announce_channel_id, cfg?.notify_channel_id, cfg?.log_channel_id]) {
    if (!id) continue;
    const channel = await guild.channels.fetch(id).catch(() => null);
    if (!channel?.isTextBased?.()) continue;
    const perms = channel.permissionsFor(guild.members.me);
    if (perms?.has(PermissionsBitField.Flags.SendMessages)
      && perms?.has(PermissionsBitField.Flags.ViewChannel)) return channel;
  }
  return null;
}

async function sendTo(guild, embed, components) {
  if (!eligible(guild.id)) return 'skipped';

  const channel = await reachFor(guild).catch(() => null);
  const ownerId = guild.ownerId;

  if (channel) {
    const ok = await channel.send({
      content: ownerId ? `<@${ownerId}>` : undefined,
      embeds: [embed],
      components,
      allowedMentions: ownerId ? { users: [ownerId] } : { parse: [] },
    }).then(() => true).catch(() => false);
    if (ok) return 'channel';
  }

  const owner = await guild.fetchOwner().catch(() => null);
  if (!owner) return 'failed';
  const sent = await owner.send({ embeds: [embed], components })
    .then(() => true).catch(() => false);
  return sent ? 'dm' : 'failed';
}

export async function inviteNewGuild(guild) {
  const open = giveaways.open();
  if (!open.length) return { sent: 0 };

  let sent = 0;
  for (const row of open) {
    if (giveawayEntries.has(row.id, guild.id)) continue;
    const how = await sendTo(guild, buildEmbed(row), [entryRow(row.id)]).catch(() => 'failed');
    if (how === 'channel' || how === 'dm') {
      sent += 1;
      log.info('open giveaway offered to a new guild', {
        giveawayId: row.id, guildId: guild.id, how,
      });
    }
    await sleep(GAP_MS);
  }
  return { sent };
}

export async function announce(giveawayId) {
  const row = giveaways.byId(giveawayId);
  if (!row) return { ok: false, reason: 'no_such_giveaway' };
  if (row.status !== 'draft') return { ok: false, reason: 'already_announced' };

  const client = getClient();
  if (!client) return { ok: false, reason: 'bot_offline' };

  const embed = buildEmbed(row);
  const components = [entryRow(giveawayId)];

  let inChannel = 0;
  let byDm = 0;
  let skipped = 0;
  let failed = 0;

  for (const [, guild] of client.guilds.cache) {
    const one = await sendTo(guild, embed, components);
    if (one === 'skipped') { skipped += 1; continue; }
    if (one === 'channel') inChannel += 1;
    else if (one === 'dm') byDm += 1;
    else failed += 1;
    await sleep(GAP_MS);
  }

  const reach = { inChannel, byDm, skipped, failed };
  giveaways.markAnnounced(giveawayId, reach);

  await record({
    action: 'giveaway_announced',
    severity: 'info',
    detail: { giveaway_id: giveawayId, ...reach },
    mirror: false,
  }).catch(() => {});

  log.info('giveaway announced', { giveawayId, ...reach });
  return { ok: true, ...reach };
}

export async function enter(giveawayId, guild, userId) {
  const row = giveaways.byId(giveawayId);
  if (!row) return { ok: false, reason: 'no_such_giveaway' };
  if (row.status !== 'open') return { ok: false, reason: 'not_open' };
  if (row.closes_at <= Date.now()) return { ok: false, reason: 'closed' };
  if (userId !== guild.ownerId) return { ok: false, reason: 'not_owner' };
  if (!eligible(guild.id)) return { ok: false, reason: 'already_premium' };

  const already = giveawayEntries.get(giveawayId, guild.id);
  const { weight, reasons, missing } = weighFor(guild);

  giveawayEntries.add({
    giveawayId,
    guildId: guild.id,
    guildName: guild.name,
    enteredBy: userId,
    weight,
    reasons,
  });

  return { ok: true, weight, reasons, missing, updated: !!already };
}

export function drawFrom(entries, winners) {
  const pool = entries.map((e) => ({ ...e }));
  const picked = [];

  while (picked.length < winners && pool.length) {
    const total = pool.reduce((n, e) => n + Math.max(1, e.weight), 0);
    let ticket = crypto.randomInt(total);
    let index = 0;
    for (let i = 0; i < pool.length; i += 1) {
      ticket -= Math.max(1, pool[i].weight);
      if (ticket < 0) { index = i; break; }
    }
    picked.push(pool[index]);
    pool.splice(index, 1);
  }

  return picked;
}

export async function draw(giveawayId) {
  const row = giveaways.byId(giveawayId);
  if (!row) return { ok: false, reason: 'no_such_giveaway' };
  if (row.status === 'drawn') return { ok: false, reason: 'already_drawn' };

  const entries = giveawayEntries.list(giveawayId)
    .filter((e) => eligible(e.guild_id));

  if (!entries.length) {
    giveaways.markDrawn(giveawayId);
    return { ok: true, winners: [], reason: 'no_entries' };
  }

  const picked = drawFrom(entries, Math.min(row.winners, entries.length));
  const client = getClient();

  for (const w of picked) {
    giveawayWinners.add({
      giveawayId, guildId: w.guild_id, guildName: w.guild_name,
    });

    const expiresAt = row.duration_days === null
      ? null
      : Date.now() + row.duration_days * 86_400_000;

    await grantEntitlement(w.guild_id, {
      tier: row.tier,
      expiresAt,
      note: `giveaway #${giveawayId}`,
      actorId: 'giveaway',
      source: 'manual',
    }).catch((err) => log.warn('grant failed', { guildId: w.guild_id, err: err.message }));
    giveawayWinners.markGranted(giveawayId, w.guild_id);

    const guild = client?.guilds.cache.get(w.guild_id);
    if (!guild) continue;

    const won = new EmbedBuilder()
      .setColor(0x3fb950)
      .setTitle(`This server won ${prizeLabel(row)}`)
      .setDescription(
        'It is already active, there is nothing to redeem.\n\n'
        + 'Premium features stay switched **off** until you turn them on, because they change '
        + 'how BotApprove behaves and that should be your call.',
      )
      .addFields({ name: 'Turn them on', value: `${config.web.baseUrl}/g/${guild.id}/protection` })
      .setTimestamp(new Date());

    const channel = await reachFor(guild).catch(() => null);
    const ownerId = guild.ownerId;
    let told = false;
    if (channel) {
      told = await channel.send({
        content: ownerId ? `<@${ownerId}>` : undefined,
        embeds: [won],
        allowedMentions: ownerId ? { users: [ownerId] } : { parse: [] },
      }).then(() => true).catch(() => false);
    }
    if (!told) {
      const owner = await guild.fetchOwner().catch(() => null);
      if (owner) told = await owner.send({ embeds: [won] }).then(() => true).catch(() => false);
    }
    if (told) giveawayWinners.markNotified(giveawayId, w.guild_id);
    await sleep(GAP_MS);
  }

  giveaways.markDrawn(giveawayId);

  await record({
    action: 'giveaway_drawn',
    severity: 'medium',
    detail: {
      giveaway_id: giveawayId,
      entries: entries.length,
      winners: picked.map((w) => w.guild_id),
    },
    mirror: false,
  }).catch(() => {});

  log.info('giveaway drawn', { giveawayId, entries: entries.length, winners: picked.length });
  return { ok: true, winners: picked, entries: entries.length };
}

export async function drawDue() {
  const due = giveaways.dueToDraw();
  for (const row of due) {
    await draw(row.id).catch((err) =>
      log.error('scheduled draw failed', { giveawayId: row.id, err: err.message }));
  }
  return due.length;
}

export { entryRow, buildEmbed };
