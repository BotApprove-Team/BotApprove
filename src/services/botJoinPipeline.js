import { whitelist, pendingApprovals, guildConfig } from '../db/queries.js';
import {
  matchKeyword,
  consumeReinviteToken,
  kickBot,
  record,
} from './securityService.js';
import {
  snapshotMember,
  findInviter,
  buildApprovalMessage,
  deliverApprovalPrompt,
  gatherImages,
} from './approvalService.js';
import {
  isConfirmedNukeBot,
  isKnownNukeBot,
  handleConfirmedNukeRejoin,
  handleKnownNukeBotJoin,
} from './nukeDefense.js';
import { resolveEntitlement, hasFeature } from './featureService.js';
import { check as checkImpersonation } from './impersonation.js';
import { baseline as baselinePermissions } from './driftWatch.js';
import { createLogger } from '../logger.js';

const log = createLogger('pipeline');

export async function onBotJoin(member) {
  const guild = member.guild;
  const guildId = guild.id;
  const botId = member.id;
  const username = member.user.username;

  let snapshot = null;
  try {
    snapshot = snapshotMember(member);
  } catch (err) {
    log.error('member snapshot failed', { guildId, botId, err: err.message });
  }

  try {
    guildConfig.ensure(guildId);
    if (isKnownNukeBot(guildId, botId)) {
      const result = await handleKnownNukeBotJoin(member, {
        resolveInviter: () => findInviter(guild, botId),
      });
      return { action: 'known_nuke_blocked', ...result };
    }

    if (isConfirmedNukeBot(guildId, botId)) {
      const kick = await kickBot(member, {
        reason: 'BotApprove: confirmed nuke bot',
        severity: 'critical',
        detail: { confirmed: true },
      });

      const inviter = await findInviter(guild, botId);
      await handleConfirmedNukeRejoin(guild, {
        botId,
        botTag: member.user.tag,
        inviterId: inviter?.known ? inviter.id : null,
      });

      return { action: 'nuke_bot_blocked', kicked: kick.ok };
    }

    let keywordMatched = matchKeyword(guildId, username);
    let tokenConsumed = false;

    if (keywordMatched) {
      const token = await consumeReinviteToken(guildId, botId, { keyword: keywordMatched });

      if (token.consumed) {
        tokenConsumed = true;
      } else {
        await record({
          guildId,
          botId,
          action: 'keyword_block',
          severity: 'high',
          title: 'Bot name matched a high-risk keyword',
          description: `\`${username}\`contains \`${keywordMatched}\`. Whitelist not consulted.`,
          detail: { keyword: keywordMatched, token_result: token.reason },
        });

        const kick = await kickBot(member, {
          reason: `BotApprove: name matches high-risk keyword "${keywordMatched}"`,
          severity: 'high',
          detail: { keyword: keywordMatched },
        });

        await openApproval({
          member, snapshot, keywordMatched, tokenConsumed: false, kickOk: kick.ok,
        });
        return { action: 'keyword_blocked', keywordMatched };
      }
    }

    const cfg = guildConfig.get(guildId);
    let whitelistExpired = false;
    if (whitelist.has(guildId, botId) && cfg.whitelist_expiry_days > 0
        && hasFeature(guildId, 'whitelist_expiry')) {
      const row = whitelist.get(guildId, botId);
      const ageDays = (Date.now() - row.approved_at) / 86_400_000;
      if (ageDays > cfg.whitelist_expiry_days) {
        whitelistExpired = true;
        await record({
          guildId,
          botId,
          action: 'whitelist_expired',
          severity: 'medium',
          title: 'Approval has lapsed',
          description: `Approved ${Math.floor(ageDays)} days ago, past this server's ` +
            `${cfg.whitelist_expiry_days} day limit. Held for reconfirmation.`,
          detail: { bot_tag: member.user.tag, approved_at: row.approved_at },
        });
      }
    }

    if (!whitelistExpired && whitelist.has(guildId, botId)) {
      await record({
        guildId,
        botId,
        action: 'join_allowed',
        severity: 'info',
        title: 'Whitelisted bot allowed',
        detail: {
          bot_tag: member.user.tag,
          via_token: tokenConsumed || undefined,
          admin: snapshot?.isAdministrator || undefined,
        },
      });
      await applyPostAllow(member);
      return { action: 'allowed' };
    }

    const kick = await kickBot(member, {
      reason: 'BotApprove: bot is not whitelisted, pending human approval',
      severity: 'medium',
      detail: { bot_tag: member.user.tag },
    });

    await openApproval({
      member, snapshot, keywordMatched, tokenConsumed, kickOk: kick.ok, whitelistExpired,
    });
    return { action: 'pending_approval' };
  } catch (err) {
    log.error('pipeline error, falling back to kick', {
      guildId, botId, err: err.message, stack: err.stack,
    });

    const kick = await kickBot(member, {
      reason: 'BotApprove: approval pipeline error, denied by fail-safe default',
      severity: 'critical',
      detail: { error: err.message },
    }).catch((e) => ({ ok: false, error: e }));

    await record({
      guildId,
      botId,
      action: 'pipeline_error',
      severity: 'critical',
      title: 'Approval pipeline errored, bot denied by default',
      description: 'The failure is the reason for the kick. Investigate before re-inviting.',
      detail: { error: err.message, kicked: kick.ok },
    }).catch(() => {});

    return { action: 'failsafe_kick', error: err };
  }
}

async function openApproval({
  member, snapshot, keywordMatched, tokenConsumed, kickOk, whitelistExpired = false,
}) {
  const guild = member.guild;
  const guildId = guild.id;
  const botId = member.id;

  const info = pendingApprovals.create({
    guildId,
    botId,
    botTag: member.user.tag,
    addedBy: null,
    keywordMatched,
    tokenConsumed,
  });
  const pendingId = Number(info.lastInsertRowid);

  const [inviter, botUser] = await Promise.all([
    findInviter(guild, botId),
    guild.client.users.fetch(botId, { force: true }).catch(() => member.user),
  ]);

  if (inviter?.known && inviter.id) {
    try {
      pendingApprovals.setInviter(pendingId, inviter.id);
    } catch (err) {
      log.warn('could not persist inviter', { pendingId, err: err.message });
    }
  }

  const cfg = guildConfig.get(guildId);
  const impersonation = (() => {
    try {
      return checkImpersonation(guildId, { botId, username: member.user.username });
    } catch (err) {
      log.warn('impersonation check failed', { botId, err: err.message });
      return null;
    }
  })();

  const minAgeDays = cfg.min_account_age_days ?? 0;
  const ageDays = member.user.createdTimestamp
    ? (Date.now() - member.user.createdTimestamp) / 86_400_000
    : null;
  const tooNew = minAgeDays > 0 && hasFeature(guildId, 'account_age_floor')
    && ageDays !== null && ageDays < minAgeDays;

  let images = null;
  let threshold = 512;
  let imagesGated = false;
  try {
    ({ images, threshold, gated: imagesGated } = await gatherImages(botUser, guildId));
  } catch (err) {
    log.warn('image probe failed', { guildId, botId, err: err.message });
  }

  const payload = buildApprovalMessage({
    pendingId,
    guild,
    botUser,
    snapshot,
    inviter,
    images,
    keywordMatched,
    tokenConsumed,
    kickOk,
    threshold,
    imagesGated,
    impersonation,
    whitelistExpired,
    accountAge: { days: ageDays, minDays: minAgeDays, tooNew },
    quorumRequired: hasFeature(guildId, 'approval_quorum') ? (cfg.quorum_required ?? 0) : 0,
  });

  await deliverApprovalPrompt({ guild, pendingId, payload });
  return pendingId;
}

async function applyPostAllow(member) {
  baselinePermissions(member);

  const state = resolveEntitlement(member.guild.id);
  if (!state.licensed) {
    log.info('guild is unlicensed, core gate ran normally', {
      guildId: member.guild.id, state: state.state,
    });
  }
}
