import { ActivityType, Client, Events, GatewayIntentBits, Partials } from 'discord.js';
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { setClient } from './clientRef.js';
import { onBotJoin } from '../services/botJoinPipeline.js';
import { checkGuild, checkAllGuilds } from '../services/selfCheck.js';
import { seedDefaultKeywords, record } from '../services/securityService.js';
import { applyNickname } from '../services/nicknameService.js';
import { enforceEntitlements, startTrial, resolveEntitlement } from '../services/entitlementService.js';
import { reinviteTokens, guildConfig } from '../db/queries.js';
import { rememberGuild, rememberAll, onMemberRemoved, onGuildRemoved } from '../services/removalWatch.js';
import { checkAll as checkDriftAll, checkBot as checkDriftBot } from '../services/driftWatch.js';
import { handleInteraction } from './commands/index.js';

const log = createLogger('bot');

const SWEEP_INTERVAL_MS = 5 * 60_000;

function setPresence(client) {
  try {
    client.user.setPresence({
      status: 'online',
      activities: [{
        name: 'botapprove',
        type: ActivityType.Custom,
        state: config.botStatus,
      }],
    });
    log.info('presence set', { status: config.botStatus });
  } catch (err) {
    log.warn('could not set presence', { err: err.message });
  }
}

export function createClient() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
    ],
    partials: [Partials.GuildMember, Partials.User],
  });

  setClient(client);

  client.once(Events.ClientReady, async (c) => {
    log.info('logged in', {
      tag: c.user.tag,
      id: c.user.id,
      guilds: c.guilds.cache.size,
      paywall: config.paywall.enabled,
    });

    setPresence(c);

    rememberAll(c);

    for (const [, guild] of c.guilds.cache) {
      seedDefaultKeywords(guild.id);
      await applyNickname(guild).catch(() => {});
      await checkGuild(guild, { reason: 'startup' }).catch((err) =>
        log.error('startup self-check failed', { guildId: guild.id, err: err.message }));
    }

    await enforceEntitlements(c).catch((err) =>
      log.error('entitlement sweep failed', { err: err.message }));

    setInterval(() => {
      const purged = reinviteTokens.purgeExpired();
      if (purged) log.info('expired re-invite tokens purged', { purged });
      checkAllGuilds(c, { reason: 'periodic' }).catch(() => {});
      checkDriftAll(c, { reason: 'periodic' }).catch(() => {});
      enforceEntitlements(c).catch(() => {});
    }, SWEEP_INTERVAL_MS).unref?.();
  });

  client.on(Events.GuildMemberAdd, async (member) => {
    if (!member.user.bot) return;
    if (member.id === client.user?.id) return;

    log.info('bot join detected', {
      guildId: member.guild.id,
      botId: member.id,
      tag: member.user.tag,
    });

    await onBotJoin(member).catch((err) =>
      log.error('unhandled pipeline rejection', { botId: member.id, err: err.message }));
  });

  client.on(Events.GuildCreate, async (guild) => {
    log.info('added to guild', { guildId: guild.id, name: guild.name, members: guild.memberCount });
    guildConfig.ensure(guild.id);
    rememberGuild(guild);
    seedDefaultKeywords(guild.id);

    if (config.paywall.enabled && config.paywall.trialDays > 0) {
      const state = resolveEntitlement(guild.id);
      if (!state.licensed) await startTrial(guild.id, 'system').catch(() => {});
    }

    await checkGuild(guild, { reason: 'guild_create' }).catch(() => {});
    await record({
      guildId: guild.id,
      action: 'guild_join',
      severity: 'info',
      detail: { name: guild.name },
      mirror: false,
    });
  });

  client.on(Events.GuildMemberUpdate, async (oldMember, updated) => {
    if (updated.id === client.user?.id) {
      await checkGuild(updated.guild, { reason: 'self_member_update' }).catch(() => {});
      return;
    }
    if (!updated.user.bot) return;
    if (oldMember.roles?.cache?.size === updated.roles.cache.size) return;
    await checkDriftBot(updated, { reason: 'role_change' }).catch(() => {});
  });

  client.on(Events.GuildRoleUpdate, async (_old, role) => {
    const me = role.guild.members.me;
    if (!me?.roles.cache.has(role.id)) return;
    await checkGuild(role.guild, { reason: 'role_update' }).catch(() => {});
  });

  client.on(Events.GuildMemberRemove, async (member) => {
    await onMemberRemoved(member).catch((err) =>
      log.error('removal actor capture failed', { err: err.message }));
  });

  client.on(Events.GuildDelete, async (guild) => {
    await onGuildRemoved(guild).catch((err) =>
      log.error('removal handling failed', { guildId: guild.id, err: err.message }));
  });

  client.on(Events.GuildUpdate, (oldGuild, newGuild) => {
    if (oldGuild.ownerId !== newGuild.ownerId || oldGuild.name !== newGuild.name) {
      rememberGuild(newGuild);
    }
  });

  client.on(Events.InteractionCreate, (interaction) => handleInteraction(interaction));

  client.on(Events.Error, (err) => log.error('client error', { err: err.message }));
  client.on(Events.Warn, (msg) => log.warn('client warning', { msg }));

  return client;
}

export async function startBot() {
  const client = createClient();
  await client.login(config.discord.token);
  return client;
}
