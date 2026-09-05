#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';

if (!process.env.DATABASE_PATH) {
  console.error('Refusing to run against the default database. Set DATABASE_PATH.');
  process.exit(1);
}
for (const suffix of ['', '-wal', '-shm']) {
  fs.rmSync(config.db.path + suffix, { force: true });
}
fs.mkdirSync(path.dirname(config.db.path), { recursive: true });

const { whitelist, keywords, reinviteTokens, guildConfig, securityLog, nukeRegistry,
        knownNukeBots, nukeIncidents } = await import('../src/db/queries.js');
const { matchKeyword, seedDefaultKeywords, addToWhitelist, issueReinviteToken, consumeReinviteToken } =
  await import('../src/services/securityService.js');
const { resolveEntitlement, generateLicenseKey, redeemLicenseKey, markBillingLapse } =
  await import('../src/services/entitlementService.js');
const { hasFeature, featureState, activeFeatureUsage } =
  await import('../src/services/featureService.js');
const { confirmNukeBot, isConfirmedNukeBot, unconfirmNukeBot,
        addKnownNukeBot, removeKnownNukeBot, isKnownNukeBot, INVITER_ACTIONS } =
  await import('../src/services/nukeDefense.js');
const { validateNickname } = await import('../src/services/nicknameService.js');

const GUILD = '111111111111111111';
const BOT = '222222222222222222';
const ADMIN = '333333333333333333';

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}` +
    (ok ? '' : `\n         expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`));
}

console.log('\n- keyword blocklist -');
guildConfig.get(GUILD);
seedDefaultKeywords(GUILD);
check('defaults seeded', keywords.list(GUILD).length, config.defaults.keywords.length);
check('seeding is once-only', seedDefaultKeywords(GUILD), false);
check('matches case-insensitively', matchKeyword(GUILD, 'Server SECURITY Bot'), 'security');
check('matches a substring', matchKeyword(GUILD, 'antinuke-raid-guard'), 'raid');
check('clean name does not match', matchKeyword(GUILD, 'Groovy'), null);

console.log('\n- keyword gate runs before the whitelist -');
await addToWhitelist(GUILD, BOT, ADMIN);
check('bot is whitelisted', whitelist.has(GUILD, BOT), true);
check('a whitelisted bot with a bad name still matches',
  matchKeyword(GUILD, 'verify-helper'), 'verify');

console.log('\n- re-invite tokens -');
await issueReinviteToken(GUILD, BOT, ADMIN);
check('token is live', !!reinviteTokens.peek(GUILD, BOT), true);
const first = await consumeReinviteToken(GUILD, BOT);
check('first consume succeeds', first.consumed, true);
const replay = await consumeReinviteToken(GUILD, BOT);
check('replay is refused', { consumed: replay.consumed, reason: replay.reason },
  { consumed: false, reason: 'no_token' });
check('row is gone, not flagged', reinviteTokens.peek(GUILD, BOT), undefined);

reinviteTokens.issue(GUILD, BOT, ADMIN, -1000);
check('expired token is not visible', reinviteTokens.peek(GUILD, BOT), undefined);
const stale = await consumeReinviteToken(GUILD, BOT);
check('expired token cannot be spent', { consumed: stale.consumed, reason: stale.reason },
  { consumed: false, reason: 'expired' });
check('expired token is deleted on contact', reinviteTokens.peek(GUILD, BOT), undefined);

const OTHER_BOT = '444444444444444444';
await issueReinviteToken(GUILD, BOT, ADMIN);
const wrongBot = await consumeReinviteToken(GUILD, OTHER_BOT);
check('token is scoped to one bot id', wrongBot.consumed, false);
const wrongGuild = await consumeReinviteToken('999999999999999999', BOT);
check('token is scoped to one guild', wrongGuild.consumed, false);
check('the real token survives a wrong-target attempt', !!reinviteTokens.peek(GUILD, BOT), true);

console.log('\n- nickname validation -');
check('empty clears', validateNickname('  '), { ok: true, value: null });
check('normal name accepted', validateNickname('Gatekeeper'), { ok: true, value: 'Gatekeeper' });
check('over-long rejected', validateNickname('x'.repeat(33)).ok, false);
check('invite link rejected', validateNickname('join discord.gg/x').ok, false);

console.log('\n- entitlements -');
config.paywall.enabled = false;
check('paywall off means licensed', resolveEntitlement(GUILD).licensed, true);
config.paywall.enabled = true;
check('paywall on, no entitlement means unlicensed', resolveEntitlement(GUILD).state, 'never_licensed');
const key = generateLicenseKey({ durationDays: 30, maxGuilds: 1, note: 'smoke' });
check('key has the expected shape', /^BA-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}$/.test(key), true);
const redeemed = await redeemLicenseKey(GUILD, key, ADMIN);
check('key redeems', redeemed.ok, true);
check('guild is now licensed', resolveEntitlement(GUILD).licensed, true);
const second = await redeemLicenseKey('888888888888888888', key, ADMIN);
check('seat limit is enforced', { ok: second.ok, reason: second.reason },
  { ok: false, reason: 'seats_exhausted' });
check('key is stored only as a hash',
  !JSON.stringify((await import('../src/db/queries.js')).licenseKeys.all()).includes(key.slice(3)), true);
config.paywall.enabled = false;

console.log('\n- confirmed nuke bots -');
const NUKE_BOT = '555555555555555555';
check('unknown bot is not confirmed', isConfirmedNukeBot(GUILD, NUKE_BOT), false);
await confirmNukeBot(GUILD, NUKE_BOT, { botTag: 'nuker#0001', confirmedBy: ADMIN, reason: 'mass ban' });
check('confirmed after marking', isConfirmedNukeBot(GUILD, NUKE_BOT), true);
check('confirmation is per-guild', isConfirmedNukeBot('999999999999999999', NUKE_BOT), false);
await addToWhitelist(GUILD, NUKE_BOT, ADMIN);
await issueReinviteToken(GUILD, NUKE_BOT, ADMIN);
check('still confirmed despite a whitelist row', isConfirmedNukeBot(GUILD, NUKE_BOT), true);
check('still confirmed despite a live token', isConfirmedNukeBot(GUILD, NUKE_BOT), true);
check('withdrawal works', await unconfirmNukeBot(GUILD, NUKE_BOT, ADMIN), true);
await confirmNukeBot(GUILD, NUKE_BOT, { confirmedBy: ADMIN, reason: 'restored for later checks' });

console.log('\n- free vs premium gating -');
config.paywall.enabled = true;
const UNPAID = '777777777777777777';
guildConfig.get(UNPAID);
seedDefaultKeywords(UNPAID);
check('core gate is free', hasFeature(UNPAID, 'core_gate'), true);
check('audit trail is free', hasFeature(UNPAID, 'audit_trail'), true);
check('tamper detection is free', hasFeature(UNPAID, 'tamper_detection'), true);
check('custom keywords are premium', hasFeature(UNPAID, 'custom_keywords'), false);
check('auto-ban is premium', hasFeature(UNPAID, 'auto_ban_inviters'), false);
check('licensed guild keeps premium', hasFeature(GUILD, 'custom_keywords'), true);

keywords.add(UNPAID, 'giveaway', ADMIN);
check('default keyword blocks when unpaid', matchKeyword(UNPAID, 'raid-helper'), 'raid');
check('saved custom keyword is still enforced when unpaid',
  matchKeyword(UNPAID, 'free giveaway bot'), 'giveaway');
check('custom keyword enforced when paid', (() => {
  keywords.add(GUILD, 'giveaway', ADMIN);
  return matchKeyword(GUILD, 'free giveaway bot');
})(), 'giveaway');

const unpaidState = featureState(UNPAID);
check('every free feature reports enabled',
  unpaidState.filter((f) => f.tier === 'free').every((f) => f.enabled), true);
check('every premium feature reports disabled',
  unpaidState.filter((f) => f.tier === 'premium').every((f) => !f.enabled), true);

console.log('\n- known nuke bot database -');
const KNOWN = '666666666666666666';
await addKnownNukeBot({ botId: KNOWN, botTag: 'wrecker#9', reason: 'mass ban', addedBy: ADMIN });
check('listed in the shared db', knownNukeBots.has(KNOWN), true);
check('licensed guild consults the db', isKnownNukeBot(GUILD, KNOWN), true);
check('unpaid guild does NOT consult the db', isKnownNukeBot(UNPAID, KNOWN), false);
check('unlisted bot is not a hit', isKnownNukeBot(GUILD, '123123123123123123'), false);
check('inviter actions are the expected set', INVITER_ACTIONS, ['none', 'kick', 'ban']);
check('default inviter action is kick', guildConfig.get(GUILD).nuke_inviter_action, 'kick');

const inc = nukeIncidents.create({
  guildId: GUILD, botId: KNOWN, botTag: 'wrecker#9', inviterId: '444444444444444444',
  inviterTag: 'someone#1', botAction: 'banned', inviterAction: 'kick',
});
const incId = Number(inc.lastInsertRowid);
check('incident starts pending', nukeIncidents.byId(incId).resolution, 'pending');
check('first resolve wins', !!nukeIncidents.resolve(incId, 'ban', ADMIN), true);
check('second resolve loses', nukeIncidents.resolve(incId, 'kick', ADMIN), null);
check('resolution is recorded', nukeIncidents.byId(incId).resolution, 'ban');
check('removal from the shared db works', await removeKnownNukeBot(KNOWN, ADMIN), true);

console.log('\n- lapse reasons -');
await markBillingLapse(GUILD, 'payment_failed');
check('payment failure unlicenses', resolveEntitlement(GUILD).licensed, false);
check('reason is recorded',
  (await import('../src/db/queries.js')).entitlements.get(GUILD).lapse_reason, 'payment_failed');
await markBillingLapse(GUILD, 'cancelled');
check('cancellation is recorded',
  (await import('../src/db/queries.js')).entitlements.get(GUILD).lapse_reason, 'cancelled');
let rejected = false;
try { await markBillingLapse(GUILD, 'because-i-said-so'); } catch { rejected = true; }
check('unknown lapse reason is rejected', rejected, true);

const usage = activeFeatureUsage({
  cfg: { nickname: 'Gatekeeper', notify_via_dm: 1, log_channel_id: '1', auto_ban_nuke_inviters: 1 },
  customKeywordCount: 2,
  nukeCount: 1,
});
check('downgrade notice names what was in use',
  ['custom_keywords', 'custom_nickname', 'auto_ban_inviters', 'dm_alerts', 'log_channel', 'image_analysis']
    .every((k) => usage.some((f) => f.key === k)), true);
config.paywall.enabled = false;

console.log('\n- impersonation detection -');
const { normalise, distance, check: checkImpersonation } =
  await import('../src/services/impersonation.js');
const KNOWN_NAMES = [{ botId: '999999999999999999', name: 'Dyno' }];
check('digit substitution folds away', normalise('Dyn0'), normalise('Dyno'));
check('capital I reads as lowercase l', distance(normalise('CarI-bot'), normalise('Carl-bot')), 0);
check('cyrillic lookalikes fold to latin',
  distance(normalise('арргоvе'), normalise('approve')) <= 1, true);
check('unrelated names stay far apart', distance(normalise('Dyno'), normalise('Groovy')) > 3, true);

const lookalike = checkImpersonation(GUILD, {
  botId: BOT, username: 'Dyn0', knownNames: KNOWN_NAMES,
});
check('a lookalike is flagged', !!lookalike?.matches.length, true);
check('flagged as visually identical', lookalike.matches[0].exact, true);
check('an unrelated name is not flagged',
  checkImpersonation(GUILD, { botId: BOT, username: 'Groovy', knownNames: KNOWN_NAMES }), null);
check('a bot never impersonates itself', checkImpersonation(GUILD, {
  botId: KNOWN_NAMES[0].botId, username: 'Dyno', knownNames: KNOWN_NAMES,
}), null);
guildConfig.set(GUILD, { impersonation_check: 0 });
check('the check honours being switched off',
  checkImpersonation(GUILD, { botId: BOT, username: 'Dyn0', knownNames: KNOWN_NAMES }), null);
guildConfig.set(GUILD, { impersonation_check: 1 });

console.log('\n- permission drift -');
const { PermissionsBitField } = await import('discord.js');
const { baseline, checkBot } = await import('../src/services/driftWatch.js');
const fakeMember = (perms) => ({
  id: BOT,
  guild: { id: GUILD },
  client: { user: { id: '888888888888888888' } },
  user: { bot: true, tag: 'approved#0001' },
  permissions: new PermissionsBitField(perms),
});

baseline(fakeMember(['SendMessages']));
check('baseline recorded at approval time',
  JSON.parse((await import('../src/db/queries.js')).botPermissions.get(GUILD, BOT).dangerous), []);
check('no change means no alert', await checkBot(fakeMember(['SendMessages'])), null);

const escalated = await checkBot(fakeMember(['SendMessages', 'Administrator']));
check('gaining Administrator alerts', escalated?.alerted, true);
check('the gain is named', escalated.gained, ['Administrator']);
check('server control is critical', escalated.critical, true);
check('the same state does not alert twice',
  await checkBot(fakeMember(['SendMessages', 'Administrator'])), null);
check('losing a permission is silent',
  await checkBot(fakeMember(['SendMessages'])), null);
check('an unapproved bot is not tracked',
  await checkBot({ ...fakeMember([]), id: '777777777777777777' }), null);

console.log('\n- approval quorum -');
const { approvalVotes } = await import('../src/db/queries.js');
const VOTE = 4242;
approvalVotes.clear(VOTE);
approvalVotes.cast(VOTE, 'approver-a', 'approve');
check('a vote is counted', approvalVotes.countFor(VOTE, 'approve'), 1);
approvalVotes.cast(VOTE, 'approver-a', 'approve');
check('the same approver cannot vote twice', approvalVotes.countFor(VOTE, 'approve'), 1);
approvalVotes.cast(VOTE, 'approver-b', 'approve');
check('a second approver reaches two', approvalVotes.countFor(VOTE, 'approve'), 2);
approvalVotes.cast(VOTE, 'approver-a', 'deny');
check('changing a vote moves it', approvalVotes.countFor(VOTE, 'approve'), 1);
check('and lands on the other side', approvalVotes.countFor(VOTE, 'deny'), 1);
approvalVotes.clear(VOTE);
check('clearing removes every vote', approvalVotes.list(VOTE).length, 0);

console.log('\n- audit trail -');
const logs = securityLog.recent(GUILD, 200);
check('every action was logged', logs.length > 0, true);
const { db } = await import('../src/db/queries.js');
const actions = new Set(
  db.prepare('SELECT action FROM security_log').all().map((l) => l.action),
);
for (const a of ['whitelist_add', 'token_issue', 'token_consume', 'token_expired',
  'license_redeemed', 'nuke_bot_confirmed', 'nuke_bot_unconfirmed', 'billing_lapse',
  'known_nuke_bot_added', 'known_nuke_bot_removed', 'bot_permission_drift']) {
  check(`logged: ${a}`, actions.has(a), true);
}

console.log(`\n${failures ? `${failures} check(s) failed` : 'all checks passed'}\n`);
process.exit(failures ? 1 : 0);
