import { Router } from 'express';
import { ChannelType, PermissionsBitField } from 'discord.js';
import {
  whitelist,
  keywords,
  approverRoles,
  guildConfig,
  pendingApprovals,
  reinviteTokens,
  securityLog,
  entitlements,
  licenseKeys,
  nukeRegistry,
  knownNukeBots,
  nukeIncidents,
  nukeDbRequests,
  announcements,
  blog,
  termsAcceptances,
} from '../../db/queries.js';
import {
  confirmNukeBot,
  unconfirmNukeBot,
  addKnownNukeBot,
  removeKnownNukeBot,
  requestKnownNukeBot,
  reviewNukeRequest,
  INVITER_ACTIONS,
} from '../../services/nukeDefense.js';
import { featureState, hasFeature } from '../../services/featureService.js';
import {
  removeFromWhitelist,
  revokeReinviteToken,
  record,
} from '../../services/securityService.js';
import { resolveApproval } from '../../services/approvalService.js';
import { setNickname } from '../../services/nicknameService.js';
import {
  resolveEntitlement,
  redeemLicenseKey,
  inspectLicenseKey,
  generateLicenseKey,
  grantEntitlement,
  revokeEntitlement,
} from '../../services/entitlementService.js';
import { checkGuild } from '../../services/selfCheck.js';
import { checkChannel, describeChannelProblem } from '../../services/channelCheck.js';
import { requireGuildAccess, isInstanceOwner } from '../auth.js';
import {
  attemptUnlock, lock, isAdminUnlocked, unlockRemaining, isConfigured,
  currentStage, requireUnlocked,
} from '../adminAuth.js';
import { broadcast, preview, validate } from '../../services/announcementService.js';
import {
  validate as validatePost, uniqueSlug, render as renderPost,
} from '../../services/blogService.js';
import {
  createCheckoutSession, createPortalSession, isEnabled as stripeEnabled, trialOffer,
} from '../../services/stripeService.js';
import {
  DOCUMENT as TERMS_DOCUMENT, VERSION as TERMS_VERSION,
  TITLE as TERMS_TITLE, INTRO as TERMS_INTRO, SECTIONS as TERMS_SECTIONS,
} from '../../services/promoTerms.js';
import { getClient } from '../../bot/clientRef.js';
import { config } from '../../config.js';
import { createLogger } from '../../logger.js';

const log = createLogger('web-dashboard');

export const router = Router();

const MANAGE_GUILD_BIT = PermissionsBitField.Flags.ManageGuild;

function flash(req, type, message) {
  req.session.flash = { type, message };
}

function takeFlash(req) {
  const f = req.session?.flash ?? null;
  if (req.session) delete req.session.flash;
  return f;
}

router.get('/guilds', (req, res) => {
  const client = getClient();
  const present = new Set(client ? [...client.guilds.cache.keys()] : []);

  const candidates = (req.session.guilds ?? []).map((g) => ({
    ...g,
    botPresent: present.has(g.id),
    manageable: g.owner || (BigInt(g.permissions) & MANAGE_GUILD_BIT) === MANAGE_GUILD_BIT,
  }));

  const owned = isInstanceOwner(req.session.user.id)
    ? [...(client?.guilds.cache.values() ?? [])]
      .filter((g) => !candidates.some((c) => c.id === g.id))
      .map((g) => ({ id: g.id, name: g.name, icon: g.icon, botPresent: true, manageable: true, viaOwner: true }))
    : [];

  res.render('guilds', {
    title: 'Your servers',
    guilds: [...candidates, ...owned].sort((a, b) => Number(b.botPresent) - Number(a.botPresent)),
    inviteUrl: config.inviteUrl,
    flash: takeFlash(req),
  });
});

router.get('/g/:guildId', requireGuildAccess('approve'), async (req, res) => {
  const { guild, canConfigure } = req.guildAccess;
  const guildId = guild.id;

  const cfg = guildConfig.get(guildId);
  const selfCheck = await checkGuild(guild, { reason: 'dashboard' }).catch((err) => ({
    ok: false, problems: [err.message],
  }));

  const textChannels = guild.channels.cache
    .filter((c) => c.type === ChannelType.GuildText)
    .map((c) => ({ id: c.id, name: c.name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const roles = guild.roles.cache
    .filter((r) => r.id !== guildId && !r.managed)
    .map((r) => ({ id: r.id, name: r.name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const pending = pendingApprovals.listPending(guildId);
  const recent = pendingApprovals.listRecent(guildId, 25)
    .filter((r) => r.status !== 'pending');

  res.render('guild', {
    title: guild.name,
    guild: { id: guildId, name: guild.name, icon: guild.icon, memberCount: guild.memberCount },
    canConfigure,
    cfg,
    nickname: guild.members.me?.nickname ?? null,
    selfCheck,
    textChannels,
    roles,
    pending,
    recent,
    whitelisted: whitelist.list(guildId),
    keywordList: keywords.rows(guildId),
    approverRoleIds: approverRoles.list(guildId),
    tokens: reinviteTokens.listLive(guildId),
    logs: securityLog.recent(guildId, 60),
    entitlement: resolveEntitlement(guildId),
    features: featureState(guildId),
    nukes: nukeRegistry.list(guildId),
    incidents: nukeIncidents.recent(guildId, 15),
    requests: nukeDbRequests.listForGuild(guildId, 12),
    inviterActions: INVITER_ACTIONS,
    purchaseUrl: config.paywall.purchaseUrl,
    viaOperator: req.guildAccess.via === 'instance_owner',
    stripeReady: stripeEnabled(),
    trialOffer: trialOffer(guildId),
    pendingLicence: req.session.pendingLicence?.guildId === guildId
      ? req.session.pendingLicence : null,
    terms: { title: TERMS_TITLE, intro: TERMS_INTRO, sections: TERMS_SECTIONS, version: TERMS_VERSION },
    termsAccepted: termsAcceptances.latestFor(guildId, TERMS_DOCUMENT),
    hasStripeCustomer: !!entitlements.get(guildId)?.external_id?.startsWith('cus_'),
    price: { amount: config.paywall.priceAmount, symbol: config.paywall.priceSymbol },
    portalUrl: config.stripe.portalUrl,
    flash: takeFlash(req),
  });
});

router.post('/g/:guildId/approvals/:id', requireGuildAccess('approve'), async (req, res) => {
  const pendingId = Number(req.params.id);
  const decision = { approve: 'approve', nuke: 'nuke' }[req.body.decision] ?? 'deny';
  const row = pendingApprovals.byId(pendingId);

  if (!row || row.guild_id !== req.params.guildId) {
    flash(req, 'error', 'That approval does not belong to this server.');
    return res.redirect(`/g/${req.params.guildId}`);
  }

  const result = await resolveApproval({
    pendingId,
    decision,
    actorId: req.session.user.id,
    via: 'web',
  });

  if (!result.ok && result.reason === 'awaiting_quorum') {
    flash(req, 'ok', `Vote recorded: ${result.votes} of ${result.needed} approvers agree. ` +
      '#' + pendingId + ' stays held until one more approves.');
  } else if (!result.ok) {
    flash(req, 'error', result.reason === 'already_resolved'
      ? `#${pendingId} was already ${result.existing.status}.`
      : 'Approval not found.');
  } else if (result.reinviteExpiresAt) {
    const mins = Math.max(1, Math.round((result.reinviteExpiresAt - Date.now()) / 60000));
    flash(req, 'ok', `#${pendingId} approved. Single-use re-invite token valid for ~${mins} min, ` +
      're-invite the bot manually; it is not re-added automatically.');
  } else if (decision === 'nuke') {
    flash(req, 'ok', `#${pendingId} denied and confirmed as a nuke bot. ` + (result.nuke?.banned
      ? 'The inviter has been banned.'
      : `Inviter not banned (${result.nuke?.reason ?? 'unknown'}).`));
  } else {
    flash(req, 'ok', `#${pendingId} ${result.status}.`);
  }

  return res.redirect(`/g/${req.params.guildId}`);
});

router.post('/g/:guildId/whitelist/remove', requireGuildAccess('configure'), async (req, res) => {
  const botId = String(req.body.bot_id ?? '');
  const removed = await removeFromWhitelist(req.params.guildId, botId, req.session.user.id, { via: 'web' });
  await revokeReinviteToken(req.params.guildId, botId, req.session.user.id);
  flash(req, removed ? 'ok' : 'error',
    removed ? `${botId} removed from the whitelist.` : 'That bot was not whitelisted.');
  res.redirect(`/g/${req.params.guildId}`);
});

router.post('/g/:guildId/tokens/revoke', requireGuildAccess('configure'), async (req, res) => {
  const botId = String(req.body.bot_id ?? '');
  const revoked = await revokeReinviteToken(req.params.guildId, botId, req.session.user.id);
  flash(req, revoked ? 'ok' : 'error', revoked ? 'Re-invite token revoked.' : 'No live token found.');
  res.redirect(`/g/${req.params.guildId}`);
});

router.post('/g/:guildId/keywords', requireGuildAccess('configure'), async (req, res) => {
  const guildId = req.params.guildId;
  const actorId = req.session.user.id;
  const keyword = String(req.body.keyword ?? '').trim().toLowerCase();

  if (req.body.action === 'remove') {
    const info = keywords.remove(guildId, keyword);
    await record({
      guildId, actorId, action: 'keyword_remove', severity: 'medium',
      detail: { keyword, via: 'web' },
    });
    flash(req, info.changes ? 'ok' : 'error',
      info.changes ? `Removed "${keyword}".` : 'That keyword was not in the list.');
  } else {
    if (keyword.length < 2) {
      flash(req, 'error', 'Keywords must be at least 2 characters.');
    } else if (!hasFeature(guildId, 'custom_keywords')) {
      flash(req, 'error', 'Adding keywords is a premium feature. Everything already on your ' +
        'blocklist keeps being enforced.');
    } else {
      keywords.add(guildId, keyword, actorId);
      await record({ guildId, actorId, action: 'keyword_add', detail: { keyword, via: 'web' } });
      flash(req, 'ok', `Bots whose name contains "${keyword}" will be hard-blocked.`);
    }
  }
  res.redirect(`/g/${guildId}`);
});

router.post('/g/:guildId/approvers', requireGuildAccess('configure'), async (req, res) => {
  const guildId = req.params.guildId;
  const roleId = String(req.body.role_id ?? '');
  const removing = req.body.action === 'remove';

  if (removing) approverRoles.remove(guildId, roleId);
  else approverRoles.add(guildId, roleId);

  await record({
    guildId,
    actorId: req.session.user.id,
    action: removing ? 'approver_role_remove' : 'approver_role_add',
    severity: 'medium',
    detail: { role: roleId, via: 'web' },
  });

  flash(req, 'ok', removing ? 'Approver role removed.' : 'Approver role added.');
  res.redirect(`/g/${guildId}`);
});

router.post('/g/:guildId/config', requireGuildAccess('configure'), async (req, res) => {
  const { guild } = req.guildAccess;
  const guildId = guild.id;
  const actorId = req.session.user.id;

  const patch = {};
  const notify = String(req.body.notify_channel_id ?? '');
  const logCh = String(req.body.log_channel_id ?? '');

  const channelErrors = [];
  for (const [label, id, key] of [
    ['Approval channel', notify, 'notify_channel_id'],
    ['Log channel', logCh, 'log_channel_id'],
  ]) {
    if (!id) { patch[key] = null; continue; }
    const health = await checkChannel(guild, id);
    if (health.ok) { patch[key] = id; continue; }
    channelErrors.push(`${label}: ${describeChannelProblem(health, id).replace(/\*\*/g, '')}`);
  }
  patch.notify_via_dm = req.body.notify_via_dm ? 1 : 0;
  patch.auto_ban_nuke_inviters = req.body.auto_ban_nuke_inviters ? 1 : 0;
  if (INVITER_ACTIONS.includes(req.body.nuke_inviter_action)) {
    patch.nuke_inviter_action = req.body.nuke_inviter_action;
  }

  const announce = String(req.body.announce_channel_id ?? '');
  if (!announce) {
    patch.announce_channel_id = null;
  } else {
    const health = await checkChannel(guild, announce);
    if (health.ok) patch.announce_channel_id = announce;
    else channelErrors.push(`Announcement channel: ${describeChannelProblem(health, announce).replace(/\*\*/g, '')}`);
  }
  patch.announce_allow_everyone = req.body.announce_allow_everyone ? 1 : 0;
  patch.impersonation_check = req.body.impersonation_check ? 1 : 0;

  for (const [field, key, max] of [
    ['min_account_age_days', 'account_age_floor', 3650],
    ['whitelist_expiry_days', 'whitelist_expiry', 3650],
  ]) {
    const n = Number.parseInt(req.body[field], 10);
    if (Number.isFinite(n) && n >= 0 && n <= max) {
      if (n === 0 || hasFeature(guildId, key)) patch[field] = n;
    }
  }
  const quorum = Number.parseInt(req.body.quorum_required, 10);
  if (Number.isFinite(quorum) && quorum >= 1 && quorum <= 5) {
    const value = quorum <= 1 ? 0 : quorum;
    if (value === 0 || hasFeature(guildId, 'approval_quorum')) patch.quorum_required = value;
  }

  const px = Number.parseInt(req.body.low_res_threshold_px, 10);
  if (Number.isFinite(px) && px >= 16 && px <= 4096) patch.low_res_threshold_px = px;

  guildConfig.set(guildId, patch);

  const submittedNick = String(req.body.nickname ?? '').trim() || null;
  const currentNick = guildConfig.get(guildId).nickname ?? null;
  const nickResult = submittedNick === currentNick
    ? { ok: true, unchanged: true }
    : await setNickname(guild, submittedNick, actorId);

  await record({
    guildId, actorId, action: 'config_update', severity: 'info',
    detail: { ...patch, via: 'web' }, mirror: false,
  });

  if (channelErrors.length) {
    flash(req, 'error', `Saved everything else, but ${channelErrors.join(' ')} ` +
      'That channel was not changed.');
  } else if (nickResult.reason === 'premium_required') {
    flash(req, 'error', 'Settings saved. A custom nickname is a premium feature and is currently ' +
      'inactive for this server.');
  } else if (!nickResult.ok) {
    flash(req, 'error', `Settings saved, but the nickname was rejected: ${nickResult.reason}`);
  } else if (nickResult.applied && !nickResult.applied.ok &&
             nickResult.applied.reason !== 'not_configured') {
    flash(req, 'error',
      `Settings saved, but the nickname could not be applied (${nickResult.applied.reason}). ` +
      'Grant BotApprove the Change Nickname permission.');
  } else {
    flash(req, 'ok', 'Settings saved.');
  }

  res.redirect(`/g/${guildId}`);
});

router.post('/g/:guildId/nuke', requireGuildAccess('approve'), async (req, res) => {
  const guildId = req.params.guildId;
  const botId = String(req.body.bot_id ?? '').trim();

  if (!/^\d{15,25}$/.test(botId)) {
    flash(req, 'error', 'That is not a valid bot user id.');
    return res.redirect(`/g/${guildId}`);
  }

  if (req.body.action === 'unconfirm') {
    const removed = await unconfirmNukeBot(guildId, botId, req.session.user.id);
    flash(req, removed ? 'ok' : 'error',
      removed ? `${botId} is no longer a confirmed nuke bot.` : 'That bot was not on the list.');
  } else {
    const target = await getClient()?.users.fetch(botId).catch(() => null);
    if (target && !target.bot) {
      flash(req, 'error', 'That id belongs to a user, not a bot.');
      return res.redirect(`/g/${guildId}`);
    }
    await confirmNukeBot(guildId, botId, {
      botTag: target?.tag,
      confirmedBy: req.session.user.id,
      reason: String(req.body.reason ?? '').slice(0, 200) || 'confirmed from dashboard',
    });
    flash(req, 'ok', `${botId} is a confirmed nuke bot, kicked on sight from now on.`);
  }

  return res.redirect(`/g/${guildId}`);
});

router.post('/g/:guildId/nuke-request', requireGuildAccess('approve'), async (req, res) => {
  const { guild } = req.guildAccess;
  const botId = String(req.body.bot_id ?? '').trim();

  if (!/^\d{15,25}$/.test(botId)) {
    flash(req, 'error', 'That is not a valid bot user id.');
    return res.redirect(`/g/${guild.id}`);
  }

  const target = await getClient()?.users.fetch(botId).catch(() => null);
  if (target && !target.bot) {
    flash(req, 'error', 'That id belongs to a user, not a bot.');
    return res.redirect(`/g/${guild.id}`);
  }

  const result = await requestKnownNukeBot({
    botId,
    botTag: target?.tag,
    reason: req.body.reason,
    requestedBy: req.session.user.id,
    requestedByTag: req.session.user.username,
    guild,
  });

  flash(req, result.ok ? 'ok' : 'error', result.ok
    ? `Submitted as request #${result.id}. It reaches the shared list only if the operator ` +
      'approves it. Use the confirm form above to block it here immediately.'
    : {
      already_listed: 'That bot is already on the shared threat list.',
      already_requested: 'You already have a pending submission for that bot.',
      reason_too_short: 'Give at least a sentence explaining what it did.',
    }[result.reason] ?? `Could not submit: ${result.reason}`);

  return res.redirect(`/g/${guild.id}`);
});

router.post('/g/:guildId/subscribe', requireGuildAccess('configure'), async (req, res) => {
  const { guild } = req.guildAccess;
  if (!stripeEnabled()) {
    flash(req, 'error', 'Card payment is not configured on this instance. Use a licence key.');
    return res.redirect(`/g/${guild.id}`);
  }

  const result = await createCheckoutSession({
    guildId: guild.id,
    guildName: guild.name,
    userId: req.session.user.id,
  });

  if (!result.ok) {
    flash(req, 'error', `Could not start checkout: ${result.reason}`);
    return res.redirect(`/g/${guild.id}`);
  }
  return res.redirect(303, result.url);
});

router.post('/g/:guildId/billing', requireGuildAccess('configure'), async (req, res) => {
  const { guild } = req.guildAccess;
  const result = await createPortalSession({ guildId: guild.id });
  if (!result.ok) {
    flash(req, 'error', result.reason === 'no_subscription'
      ? 'No card subscription on this server. Nothing to manage.'
      : `Could not open the billing portal: ${result.reason}`);
    return res.redirect(`/g/${guild.id}`);
  }
  return res.redirect(303, result.url);
});

const KEY_REJECTED = {
  unknown_key: 'That key does not exist.',
  revoked: 'That key has been revoked.',
  seats_exhausted: 'That key has already been used on as many servers as it allows.',
};

async function activateKey(req, res, guildId, key, keyHash) {
  const result = await redeemLicenseKey(guildId, key, req.session.user.id);
  flash(req, result.ok ? 'ok' : 'error', result.ok
    ? `Licence active: ${result.tier}${result.expiresAt ? ` until ${new Date(result.expiresAt).toDateString()}` : ' (perpetual)'}.`
    : (KEY_REJECTED[result.reason] ?? `Key rejected: ${result.reason}.`));
  return result;
}

router.post('/g/:guildId/license', requireGuildAccess('configure'), async (req, res) => {
  const guildId = req.params.guildId;
  const done = () => res.redirect(`/g/${guildId}`);

  if (req.body.action === 'cancel') {
    delete req.session.pendingLicence;
    flash(req, 'ok', 'Cancelled. The key was not redeemed.');
    return done();
  }

  if (req.body.action === 'accept') {
    const pending = req.session.pendingLicence;
    if (!pending || pending.guildId !== guildId) {
      flash(req, 'error', 'That key is no longer waiting. Paste it again.');
      return done();
    }
    if (!req.body.accept) {
      flash(req, 'error', 'The terms have to be accepted before the key can be redeemed.');
      return done();
    }

    // Cleared before redeeming, so a refreshed confirmation cannot run twice.
    delete req.session.pendingLicence;

    const result = await activateKey(req, res, guildId, pending.key, pending.keyHash);
    if (result.ok) {
      termsAcceptances.record({
        guildId,
        userId: req.session.user.id,
        document: TERMS_DOCUMENT,
        version: TERMS_VERSION,
        keyHash: pending.keyHash,
      });
      await record({
        guildId,
        actorId: req.session.user.id,
        action: 'terms_accepted',
        severity: 'info',
        detail: { document: TERMS_DOCUMENT, version: TERMS_VERSION },
        mirror: false,
      }).catch(() => {});
    }
    return done();
  }

  const key = String(req.body.key ?? '').trim();
  const found = inspectLicenseKey(key);
  if (!found.ok) {
    flash(req, 'error', KEY_REJECTED[found.reason] ?? `Key rejected: ${found.reason}.`);
    return done();
  }

  // Perpetual keys are only ever handed out free, so they are the ones carrying
  // the complimentary terms. A key with a duration was sold, and a future
  // keyless perpetual bought through Stripe never reaches this route at all.
  if (found.perpetual) {
    req.session.pendingLicence = { guildId, key, keyHash: found.keyHash, tier: found.tier };
    return done();
  }

  await activateKey(req, res, guildId, key, found.keyHash);
  return done();
});

function requireOwner(req, res, next) {
  if (isInstanceOwner(req.session.user.id)) return next();
  return res.status(403).render('error', {
    title: 'Not permitted',
    message: 'That area is restricted to the instance owner.',
  });
}

router.get('/admin/unlock', requireOwner, (req, res) => {
  res.render('unlock', {
    title: 'Operator unlock',
    configured: isConfigured(),
    unlocked: isAdminUnlocked(req),
    remaining: unlockRemaining(req),
    stage: currentStage(req),
    flash: takeFlash(req),
  });
});

router.post('/admin/unlock', requireOwner, async (req, res) => {
  if (req.body.action === 'lock') {
    await lock(req);
    flash(req, 'ok', 'Locked. Operator access ended.');
    return res.redirect('/admin/unlock');
  }

  const result = await attemptUnlock(req, req.body.password);

  if (result.ok) {
    const to = req.session.adminReturnTo || '/admin';
    delete req.session.adminReturnTo;
    flash(req, 'ok', `Unlocked for ${config.admin.unlockTtlMs / 60000} minutes.`);
    return res.redirect(to);
  }

  if (result.reason === 'stage_two') {
    flash(req, 'ok', `Second password, within ${result.seconds} seconds.`);
    return res.redirect('/admin/unlock');
  }

  flash(req, 'error', {
    not_configured: 'Operator elevation is not configured on this instance.',
    locked_out: `Too many attempts. Locked out for ${result.minutes} minutes.`,
    wrong_password: result.restarted
      ? `Wrong. Start again from the first password. ${result.remaining} attempt(s) left.`
      : `Wrong password. ${result.remaining} attempt(s) left.`,
  }[result.reason] ?? 'Could not unlock.');

  return res.redirect('/admin/unlock');
});

router.get('/admin', requireOwner, requireUnlocked, (req, res) => {
  const client = getClient();
  res.render('admin', {
    title: 'Instance admin',
    guilds: [...(client?.guilds.cache.values() ?? [])].map((g) => ({
      id: g.id,
      name: g.name,
      memberCount: g.memberCount,
      entitlement: resolveEntitlement(g.id),
    })),
    keys: licenseKeys.all(),
    entitlementRows: entitlements.all(),
    knownNukes: knownNukeBots.all(),
    pendingRequests: nukeDbRequests.listPending(),
    reviewedRequests: nukeDbRequests.listRecent(30).filter((r) => r.status !== 'pending'),
    stats: {
      guilds: client?.guilds.cache.size ?? 0,
      knownNukes: knownNukeBots.count(),
      pendingRequests: nukeDbRequests.pendingCount(),
    },
    paywall: config.paywall,
    flash: takeFlash(req),
  });
});

router.post('/admin/requests', requireOwner, requireUnlocked, async (req, res) => {
  const result = await reviewNukeRequest({
    id: Number(req.body.id),
    decision: req.body.decision === 'approve' ? 'approve' : 'reject',
    reviewerId: req.session.user.id,
    note: String(req.body.note ?? '').slice(0, 200) || undefined,
  });

  flash(req, result.ok ? 'ok' : 'error', result.ok
    ? (result.status === 'approved'
      ? `Request #${result.row.id} approved. ${result.row.bot_id} is now banned on sight in ` +
        'every licensed server.'
      : `Request #${result.row.id} rejected. Nothing was listed.`)
    : (result.reason === 'already_reviewed'
      ? `That request was already ${result.existing.status}.`
      : 'No such request.'));

  res.redirect('/admin');
});

router.post('/admin/keys', requireOwner, requireUnlocked, (req, res) => {
  const days = Number.parseInt(req.body.days, 10);
  const seats = Number.parseInt(req.body.seats, 10);
  const key = generateLicenseKey({
    durationDays: Number.isFinite(days) && days > 0 ? days : null,
    maxGuilds: Number.isFinite(seats) && seats > 0 ? seats : 1,
    note: String(req.body.note ?? '').slice(0, 200) || null,
    createdBy: req.session.user.id,
  });
  flash(req, 'key', key);
  res.redirect('/admin');
});

router.post('/admin/nukedb', requireOwner, requireUnlocked, async (req, res) => {
  const botId = String(req.body.bot_id ?? '').trim();
  if (!/^\d{15,25}$/.test(botId)) {
    flash(req, 'error', 'That is not a valid bot user id.');
    return res.redirect('/admin');
  }

  if (req.body.action === 'remove') {
    const removed = await removeKnownNukeBot(botId, req.session.user.id);
    flash(req, removed ? 'ok' : 'error',
      removed ? `${botId} removed from the shared threat list.` : 'That bot was not listed.');
  } else {
    const target = await getClient()?.users.fetch(botId).catch(() => null);
    if (target && !target.bot) {
      flash(req, 'error', 'That id belongs to a user, not a bot.');
      return res.redirect('/admin');
    }
    await addKnownNukeBot({
      botId,
      botTag: target?.tag,
      reason: String(req.body.reason ?? '').slice(0, 200) || undefined,
      addedBy: req.session.user.id,
    });
    flash(req, 'ok', `${botId} added, banned on sight in every licensed server.`);
  }
  return res.redirect('/admin');
});

router.post('/admin/entitlements', requireOwner, requireUnlocked, async (req, res) => {
  const guildId = String(req.body.guild_id ?? '');
  const actorId = req.session.user.id;

  if (req.body.action === 'revoke') {
    await revokeEntitlement(guildId, actorId, 'revoked from admin panel');
    flash(req, 'ok', `Entitlement revoked for ${guildId}.`);
  } else {
    const days = Number.parseInt(req.body.days, 10);
    await grantEntitlement(guildId, {
      tier: String(req.body.tier ?? 'pro'),
      expiresAt: Number.isFinite(days) && days > 0 ? Date.now() + days * 86_400_000 : null,
      note: 'granted from admin panel',
      actorId,
    });
    flash(req, 'ok', `Entitlement granted to ${guildId}.`);
  }
  res.redirect('/admin');
});

function renderAnnounce(req, res) {
  const client = getClient();
  res.render('announce', {
    title: 'Announcements',
    targets: client ? preview(client) : [],
    history: announcements.recent(20),
    pending: req.session.announceDraft ?? null,
    botReady: !!client,
    flash: takeFlash(req),
  });
}

router.get('/admin/announce', requireOwner, requireUnlocked, (req, res) => {
  renderAnnounce(req, res);
});

router.post('/admin/announce', requireOwner, requireUnlocked, async (req, res) => {
  const action = String(req.body.action ?? 'compose');

  if (action === 'cancel') {
    delete req.session.announceDraft;
    flash(req, 'ok', 'Discarded. Nothing was sent.');
    return res.redirect('/admin/announce');
  }

  if (action === 'confirm') {
    const draft = req.session.announceDraft;
    if (!draft) {
      flash(req, 'error', 'Nothing to send. Compose the message again.');
      return res.redirect('/admin/announce');
    }
    const client = getClient();
    if (!client) {
      flash(req, 'error', 'The bot is not connected, so nothing was sent. Try again shortly.');
      return res.redirect('/admin/announce');
    }

    delete req.session.announceDraft;

    const result = await broadcast(client, {
      title: draft.title,
      body: draft.body,
      everyone: draft.everyone,
      sentBy: req.session.user.id,
    });

    if (!result.ok) {
      flash(req, 'error', result.reason ?? 'The announcement could not be sent.');
      return res.redirect('/admin/announce');
    }

    flash(req, 'ok', `Sent to ${result.delivered} server(s). ` +
      `${result.skipped} skipped (no channel set)` +
      `${result.failed ? `, ${result.failed} failed` : ''}. ` +
      `${result.pinged ?? 0} were pinged with @everyone.`);
    return res.redirect('/admin/announce');
  }

  const valid = validate({ title: req.body.title, body: req.body.body });
  if (!valid.ok) {
    flash(req, 'error', valid.reason);
    return res.redirect('/admin/announce');
  }

  req.session.announceDraft = {
    title: valid.title,
    body: valid.body,
    everyone: !!req.body.everyone,
  };
  return res.redirect('/admin/announce');
});

function renderBlogAdmin(req, res, editing = null) {
  res.render('admin-blog', {
    title: editing ? 'Edit post' : 'Blog',
    posts: blog.listAll(100),
    editing,
    preview: editing ? renderPost(editing.body) : null,
    flash: takeFlash(req),
  });
}

router.get('/admin/blog', requireOwner, requireUnlocked, (req, res) => {
  renderBlogAdmin(req, res);
});

router.get('/admin/blog/:id', requireOwner, requireUnlocked, (req, res) => {
  const post = blog.byId(Number(req.params.id));
  if (!post) {
    flash(req, 'error', 'No such post.');
    return res.redirect('/admin/blog');
  }
  return renderBlogAdmin(req, res, post);
});

router.post('/admin/blog', requireOwner, requireUnlocked, async (req, res) => {
  const id = Number.parseInt(req.body.id, 10);
  const editing = Number.isFinite(id) ? blog.byId(id) : null;
  const actorId = req.session.user.id;

  if (req.body.action === 'delete') {
    if (!editing) {
      flash(req, 'error', 'No such post.');
      return res.redirect('/admin/blog');
    }
    blog.remove(editing.id);
    await record({
      actorId,
      action: 'blog_post_deleted',
      severity: 'info',
      detail: { slug: editing.slug, title: editing.title },
      mirror: false,
    }).catch(() => {});
    flash(req, 'ok', `Deleted "${editing.title}".`);
    return res.redirect('/admin/blog');
  }

  const valid = validatePost({
    title: req.body.title, summary: req.body.summary, body: req.body.body,
  });
  if (!valid.ok) {
    flash(req, 'error', valid.reason);
    return res.redirect(editing ? `/admin/blog/${editing.id}` : '/admin/blog');
  }

  const published = !!req.body.published;

  if (editing) {
    const updated = blog.update(editing.id, {
      title: valid.title, summary: valid.summary, body: valid.body, published,
    });
    await record({
      actorId,
      action: published ? 'blog_post_published' : 'blog_post_saved',
      severity: 'info',
      detail: { slug: updated.slug, title: updated.title, published },
      mirror: false,
    }).catch(() => {});
    flash(req, 'ok', published
      ? `"${updated.title}" is live at /blog/${updated.slug}.`
      : `Saved "${updated.title}" as a draft. Nothing is public yet.`);
    return res.redirect(`/admin/blog/${updated.id}`);
  }

  const slug = uniqueSlug(valid.title);
  const info = blog.create({
    slug, title: valid.title, summary: valid.summary, body: valid.body, published, authorId: actorId,
  });
  const newId = Number(info.lastInsertRowid);
  await record({
    actorId,
    action: published ? 'blog_post_published' : 'blog_post_created',
    severity: 'info',
    detail: { slug, title: valid.title, published },
    mirror: false,
  }).catch(() => {});
  flash(req, 'ok', published
    ? `Published. Live at /blog/${slug}.`
    : `Draft saved. Tick "published" when you want it public.`);
  return res.redirect(`/admin/blog/${newId}`);
});

router.use((err, req, res, next) => {
  log.error('dashboard error', { path: req.path, err: err.message });
  next(err);
});
