import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  PermissionsBitField,
  SlashCommandBuilder,
  EmbedBuilder,
} from 'discord.js';
import {
  whitelist,
  keywords,
  approverRoles,
  guildConfig,
  pendingApprovals,
  reinviteTokens,
  securityLog,
  nukeRegistry,
  knownNukeBots,
  nukeIncidents,
  nukeDbRequests,
  entitlements,
} from '../../db/queries.js';
import {
  confirmNukeBot,
  unconfirmNukeBot,
  addKnownNukeBot,
  removeKnownNukeBot,
  requestKnownNukeBot,
  reviewNukeRequest,
  resolveIncident,
  INVITER_ACTIONS,
} from '../../services/nukeDefense.js';
import { featureState, hasFeature, FEATURES } from '../../services/featureService.js';
import {
  removeFromWhitelist,
  addToWhitelist,
  revokeReinviteToken,
  record,
} from '../../services/securityService.js';
import { resolveApproval, BUTTON_PREFIX } from '../../services/approvalService.js';
import { setNickname } from '../../services/nicknameService.js';
import {
  redeemLicenseKey,
  generateLicenseKey,
  resolveEntitlement,
} from '../../services/entitlementService.js';
import { checkGuild } from '../../services/selfCheck.js';
import { checkChannel, describeChannelProblem } from '../../services/channelCheck.js';
import { config } from '../../config.js';
import { createLogger } from '../../logger.js';

const log = createLogger('commands');

const MANAGE = PermissionFlagsBits.ManageGuild;
const ephemeral = { flags: MessageFlags.Ephemeral };

export const commandDefinitions = [
  new SlashCommandBuilder()
    .setName('config')
    .setDescription('Configure BotApprove for this server')
    .setDefaultMemberPermissions(MANAGE)
    .setDMPermission(false)
    .addSubcommand((s) => s.setName('show').setDescription('Show the current configuration'))
    .addSubcommand((s) => s.setName('notify-channel')
      .setDescription('Where approval prompts are posted')
      .addChannelOption((o) => o.setName('channel').setDescription('Target channel')
        .addChannelTypes(ChannelType.GuildText).setRequired(true)))
    .addSubcommand((s) => s.setName('log-channel')
      .setDescription('Where the security audit trail is mirrored')
      .addChannelOption((o) => o.setName('channel').setDescription('Target channel')
        .addChannelTypes(ChannelType.GuildText).setRequired(true)))
    .addSubcommand((s) => s.setName('dm')
      .setDescription('Also DM approvers when a bot is held')
      .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true)))
    .addSubcommand((s) => s.setName('low-res')
      .setDescription('Width below which avatars/banners are flagged')
      .addIntegerOption((o) => o.setName('pixels').setDescription('Default 512')
        .setMinValue(16).setMaxValue(4096).setRequired(true)))
    .addSubcommand((s) => s.setName('nickname')
      .setDescription("Set BotApprove's own nickname here (leave empty to clear)")
      .addStringOption((o) => o.setName('name').setDescription('Up to 32 characters')
        .setMaxLength(32)))
    .addSubcommand((s) => s.setName('auto-ban')
      .setDescription('Ban whoever invites a confirmed nuke bot')
      .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true)))
    .addSubcommand((s) => s.setName('min-age')
      .setDescription('Flag bots whose application is newer than this many days')
      .addIntegerOption((o) => o.setName('days')
        .setDescription('0 disables the check').setMinValue(0).setMaxValue(3650).setRequired(true)))
    .addSubcommand((s) => s.setName('quorum')
      .setDescription('How many approvers must agree before a bot is let in')
      .addIntegerOption((o) => o.setName('approvers')
        .setDescription('1 disables it').setMinValue(1).setMaxValue(5).setRequired(true)))
    .addSubcommand((s) => s.setName('expiry')
      .setDescription('Days before an approval lapses and needs reconfirming')
      .addIntegerOption((o) => o.setName('days')
        .setDescription('0 means approvals never expire').setMinValue(0).setMaxValue(3650).setRequired(true)))
    .addSubcommand((s) => s.setName('impersonation')
      .setDescription('Flag bots whose name mimics one you already approved')
      .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true)))
    .addSubcommand((s) => s.setName('inviter-action')
      .setDescription('What happens to whoever invites a KNOWN nuke bot')
      .addStringOption((o) => o.setName('action').setDescription('Default: kick')
        .setRequired(true)
        .addChoices(
          { name: 'Kick them (default, reversible)', value: 'kick' },
          { name: 'Ban them', value: 'ban' },
          { name: 'Nothing, just tell me', value: 'none' },
        ))),

  new SlashCommandBuilder()
    .setName('nukedb')
    .setDescription('The shared known-nuke-bot database (instance owner only)')
    .setDefaultMemberPermissions(MANAGE)
    .setDMPermission(false)
    .addSubcommand((s) => s.setName('list').setDescription('List known nuke bots'))
    .addSubcommand((s) => s.setName('add')
      .setDescription('Add a bot id to the shared threat list')
      .addStringOption((o) => o.setName('bot-id').setDescription('The bot user id').setRequired(true))
      .addStringOption((o) => o.setName('reason').setDescription('What it does')))
    .addSubcommand((s) => s.setName('remove')
      .setDescription('Remove a bot id from the shared threat list')
      .addStringOption((o) => o.setName('bot-id').setDescription('The bot user id').setRequired(true)))
    .addSubcommand((s) => s.setName('requests').setDescription('Submissions awaiting your review'))
    .addSubcommand((s) => s.setName('approve')
      .setDescription('Approve a submission and list the bot')
      .addIntegerOption((o) => o.setName('id').setDescription('Request id').setRequired(true))
      .addStringOption((o) => o.setName('note').setDescription('Optional note')))
    .addSubcommand((s) => s.setName('reject')
      .setDescription('Reject a submission')
      .addIntegerOption((o) => o.setName('id').setDescription('Request id').setRequired(true))
      .addStringOption((o) => o.setName('note').setDescription('Optional note'))),

  new SlashCommandBuilder()
    .setName('nuke')
    .setDescription('Confirmed nuke bots')
    .setDefaultMemberPermissions(MANAGE)
    .setDMPermission(false)
    .addSubcommand((s) => s.setName('list').setDescription('List confirmed nuke bots'))
    .addSubcommand((s) => s.setName('confirm')
      .setDescription('Mark a bot id as a confirmed nuke bot')
      .addStringOption((o) => o.setName('bot-id').setDescription('The bot user id').setRequired(true))
      .addStringOption((o) => o.setName('reason').setDescription('What it did')))
    .addSubcommand((s) => s.setName('unconfirm')
      .setDescription('Withdraw a nuke bot confirmation')
      .addStringOption((o) => o.setName('bot-id').setDescription('The bot user id').setRequired(true)))
    .addSubcommand((s) => s.setName('request')
      .setDescription('Submit a bot to the shared threat list for operator review')
      .addStringOption((o) => o.setName('bot-id').setDescription('The bot user id').setRequired(true))
      .addStringOption((o) => o.setName('reason')
        .setDescription('What it did, and how you know').setRequired(true).setMinLength(10))),

  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Is this server protected? Licence, health and totals at a glance')
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName('features')
    .setDescription('What is active in this server, free and premium')
    .setDMPermission(false),

  // Deliberately no default member permissions. The operator is often only an
  // ordinary member of the servers holding a gifted licence, and a permission
  // gate would hide the command from them in exactly those servers. Access is
  // enforced in the handler against OWNER_IDS instead, which is the only check
  // that could restrict it to one person anyway.
  new SlashCommandBuilder()
    .setName('perpetual')
    .setDescription('BotApprove operator only: confirm this instance is live in this server')
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName('whitelist')
    .setDescription('Manage approved bots')
    .setDefaultMemberPermissions(MANAGE)
    .setDMPermission(false)
    .addSubcommand((s) => s.setName('list').setDescription('List whitelisted bots'))
    .addSubcommand((s) => s.setName('add')
      .setDescription('Whitelist a bot without a prompt (logged)')
      .addUserOption((o) => o.setName('bot').setDescription('The bot').setRequired(true)))
    .addSubcommand((s) => s.setName('remove')
      .setDescription('Revoke a bot approval')
      .addUserOption((o) => o.setName('bot').setDescription('The bot').setRequired(true))),

  new SlashCommandBuilder()
    .setName('keywords')
    .setDescription('High-risk name blocklist')
    .setDefaultMemberPermissions(MANAGE)
    .setDMPermission(false)
    .addSubcommand((s) => s.setName('list').setDescription('Show the blocklist'))
    .addSubcommand((s) => s.setName('add')
      .setDescription('Block a substring in bot names')
      .addStringOption((o) => o.setName('keyword').setDescription('e.g. security').setRequired(true)))
    .addSubcommand((s) => s.setName('remove')
      .setDescription('Unblock a substring')
      .addStringOption((o) => o.setName('keyword').setDescription('Existing keyword').setRequired(true))),

  new SlashCommandBuilder()
    .setName('approvers')
    .setDescription('Roles allowed to approve or deny bots')
    .setDefaultMemberPermissions(MANAGE)
    .setDMPermission(false)
    .addSubcommand((s) => s.setName('list').setDescription('List approver roles'))
    .addSubcommand((s) => s.setName('add')
      .setDescription('Add an approver role')
      .addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true)))
    .addSubcommand((s) => s.setName('remove')
      .setDescription('Remove an approver role')
      .addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true))),

  new SlashCommandBuilder()
    .setName('pending')
    .setDescription('Outstanding bot approvals')
    .setDefaultMemberPermissions(MANAGE)
    .setDMPermission(false)
    .addSubcommand((s) => s.setName('list').setDescription('Show pending approvals'))
    .addSubcommand((s) => s.setName('approve')
      .setDescription('Approve a pending request by id')
      .addIntegerOption((o) => o.setName('id').setDescription('Approval id').setRequired(true)))
    .addSubcommand((s) => s.setName('deny')
      .setDescription('Deny a pending request by id')
      .addIntegerOption((o) => o.setName('id').setDescription('Approval id').setRequired(true))),

  new SlashCommandBuilder()
    .setName('license')
    .setDescription('Activate or mint a licence')
    .setDefaultMemberPermissions(MANAGE)
    .setDMPermission(false)
    .addSubcommand((s) => s.setName('redeem')
      .setDescription('Activate a licence key')
      .addStringOption((o) => o.setName('key').setDescription('BA-XXXXX-...').setRequired(true)))
    .addSubcommand((s) => s.setName('generate')
      .setDescription('Mint a licence key (instance owner only)')
      .addIntegerOption((o) => o.setName('days').setDescription('Duration, omit for perpetual'))
      .addIntegerOption((o) => o.setName('guilds').setDescription('Seats, default 1'))
      .addStringOption((o) => o.setName('note').setDescription('Reference note'))),

  new SlashCommandBuilder()
    .setName('selfcheck')
    .setDescription("Verify BotApprove's own permissions and role position")
    .setDefaultMemberPermissions(MANAGE)
    .setDMPermission(false),
].map((c) => c.toJSON());

export function isApprover(member) {
  if (!member) return false;
  if (member.permissions?.has(PermissionsBitField.Flags.ManageGuild)) return true;
  const roleIds = approverRoles.list(member.guild.id);
  return roleIds.some((id) => member.roles.cache.has(id));
}

/**
 * Tell the server that someone from outside it just looked.
 *
 * Deliberately not routed through record()'s mirror, which is gated behind the
 * premium log channel. Whether a server hears about the operator inspecting it
 * should not depend on whether they are paying.
 */
async function announceOperatorCheck(guild, user, { what }) {
  const cfg = guildConfig.get(guild.id);
  const channelId = cfg.log_channel_id ?? cfg.notify_channel_id;
  if (!channelId) return { delivered: false, reason: 'no_channel' };

  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return { delivered: false, reason: 'unreachable' };

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('Operator check')
    .setDescription(
      `The operator of BotApprove ran a check on this server: **${what}**, confirming the bot ` +
      'is present here and reporting this server\'s licence state.\n\n' +
      'Nothing was changed. No messages, members or channels were read: BotApprove does not ' +
      'hold the Message Content intent. This notice is posted every time it happens.',
    )
    .addFields(
      { name: 'Ran by', value: `<@${user.id}>`, inline: true },
      { name: 'When', value: `<t:${Math.floor(Date.now() / 1000)}:f>`, inline: true },
    )
    .setTimestamp(new Date());

  const sent = await channel.send({ embeds: [embed] }).then(() => true).catch(() => false);
  return { delivered: sent, channelId };
}

const fail = (interaction, msg) =>
  interaction.reply({ content: `❌ ${msg}`, ...ephemeral });
const done = (interaction, msg) =>
  interaction.reply({ content: `✅ ${msg}`, ...ephemeral });

const FIELD_LIMIT = 1024;

export function listFields(name, lines) {
  const fields = [];
  let buf = [];

  for (const line of lines) {
    const one = line.length > FIELD_LIMIT ? `${line.slice(0, FIELD_LIMIT - 1)}…` : line;
    if (buf.length && [...buf, one].join('\n').length > FIELD_LIMIT) {
      fields.push(buf.join('\n'));
      buf = [];
    }
    buf.push(one);
  }
  if (buf.length) fields.push(buf.join('\n'));

  return fields.map((value, i) => ({ name: i ? `${name} (continued)` : name, value }));
}

function linkButtons(guildId, { includeBuy = false } = {}) {
  const base = config.web.baseUrl;
  if (!base.startsWith('https://')) return [];

  const dashboard = `${base}/g/${guildId}`;
  const buy = config.paywall.purchaseUrl || dashboard;

  const buttons = [];
  if (includeBuy) {
    buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Link)
    .setLabel('Buy premium').setURL(buy));
  }
  if (!includeBuy || buy !== dashboard) {
    buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Link)
      .setLabel('Open dashboard').setURL(dashboard));
  }
  return [new ActionRowBuilder().addComponents(...buttons)];
}

function premiumRequired(interaction, featureKey, extra) {
  const feature = FEATURES[featureKey];
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('✨ That one is premium')
    .setDescription(
      `**${feature.name}**, ${feature.blurb}\n\n` +
      'This server has no active BotApprove subscription.' + (extra ? `\n\n${extra}` : ''),
    )
    .addFields({
      name: 'Still running, free forever',
      value: 'The approval gate, your keyword blocklist, the audit trail and tamper ' +
        'detection.\n**Your server is still guarded.**',
    });

  return interaction.reply({
    embeds: [embed],
    components: linkButtons(interaction.guildId, { includeBuy: true }),
    ...ephemeral,
  });
}

export async function handleInteraction(interaction) {
  try {
    if (interaction.isButton()) return await handleButton(interaction);
    if (interaction.isChatInputCommand()) return await handleCommand(interaction);
  } catch (err) {
    log.error('interaction failed', {
      err: err.message,
      stack: err.stack,
      command: interaction.commandName,
      customId: interaction.customId,
    });
    const payload = { content: 'Something went wrong. It has been logged.', ...ephemeral };
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(payload).catch(() => {});
    } else {
      await interaction.reply(payload).catch(() => {});
    }
  }
}

async function handleButton(interaction) {
  const parts = interaction.customId.split(':');
  const [prefix] = parts;
  if (prefix !== BUTTON_PREFIX) return;

  if (parts[1] === 'inc') return handleIncidentButton(interaction, parts[2], Number(parts[3]));

  const [, action, rawId] = parts;

  if (!isApprover(interaction.member)) {
    return fail(interaction, 'You are not an approver in this server.');
  }

  const pendingId = Number(rawId);
  const row = pendingApprovals.byId(pendingId);
  if (!row) return fail(interaction, `Approval #${rawId} no longer exists.`);
  if (row.guild_id !== interaction.guildId) {
    return fail(interaction, 'That approval belongs to another server.');
  }

  await interaction.deferUpdate();

  const decision = { approve: 'approve', nuke: 'nuke' }[action] ?? 'deny';
  const result = await resolveApproval({
    pendingId,
    decision,
    actorId: interaction.user.id,
    via: 'button',
  });

  if (!result.ok && result.reason === 'awaiting_quorum') {
    return interaction.followUp({
      embeds: [new EmbedBuilder()
        .setColor(0xd29922)
        .setTitle('Vote recorded')
        .setDescription(
          `<@${interaction.user.id}> approved \`${row.bot_tag ?? row.bot_id}\`.

` +
          `**${result.votes} of ${result.needed}** approvers agree. This server requires ` +
          `${result.needed} before a bot is let in, so it stays held until someone else ` +
          'approves. Any single approver can still deny it outright.',
        )
        .setFooter({ text: `Voted so far: ${result.voters.length}` })],
    });
  }

  if (!result.ok) {
    return interaction.followUp({
      content: result.reason === 'already_resolved'
        ? `Already ${result.existing.status} by <@${result.existing.resolved_by}>.`
        : 'That approval could not be found.',
      ...ephemeral,
    });
  }

  const decided = result.status === 'approved';
  const nuked = decision === 'nuke';
  const note = new EmbedBuilder()
    .setColor(decided ? 0x57f287 : (nuked ? 0x992d22 : 0xed4245))
    .setTitle(decided ? '✅ Approved' : (nuked ? 'Denied, confirmed nuke bot' : 'Denied'))
    .setDescription(
      `<@${interaction.user.id}> ${decided ? 'approved' : 'denied'} \`${row.bot_tag ?? row.bot_id}\`.` +
      (result.reinviteExpiresAt
      ? `\n\n **Single-use re-invite token issued**, expires <t:${Math.floor(result.reinviteExpiresAt / 1000)}:R>.\n` +
          'Re-invite the bot manually within the window, it is **not** re-added automatically, ' +
          'and the token works for this bot id only, once.'
        : decided ? '\n\nRe-invite the bot manually; it is not re-added automatically.' : ''),
    )
    .setTimestamp(new Date());

  if (nuked) {
    note.addFields({
      name: 'Nuke bot registry',
      value: 'This bot id is now kicked on sight in this server, no token or whitelist entry ' +
        'can bring it back.',
    });
    note.addFields({
      name: 'Inviter',
      value: result.nuke?.banned
      ? `<@${row.added_by}> has been **banned**.`
        : `Not banned, \`${result.nuke?.reason ?? 'unknown'}\`.` +
          (result.nuke?.reason === 'not_enabled'
            ? ' Turn on `/config auto-ban` to ban inviters automatically.'
            : ''),
    });
  }

  await interaction.message.edit({ components: [] }).catch(() => {});
  return interaction.followUp({ embeds: [note] });
}

async function handleIncidentButton(interaction, choice, incidentId) {
  const incident = nukeIncidents.byId(incidentId);
  if (!incident) return fail(interaction, `Incident #${incidentId} no longer exists.`);

  const guild = await interaction.client.guilds.fetch(incident.guild_id).catch(() => null);
  if (!guild) return fail(interaction, 'That server is no longer reachable.');

  if (interaction.user.id !== guild.ownerId) {
    return fail(interaction, 'Only the server owner can decide this.');
  }
  if (incident.resolution !== 'pending') {
    return fail(interaction, `Already resolved as \`${incident.resolution}\`.`);
  }

  await interaction.deferUpdate();

  const result = await resolveIncident({
    incidentId, choice, actorId: interaction.user.id, guild,
  });

  if (!result.ok) {
    return interaction.followUp({
      content: `Could not ${choice}, \`${result.reason}\`. The buttons are still live.`,
      ...ephemeral,
    });
  }

  const said = {
    ban: `<@${incident.inviter_id}> has been banned.`,
    kick: `<@${incident.inviter_id}> has been kicked.`,
    unban: `<@${incident.inviter_id}> has been unbanned.`,
    dismiss: 'No further action taken. The bot remains blocked either way.',
  }[choice];

  await interaction.message.edit({ components: [] }).catch(() => {});
  return interaction.followUp({
    embeds: [new EmbedBuilder()
      .setColor(choice === 'dismiss' || choice === 'unban' ? 0x57f287 : 0x992d22)
      .setTitle(`Incident #${incidentId} resolved`)
      .setDescription(said)
      .setTimestamp(new Date())],
  });
}

async function handleCommand(interaction) {
  if (!interaction.inGuild()) return fail(interaction, 'Use this in a server.');
  const guildId = interaction.guildId;
  const sub = interaction.options.getSubcommand(false);

  switch (interaction.commandName) {
    case 'config': {
      if (sub === 'show') {
        const cfg = guildConfig.get(guildId);
        const ent = resolveEntitlement(guildId);
        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle('BotApprove configuration')
          .addFields(
            { name: 'Notify channel', value: cfg.notify_channel_id ? `<#${cfg.notify_channel_id}>` : 'not set', inline: true },
            { name: 'Log channel', value: cfg.log_channel_id ? `<#${cfg.log_channel_id}>` : 'not set', inline: true },
            { name: 'DM approvers', value: cfg.notify_via_dm ? 'yes' : 'no', inline: true },
            { name: 'Low-res threshold', value: `${cfg.low_res_threshold_px}px`, inline: true },
            { name: 'Nickname', value: cfg.nickname ?? '(default)', inline: true },
            { name: 'Licence', value: `${ent.tier} / ${ent.state}`, inline: true },
            {
              name: 'Auto-ban nuke inviters',
              value: cfg.auto_ban_nuke_inviters
                ? (hasFeature(guildId, 'auto_ban_inviters') ? 'on' : 'on (premium inactive)')
                : 'off',
              inline: true,
            },
            { name: 'Confirmed nuke bots', value: String(nukeRegistry.count(guildId)), inline: true },
            {
              name: 'Min account age',
              value: cfg.min_account_age_days ? `${cfg.min_account_age_days} days` : 'not checked',
              inline: true,
            },
            {
              name: 'Approvers needed',
              value: cfg.quorum_required > 1 ? String(cfg.quorum_required) : '1',
              inline: true,
            },
            {
              name: 'Approval expiry',
              value: cfg.whitelist_expiry_days ? `${cfg.whitelist_expiry_days} days` : 'never',
              inline: true,
            },
            {
              name: 'Known-nuke-bot inviter action',
              value: hasFeature(guildId, 'known_nuke_db')
                ? (cfg.nuke_inviter_action ?? 'kick')
                : `${cfg.nuke_inviter_action ?? 'kick'} (premium inactive)`,
              inline: true,
            },
            { name: 'Approver roles', value: approverRoles.list(guildId).map((r) => `<@&${r}>`).join(' ') || 'none, only Manage Server can approve' },
            { name: 'Keywords', value: keywords.list(guildId).map((k) => `\`${k}\``).join(', ') || 'none' },
          );
        return interaction.reply({ embeds: [embed], ...ephemeral });
      }
      if (sub === 'notify-channel' || sub === 'log-channel') {
        const ch = interaction.options.getChannel('channel');
        const key = sub === 'notify-channel' ? 'notify_channel_id' : 'log_channel_id';

        const health = await checkChannel(interaction.guild, ch.id);
        if (!health.ok) {
          return fail(interaction, `${describeChannelProblem(health, ch.id)}
` +
            'Fix the channel permissions and run this again. Nothing was saved.');
        }

        guildConfig.set(guildId, { [key]: ch.id });
        return done(interaction, sub === 'notify-channel'
          ? `Approval prompts will go to <#${ch.id}>. Verified BotApprove can post there.`
          : `Audit trail will be mirrored to <#${ch.id}>. Verified BotApprove can post there.`);
      }
      if (sub === 'dm') {
        const enabled = interaction.options.getBoolean('enabled');
        guildConfig.set(guildId, { notify_via_dm: enabled ? 1 : 0 });
        return done(interaction, `DM notifications ${enabled ? 'enabled' : 'disabled'}.`);
      }
      if (sub === 'low-res') {
        const px = interaction.options.getInteger('pixels');
        guildConfig.set(guildId, { low_res_threshold_px: px });
        return done(interaction, `Images narrower than ${px}px will be flagged.`);
      }
      if (sub === 'auto-ban') {
        const enabled = interaction.options.getBoolean('enabled');
        guildConfig.set(guildId, { auto_ban_nuke_inviters: enabled ? 1 : 0 });
        await record({
          guildId, actorId: interaction.user.id, action: 'auto_ban_toggled',
          severity: 'high', detail: { enabled },
        });
        if (enabled && !hasFeature(guildId, 'auto_ban_inviters')) {
          return premiumRequired(interaction, 'auto_ban_inviters',
            'Your choice has been saved and takes effect as soon as premium is active.');
        }
        return done(interaction, enabled
          ? 'Anyone who invites a **confirmed** nuke bot will be banned. Only bot ids you have ' +
            'explicitly confirmed count, the server owner is never banned.'
          : 'Auto-ban disabled. Nuke bots are still kicked on sight.');
      }
      if (sub === 'min-age') {
        const days = interaction.options.getInteger('days');
        if (days > 0 && !hasFeature(guildId, 'account_age_floor')) {
          return premiumRequired(interaction, 'account_age_floor');
        }
        guildConfig.set(guildId, { min_account_age_days: days });
        return done(interaction, days === 0
          ? 'Account age is no longer checked.'
          : `Bots with applications newer than ${days} day(s) will be flagged on the approval ` +
            'card. They are still reviewed by a human, not auto-denied.');
      }
      if (sub === 'quorum') {
        const n = interaction.options.getInteger('approvers');
        if (n > 1 && !hasFeature(guildId, 'approval_quorum')) {
          return premiumRequired(interaction, 'approval_quorum');
        }
        guildConfig.set(guildId, { quorum_required: n <= 1 ? 0 : n });
        return done(interaction, n <= 1
          ? 'One approver is enough again.'
          : `${n} different approvers must now agree before a bot is let in. Denying still ` +
            'takes one person, because refusing is the safe direction.');
      }
      if (sub === 'expiry') {
        const days = interaction.options.getInteger('days');
        if (days > 0 && !hasFeature(guildId, 'whitelist_expiry')) {
          return premiumRequired(interaction, 'whitelist_expiry');
        }
        guildConfig.set(guildId, { whitelist_expiry_days: days });
        return done(interaction, days === 0
          ? 'Approvals no longer expire.'
          : `Approvals now lapse after ${days} day(s). A lapsed bot is held for reconfirmation ` +
            'on its next join rather than being removed from the whitelist.');
      }
      if (sub === 'impersonation') {
        const enabled = interaction.options.getBoolean('enabled');
        if (enabled && !hasFeature(guildId, 'impersonation_check')) {
          return premiumRequired(interaction, 'impersonation_check');
        }
        guildConfig.set(guildId, { impersonation_check: enabled ? 1 : 0 });
        return done(interaction, enabled
          ? 'A joining bot whose name mimics one you already approved will be flagged.'
          : 'Impersonation checking disabled.');
      }
      if (sub === 'inviter-action') {
        const action = interaction.options.getString('action');
        if (!INVITER_ACTIONS.includes(action)) return fail(interaction, 'Unknown action.');
        guildConfig.set(guildId, { nuke_inviter_action: action });
        await record({
          guildId, actorId: interaction.user.id, action: 'inviter_action_set',
          severity: 'high', detail: { action },
        });
        if (!hasFeature(guildId, 'known_nuke_db')) {
          return premiumRequired(interaction, 'known_nuke_db',
            'Your choice has been saved and takes effect as soon as premium is active.');
        }
        return done(interaction, {
          kick: 'Anyone who invites a **known** nuke bot will be kicked. You get a DM and can ' +
            'escalate to a ban from there.',
          ban: 'Anyone who invites a **known** nuke bot will be banned. You get a DM and can ' +
            'undo it from there.',
          none: 'Nobody is actioned automatically. You still get a DM naming whoever did it.',
        }[action]);
      }
      if (sub === 'nickname') {
        const name = interaction.options.getString('name');
        const result = await setNickname(interaction.guild, name, interaction.user.id);
        if (result.reason === 'premium_required') {
          return premiumRequired(interaction, 'custom_nickname');
        }
        if (!result.ok) return fail(interaction, result.reason);
        if (result.value === null) return done(interaction, 'Nickname cleared.');
        return done(interaction, result.applied?.ok
          ? `Nickname set to **${result.value}**.`
          : `Saved **${result.value}**, but it could not be applied (${result.applied.reason}). ` +
            'Grant the Change Nickname permission.');
      }
      break;
    }

    case 'whitelist': {
      if (sub === 'list') {
        const rows = whitelist.list(guildId);
        if (!rows.length) return interaction.reply({ content: 'No bots are whitelisted.', ...ephemeral });
        const body = rows.slice(0, 25).map((r) =>
          `• <@${r.bot_id}> \`${r.bot_id}\`, by <@${r.approved_by}> <t:${Math.floor(r.approved_at / 1000)}:R>`).join('\n');
        return interaction.reply({
          embeds: [new EmbedBuilder().setColor(0x57f287)
            .setTitle(`Whitelisted bots (${rows.length})`).setDescription(body)],
          ...ephemeral,
        });
      }
      if (sub === 'add') {
        const user = interaction.options.getUser('bot');
        if (!user.bot) return fail(interaction, 'That user is not a bot.');
        await addToWhitelist(guildId, user.id, interaction.user.id, { via: 'command', manual: true });
        return done(interaction, `<@${user.id}> is whitelisted. It is **not** invited automatically.`);
      }
      if (sub === 'remove') {
        const user = interaction.options.getUser('bot');
        const removed = await removeFromWhitelist(guildId, user.id, interaction.user.id, { via: 'command' });
        await revokeReinviteToken(guildId, user.id, interaction.user.id);
        return removed
          ? done(interaction, `<@${user.id}> is no longer whitelisted. It will be kicked if it rejoins.`)
          : fail(interaction, 'That bot was not whitelisted.');
      }
      break;
    }

    case 'keywords': {
      if (sub === 'list') {
        const list = keywords.list(guildId);
        return interaction.reply({
          content: list.length
            ? `Blocked substrings: ${list.map((k) => `\`${k}\``).join(', ')}`
            : 'The blocklist is empty, no names are treated as high-risk.',
          ...ephemeral,
        });
      }
      if (sub === 'add') {
        const kw = interaction.options.getString('keyword').trim().toLowerCase();
        if (kw.length < 2) return fail(interaction, 'Keywords must be at least 2 characters.');
        if (!hasFeature(guildId, 'custom_keywords')) {
          return premiumRequired(interaction, 'custom_keywords',
            'Everything already on your blocklist keeps being enforced.');
        }
        keywords.add(guildId, kw, interaction.user.id);
        await record({ guildId, actorId: interaction.user.id, action: 'keyword_add', detail: { keyword: kw } });
        return done(interaction, `Bots whose name contains \`${kw}\`will be hard-blocked.`);
      }
      if (sub === 'remove') {
        const kw = interaction.options.getString('keyword').trim().toLowerCase();
        const info = keywords.remove(guildId, kw);
        if (!info.changes) return fail(interaction, `\`${kw}\`was not in the blocklist.`);
        await record({
          guildId, actorId: interaction.user.id, action: 'keyword_remove',
          severity: 'medium', detail: { keyword: kw },
        });
        return done(interaction, `\`${kw}\`removed from the blocklist.`);
      }
      break;
    }

    case 'approvers': {
      if (sub === 'list') {
        const roles = approverRoles.list(guildId);
        return interaction.reply({
          content: roles.length
            ? `Approver roles: ${roles.map((r) => `<@&${r}>`).join(' ')}`
            : 'No approver roles set, only members with Manage Server can approve.',
          ...ephemeral,
        });
      }
      const role = interaction.options.getRole('role');
      if (sub === 'add') {
        approverRoles.add(guildId, role.id);
        await record({ guildId, actorId: interaction.user.id, action: 'approver_role_add', detail: { role: role.id } });
        return done(interaction, `<@&${role.id}> can now approve bots.`);
      }
      if (sub === 'remove') {
        approverRoles.remove(guildId, role.id);
        await record({
          guildId, actorId: interaction.user.id, action: 'approver_role_remove',
          severity: 'medium', detail: { role: role.id },
        });
        return done(interaction, `<@&${role.id}> can no longer approve bots.`);
      }
      break;
    }

    case 'pending': {
      if (sub === 'list') {
        const rows = pendingApprovals.listPending(guildId);
        if (!rows.length) return interaction.reply({ content: 'Nothing pending.', ...ephemeral });
        const body = rows.slice(0, 20).map((r) =>
          `**#${r.id}** \`${r.bot_tag ?? r.bot_id}\`` +
          (r.keyword_matched ? `keyword \`${r.keyword_matched}\`` : '') +
          `, <t:${Math.floor(r.created_at / 1000)}:R>`).join('\n');
        return interaction.reply({
          embeds: [new EmbedBuilder().setColor(0xfee75c)
            .setTitle(`Pending approvals (${rows.length})`).setDescription(body)],
          ...ephemeral,
        });
      }
      if (!isApprover(interaction.member)) return fail(interaction, 'You are not an approver.');
      const id = interaction.options.getInteger('id');
      const row = pendingApprovals.byId(id);
      if (!row || row.guild_id !== guildId) return fail(interaction, `No approval #${id} in this server.`);

      const result = await resolveApproval({
        pendingId: id,
        decision: sub === 'approve' ? 'approve' : 'deny',
        actorId: interaction.user.id,
        via: 'command',
      });
      if (!result.ok && result.reason === 'awaiting_quorum') {
        return done(interaction, `Vote recorded. ${result.votes} of ${result.needed} approvers ` +
          'agree; it stays held until one more approves.');
      }
      if (!result.ok) {
        return fail(interaction, result.reason === 'already_resolved'
          ? `Already ${result.existing.status}.` : 'Not found.');
      }
      return done(interaction, `#${id} ${result.status}.` + (result.reinviteExpiresAt
        ? `Single-use re-invite token expires <t:${Math.floor(result.reinviteExpiresAt / 1000)}:R>.`
        : ''));
    }

    case 'license': {
      if (sub === 'redeem') {
        const key = interaction.options.getString('key');
        const result = await redeemLicenseKey(guildId, key, interaction.user.id);
        if (!result.ok) return fail(interaction, `Key rejected: \`${result.reason}\`.`);
        return done(interaction, `Licence active: **${result.tier}**` +
          (result.expiresAt ? `, until <t:${Math.floor(result.expiresAt / 1000)}:D>.` : ' (perpetual).'));
      }
      if (sub === 'generate') {
        if (!config.ownerIds.includes(interaction.user.id)) {
          return fail(interaction, 'Only the instance owner can mint licence keys.');
        }
        const days = interaction.options.getInteger('days');
        const guilds = interaction.options.getInteger('guilds') ?? 1;
        const note = interaction.options.getString('note');
        const key = generateLicenseKey({
          durationDays: days ?? null, maxGuilds: guilds, note, createdBy: interaction.user.id,
        });
        return interaction.reply({
          content: `\`${key}\`\n${guilds} seat(s), ${days ? `${days} days` : 'perpetual'}.\n` +
            '**Copy it now**, only its hash is stored, so it cannot be shown again.',
          ...ephemeral,
        });
      }
      break;
    }

    case 'selfcheck': {
      const result = await checkGuild(interaction.guild, { reason: 'manual' });
      const recent = securityLog.recent(guildId, 5);
      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(result.ok ? 0x57f287 : 0xed4245)
          .setTitle(result.ok ? '✅ BotApprove is correctly positioned' : 'Problems found')
          .setDescription(result.ok
            ? `Role position ${result.position}; Kick Members and View Audit Log present.`
            : (result.problems ?? [result.reason]).map((p) => `• ${p}`).join('\n'))
          .setFooter({ text: `${recent.length} recent security events logged` })],
        ...ephemeral,
      });
    }

    case 'nuke': {
      if (sub === 'list') {
        const rows = nukeRegistry.list(guildId);
        if (!rows.length) {
          return interaction.reply({ content: 'No confirmed nuke bots.', ...ephemeral });
        }
        return interaction.reply({
          embeds: [new EmbedBuilder().setColor(0x992d22)
            .setTitle(`☢️ Confirmed nuke bots (${rows.length})`)
            .setDescription(rows.slice(0, 25).map((r) =>
              `• \`${r.bot_id}\`${r.bot_tag ? `(${r.bot_tag})` : ''}, by <@${r.confirmed_by}> ` +
              `<t:${Math.floor(r.confirmed_at / 1000)}:R>` +
              (r.reason ? `\n  _${r.reason}_` : '')).join('\n'))
            .setFooter({ text: 'Kicked on sight. No token or whitelist entry can override this.' })],
          ...ephemeral,
        });
      }

      if (!isApprover(interaction.member)) return fail(interaction, 'You are not an approver.');
      const botId = interaction.options.getString('bot-id').trim();
      if (!/^\d{15,25}$/.test(botId)) return fail(interaction, 'That is not a valid user id.');

      if (sub === 'confirm') {
        const target = await interaction.client.users.fetch(botId).catch(() => null);
        if (target && !target.bot) return fail(interaction, 'That id belongs to a user, not a bot.');
        await confirmNukeBot(guildId, botId, {
          botTag: target?.tag,
          confirmedBy: interaction.user.id,
          reason: interaction.options.getString('reason') ?? undefined,
        });
        return done(interaction, `\`${botId}\`is a confirmed nuke bot. It will be kicked on ` +
          'sight' + (guildConfig.get(guildId).auto_ban_nuke_inviters
            ? ', and whoever invites it will be banned.'
            : '. Turn on `/config auto-ban` to ban future inviters.'));
      }
      if (sub === 'request') {
        const result = await requestKnownNukeBot({
          botId,
          botTag: (await interaction.client.users.fetch(botId).catch(() => null))?.tag,
          reason: interaction.options.getString('reason'),
          requestedBy: interaction.user.id,
          requestedByTag: interaction.user.tag,
          guild: interaction.guild,
        });
        if (!result.ok) {
          return fail(interaction, {
            already_listed: 'That bot is already on the shared threat list.',
            already_requested: 'You already have a pending submission for that bot.',
            reason_too_short: 'Give at least a sentence explaining what it did.',
          }[result.reason] ?? `Could not submit: ${result.reason}`);
        }
        return done(interaction, `Submitted as request #${result.id}. It reaches the shared ` +
          'list only if the operator approves it. Your own server is unaffected either way, ' +
          'so use `/nuke confirm` if you want it blocked here now.');
      }
      if (sub === 'unconfirm') {
        const removed = await unconfirmNukeBot(guildId, botId, interaction.user.id);
        return removed
          ? done(interaction, `\`${botId}\`is no longer a confirmed nuke bot.`)
          : fail(interaction, 'That bot was not on the list.');
      }
      break;
    }

    case 'nukedb': {
      if (!config.ownerIds.includes(interaction.user.id)) {
        return fail(interaction, 'The shared threat list is maintained by the instance owner.');
      }
      if (sub === 'list') {
        const rows = knownNukeBots.all();
        if (!rows.length) return interaction.reply({ content: 'The list is empty.', ...ephemeral });
        return interaction.reply({
          embeds: [new EmbedBuilder().setColor(0x992d22)
            .setTitle(`☢️ Known nuke bots (${rows.length})`)
            .setDescription(rows.slice(0, 25).map((r) =>
              `• \`${r.bot_id}\`${r.bot_tag ? ` (${r.bot_tag})` : ''}` +
              (r.reason ? `, ${r.reason}` : '')).join('\n'))
            .setFooter({ text: 'Applies to every server on this instance with an active licence.' })],
          ...ephemeral,
        });
      }

      if (sub === 'requests') {
        const rows = nukeDbRequests.listPending();
        if (!rows.length) return interaction.reply({ content: 'No submissions pending.', ...ephemeral });
        return interaction.reply({
          embeds: [new EmbedBuilder().setColor(0xd29922)
            .setTitle(`Threat list submissions (${rows.length})`)
            .setDescription(rows.slice(0, 10).map((r) => [
              `**#${r.id}** \`${r.bot_id}\`${r.bot_tag ? ` (${r.bot_tag})` : ''}`,
              `from ${r.guild_name ?? r.guild_id} by <@${r.requested_by}>`,
              `> ${String(r.reason).slice(0, 180)}`,
            ].join('\n')).join('\n\n'))
            .setFooter({ text: 'Approve with /nukedb approve id:<n>' })],
          ...ephemeral,
        });
      }
      if (sub === 'approve' || sub === 'reject') {
        const result = await reviewNukeRequest({
          id: interaction.options.getInteger('id'),
          decision: sub === 'approve' ? 'approve' : 'reject',
          reviewerId: interaction.user.id,
          note: interaction.options.getString('note') ?? undefined,
        });
        if (!result.ok) {
          return fail(interaction, result.reason === 'already_reviewed'
            ? `That request was already ${result.existing.status}.`
            : 'No such request.');
        }
        return done(interaction, sub === 'approve'
          ? `Request #${result.row.id} approved. \`${result.row.bot_id}\` is now banned on ` +
            'sight in every licensed server.'
          : `Request #${result.row.id} rejected. Nothing was listed.`);
      }

      const botId = interaction.options.getString('bot-id').trim();
      if (!/^\d{15,25}$/.test(botId)) return fail(interaction, 'That is not a valid user id.');

      if (sub === 'add') {
        const target = await interaction.client.users.fetch(botId).catch(() => null);
        if (target && !target.bot) return fail(interaction, 'That id belongs to a user, not a bot.');
        await addKnownNukeBot({
          botId,
          botTag: target?.tag,
          reason: interaction.options.getString('reason') ?? undefined,
          addedBy: interaction.user.id,
        });
        return done(interaction, `\`${botId}\`added to the shared threat list. It will be ` +
          'banned on sight in every licensed server.');
      }
      if (sub === 'remove') {
        const removed = await removeKnownNukeBot(botId, interaction.user.id);
        return removed
          ? done(interaction, `\`${botId}\`removed from the shared threat list.`)
          : fail(interaction, 'That bot was not on the list.');
      }
      break;
    }

    case 'status': {
      const ent = resolveEntitlement(guildId);
      const cfg = guildConfig.get(guildId);
      const self = await checkGuild(interaction.guild, { reason: 'status' })
        .catch((err) => ({ ok: false, problems: [err.message] }));
      const pendingCount = pendingApprovals.listPending(guildId).length;
      const premium = !config.paywall.enabled || ent.licensed;

      const embed = new EmbedBuilder()
        .setColor(self.ok ? (premium ? 0x57f287 : 0x5865f2) : 0xed4245)
        .setTitle(self.ok ? '🛡️ This server is protected' : 'Protection is impaired')
        .setDescription(self.ok
          ? 'Every bot that joins is removed and held for a human decision, including ones ' +
            'invited by the owner.'
          : (self.problems ?? ['Unknown problem']).map((p) => `• ${p}`).join('\n'))
        .addFields(
          {
            name: 'Plan',
            value: !config.paywall.enabled
              ? '**Unmetered**, all features on'
              : (ent.licensed
              ? `**Premium** (${ent.tier})` +
                  (ent.expiresAt ? `\nrenews <t:${Math.floor(ent.expiresAt / 1000)}:R>` : '')
                : '**Free**, core guard active'),
            inline: true,
          },
          { name: 'Pending approvals', value: String(pendingCount), inline: true },
          { name: 'Approved bots', value: String(whitelist.list(guildId).length), inline: true },
          { name: 'Keywords blocked', value: String(keywords.list(guildId).length), inline: true },
          { name: 'Confirmed nuke bots', value: String(nukeRegistry.count(guildId)), inline: true },
          { name: 'Live re-invite tokens', value: String(reinviteTokens.listLive(guildId).length), inline: true },
        )
        .setFooter({ text: config.botStatus })
        .setTimestamp(new Date());

      if (!cfg.notify_channel_id) {
        embed.addFields({
          name: 'No approval channel set',
          value: 'Bots are still kicked, but nobody is being notified. Run ' +
            '`/config notify-channel`.',
        });
      }
      if (config.paywall.enabled && !ent.licensed) {
        embed.addFields(...listFields(
          'Premium adds',
          featureState(guildId).filter((f) => f.tier === 'premium').map((f) => `• ${f.name}`),
        ));
      }

      return interaction.reply({
        embeds: [embed],
        components: linkButtons(guildId, { includeBuy: config.paywall.enabled && !ent.licensed }),
        ...ephemeral,
      });
    }

    case 'features': {
      const states = featureState(guildId);
      const line = (f) => `${f.enabled ? 'on ' : 'off'} **${f.name}** ${f.blurb}`;
      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle('BotApprove features')
          .addFields(
            ...listFields('Free forever', states.filter((f) => f.tier === 'free').map(line)),
            ...listFields(
              config.paywall.enabled ? 'Premium' : 'Premium (paywall off, all active)',
              states.filter((f) => f.tier === 'premium').map(line),
            ),
          )
          .setFooter({ text: 'Basic guarding never switches off, paid or not.' })],
        components: linkButtons(guildId, {
          includeBuy: config.paywall.enabled && !resolveEntitlement(guildId).licensed,
        }),
        ...ephemeral,
      });
    }

    /**
     * Proof of life from inside Discord.
     *
     * The dashboard reads a cached guild list and the REST API is a different
     * path again, so both can look healthy while the bot is deaf on the
     * gateway. A reply to this can only happen if the interaction arrived and
     * was answered, which is the thing actually worth confirming.
     */
    case 'perpetual': {
      if (!config.ownerIds.includes(interaction.user.id)) {
        return fail(interaction, 'This check is for the BotApprove operator.');
      }

      const row = entitlements.get(guildId);
      const ent = resolveEntitlement(guildId);
      const perpetual = !!row?.perpetual;
      const gifted = perpetual && row?.source === 'license_key';

      const headline = gifted
        ? 'I am on a perpetual gifted licence.'
        : perpetual
          ? 'I am on a purchased lifetime licence.'
          : `I am not on a perpetual licence here. This server is ${ent.tier} / ${ent.state}.`;

      const notice = await announceOperatorCheck(interaction.guild, interaction.user, {
        what: 'Entitlement check',
      }).catch(() => ({ delivered: false, reason: 'error' }));

      await record({
        guildId,
        actorId: interaction.user.id,
        action: 'operator_check',
        severity: 'info',
        detail: {
          kind: 'perpetual',
          perpetual,
          gifted,
          announced: notice.delivered,
          announce_reason: notice.reason,
        },
        // Announced directly above, ungated, so mirroring here would duplicate it.
        mirror: false,
      }).catch(() => {});

      const client = interaction.client;
      const uptime = Math.floor(client.uptime / 1000);
      const hours = Math.floor(uptime / 3600);
      const minutes = Math.floor((uptime % 3600) / 60);

      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(perpetual ? 0x57f287 : 0x5865f2)
          .setTitle(headline)
          .setDescription(
            `Answered live in **${interaction.guild.name}**, so the gateway is connected and ` +
            'this instance is serving this server.',
          )
          .addFields(
            { name: 'Server', value: `${interaction.guild.name}\n\`${guildId}\``, inline: true },
            {
              name: 'Licence',
              value: row
                ? `${row.tier} / ${row.status}\nvia ${row.source ?? 'unknown'}` +
                  `${row.expires_at ? `\nuntil <t:${Math.floor(row.expires_at / 1000)}:D>` : '\nno expiry'}`
                : 'no entitlement row',
              inline: true,
            },
            {
              name: 'This instance',
              value: `up ${hours}h ${minutes}m\n${client.guilds.cache.size} servers\n` +
                `${client.ws.ping}ms to Discord`,
              inline: true,
            },
            {
              name: 'Disclosed to this server',
              value: notice.delivered
                ? `Posted in <#${notice.channelId}>.`
                : (notice.reason === 'no_channel'
                  ? 'No log or approval channel is set here, so there was nowhere to post it.'
                  : 'Could not post the notice; the channel is unreachable.'),
            },
          )
          .setFooter({ text: 'Operator check' })
          .setTimestamp(new Date())],
        ...ephemeral,
      });
    }

    default:
      return fail(interaction, 'Unknown command.');
  }

  return fail(interaction, 'Unknown subcommand.');
}
