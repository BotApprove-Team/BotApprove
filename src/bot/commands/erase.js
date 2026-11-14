/**
 * /erase me, and /uninstall for a server.
 *
 * Both ask first, with a button, and both answer with what changed and what
 * is left afterwards, counted again rather than assumed. The button carries
 * the target in its id, so it still works after a restart, and who may press
 * it is checked again on the press, not only when the command was run.
 */
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags,
} from 'discord.js';
import * as erasure from '../../services/erasureService.js';
import { createLogger } from '../../logger.js';

const log = createLogger('erase');
const ephemeral = { flags: MessageFlags.Ephemeral };

export const ERASE_BUTTON = 'erase';

const BACKUPS = 'Nightly backups still hold the old copy for up to 14 days, then it is gone '
  + 'from those too.';
const RAIDPROTECTOR = 'RaidProtector keeps its own records separately. Run /erase there as well '
  + 'if you use it.';

const sum = (rows) => Object.values(rows).reduce((a, b) => a + b, 0);

function breakdown(rows, limit = 8) {
  const lines = Object.entries(rows)
    .filter(([, n]) => n)
    .sort((a, b) => b[1] - a[1])
    .map(([where, n]) => `• ${where}: ${n}`);
  if (lines.length > limit) {
    const rest = lines.length - limit;
    return [...lines.slice(0, limit), `• and ${rest} more place${rest === 1 ? '' : 's'}`].join('\n');
  }
  return lines.join('\n');
}

function confirmRow(kind, id) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${ERASE_BUTTON}:${kind}:${id}`)
      .setLabel(kind === 'server' ? 'Delete it and remove BotApprove' : 'Erase my data')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`${ERASE_BUTTON}:cancel:0`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary),
  );
}

function serverRefusal(interaction) {
  const guild = interaction.guild;
  if (!guild || !interaction.client.guilds.cache.has(guild.id)) {
    return 'Run this inside the server, with BotApprove still in it.';
  }
  if (guild.ownerId !== interaction.user.id) {
    return 'Only the server owner can uninstall BotApprove. Anyone can erase what is held about '
      + 'themselves with /erase me.';
  }
  const busy = erasure.inProgress(guild.id);
  if (busy.length) {
    return `Not right now: ${busy.join('; ')}. Uninstalling would delete the record of it and `
      + 'what is needed to undo it. Try again once it is dealt with.';
  }
  if (erasure.activeSubscription(guild.id)) {
    return 'This server has an active paid subscription. Cancel it first under Licence, Manage '
      + 'billing on the dashboard, then run this again, so you are not charged for a licence '
      + 'that no longer exists here.';
  }
  return null;
}

function retainedText(retained) {
  if (!retained.length) return '';
  return '\n\n**Kept on purpose:**\n' + retained.map((r) => `• ${r.where} (${r.rows}): ${r.why}`).join('\n');
}

export async function handleErase(interaction) {
  const sub = interaction.options.getSubcommand();

  if (sub === 'me') {
    const id = interaction.user.id;
    const present = (g) => interaction.client.guilds.cache.has(g);
    const rows = erasure.userRows(id);
    const gone = erasure.releasable(id, present).length;
    if (gone) rows['guild_config.owner_id'] = gone;
    const n = sum(rows);
    const retained = erasure.retainedFor(id, present);
    if (!n) {
      return interaction.reply({
        content: 'BotApprove holds no records that name you.' + retainedText(retained)
          + `\n\n${RAIDPROTECTOR}`,
        ...ephemeral,
      });
    }
    return interaction.reply({
      content: `BotApprove has **${n}** record${n === 1 ? '' : 's'} that name you:\n${breakdown(rows)}\n\n`
        + 'Erasing removes the ones that exist only because of you, and replaces your ID with '
        + '"erased" in records a server still relies on, such as who approved a bot. The event '
        + 'stays; you do not. This cannot be undone.' + retainedText(retained),
      components: [confirmRow('me', id)],
      ...ephemeral,
    });
  }

  return interaction.reply({ content: 'Unknown option.', ...ephemeral });
}

export async function handleUninstall(interaction) {
  const refusal = serverRefusal(interaction);
  if (refusal) return interaction.reply({ content: refusal, ...ephemeral });
  const rows = erasure.serverRows(interaction.guildId);
  const n = sum(rows);
  return interaction.reply({
    content: `BotApprove holds **${n}** record${n === 1 ? '' : 's'} about this server:\n${breakdown(rows)}\n\n`
      + 'Uninstalling deletes every one of them: settings, whitelist, keywords, the security log, '
      + 'incidents and any licence. Then BotApprove leaves. Nothing in the server itself is '
      + 'touched: no channels, roles, members or messages, and bots already here stay where they '
      + 'are. This cannot be undone.',
    components: [confirmRow('server', interaction.guildId)],
    ...ephemeral,
  });
}

export async function handleEraseButton(interaction, parts) {
  const [, kind, id] = parts;

  if (kind === 'cancel') {
    return interaction.update({ content: 'Cancelled. Nothing was erased.', components: [] });
  }

  if (kind === 'me') {
    if (interaction.user.id !== id) {
      return interaction.reply({ content: 'That button belongs to someone else.', ...ephemeral });
    }
    const result = erasure.eraseUser(id, { present: (g) => interaction.client.guilds.cache.has(g) });
    log.info('erased a person on request', { changed: result.changed, left: result.left });
    return interaction.update({
      content: `Done. **${result.changed}** record${result.changed === 1 ? '' : 's'} changed or removed:\n`
        + `${breakdown(result.before)}\n\nChecked again afterwards: **${result.left}** left.`
        + retainedText(result.retained) + `\n\n${BACKUPS}\n${RAIDPROTECTOR}`,
      components: [],
    });
  }

  if (kind === 'server') {
    if (interaction.guildId !== id) {
      return interaction.reply({ content: 'That button belongs to another server.', ...ephemeral });
    }
    const refusal = serverRefusal(interaction);
    if (refusal) return interaction.reply({ content: refusal, ...ephemeral });

    const guild = interaction.guild;
    const result = erasure.eraseServer(id);
    await interaction.update({
      content: `Done. **${result.removed}** record${result.removed === 1 ? '' : 's'} deleted:\n`
        + `${breakdown(result.before)}\n\nChecked again afterwards: **${result.left}** left. `
        + `BotApprove is leaving the server now.\n\n${BACKUPS}\n${RAIDPROTECTOR}`,
      components: [],
    });
    log.info('erased a server on request', { removed: result.removed, left: result.left });

    await guild.leave().catch((err) => log.warn('could not leave after erase', { err: err.message }));
    // A second pass, for anything a sweep wrote between the erase and leaving.
    const late = erasure.eraseServer(id);
    if (late.removed) log.info('late rows erased after leaving', { removed: late.removed });
    return null;
  }

  return null;
}
