import { PermissionsBitField } from 'discord.js';
import { guildConfig } from '../db/queries.js';
import { record } from './securityService.js';
import { hasFeature } from './featureService.js';
import { createLogger } from '../logger.js';

const log = createLogger('nickname');

export const NICKNAME_MAX = 32;

export function validateNickname(input) {
  if (input === null || input === undefined || String(input).trim() === '') {
    return { ok: true, value: null };
  }
  const value = String(input).trim();
  if (value.length > NICKNAME_MAX) {
    return { ok: false, reason: `Nicknames are at most ${NICKNAME_MAX} characters.` };
  }
  if (/[@#:]|```|discord\.gg/i.test(value)) {
    return { ok: false, reason: 'Nickname cannot contain @, #, :, backticks or invite links.' };
  }
  return { ok: true, value };
}

export async function applyNickname(guild) {
  const cfg = guildConfig.get(guild.id);
  const desired = cfg.nickname;
  if (desired === null || desired === undefined) return { ok: true, skipped: 'not_configured' };

  if (!hasFeature(guild.id, 'custom_nickname')) {
    log.info('nickname not re-applied, premium inactive', { guildId: guild.id });
    return { ok: true, skipped: 'feature_disabled' };
  }

  const me = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
  if (!me) return { ok: false, reason: 'self_member_unavailable' };
  if (me.nickname === desired) return { ok: true, skipped: 'already_set' };

  if (!me.permissions.has(PermissionsBitField.Flags.ChangeNickname)) {
    log.warn('missing Change Nickname permission', { guildId: guild.id });
    return { ok: false, reason: 'missing_permission' };
  }

  try {
    await me.setNickname(desired, 'BotApprove: nickname set from dashboard');
    return { ok: true, applied: desired };
  } catch (err) {
    log.warn('setNickname failed', { guildId: guild.id, err: err.message });
    return { ok: false, reason: err.message };
  }
}

export async function setNickname(guild, input, actorId) {
  if (!hasFeature(guild.id, 'custom_nickname')) {
    return { ok: false, reason: 'premium_required' };
  }

  const valid = validateNickname(input);
  if (!valid.ok) return valid;

  const previous = guildConfig.get(guild.id).nickname;
  guildConfig.set(guild.id, { nickname: valid.value });

  const applied = await applyNickname(guild);

  if (valid.value === null) {
    const me = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
    await me?.setNickname(null, 'BotApprove: nickname cleared from dashboard').catch(() => {});
  }

  await record({
    guildId: guild.id,
    actorId,
    action: 'nickname_set',
    severity: 'info',
    detail: { from: previous ?? null, to: valid.value, applied: applied.ok },
    mirror: false,
  });

  return { ok: true, value: valid.value, applied };
}
