import { instanceState } from '../db/queries.js';
import { record } from './securityService.js';
import { createLogger } from '../logger.js';

const log = createLogger('safe-mode');

const KEY = 'safe_mode';

export const CAPABILITIES = ['act_on_member', 'broadcast', 'lockdown'];

export const WITHHELD = {
  act_on_member: 'Stripping roles, quarantining, kicking, banning and timing out people',
  broadcast: 'Announcements, giveaway invitations and any message sent to every server',
  lockdown: 'Locking a server down',
};

export const KEPT = [
  'Bots that join are still kicked and held for approval',
  'Approval cards still post, and the buttons still work',
  'Keyword blocking, image checks and the audit trail all still run',
];

export function state() {
  const raw = instanceState.get(KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && parsed.since ? parsed : null;
  } catch {
    return null;
  }
}

export function isActive() {
  return state() !== null;
}

export function allows(capability) {
  if (!CAPABILITIES.includes(capability)) return true;
  return !isActive();
}

export function blocked(capability, context = {}) {
  if (allows(capability)) return false;
  log.alert('refused while in safe mode', { capability, ...context });
  return true;
}

export async function enter({ reason, actorId, source = 'operator' }) {
  const already = state();
  if (already) return { ok: false, reason: 'already_active', state: already };

  const next = { since: Date.now(), reason: reason || 'no reason given', actorId: actorId ?? null, source };
  instanceState.set(KEY, JSON.stringify(next));

  log.alert('safe mode entered', next);
  await record({
    actorId,
    action: 'safe_mode_entered',
    severity: 'critical',
    detail: { reason: next.reason, source },
    mirror: false,
  }).catch(() => {});

  return { ok: true, state: next };
}

export async function leave(actorId) {
  const current = state();
  if (!current) return { ok: false, reason: 'not_active' };

  instanceState.set(KEY, '');

  const heldFor = Date.now() - current.since;
  log.alert('safe mode left', { actorId, heldForMs: heldFor });
  await record({
    actorId,
    action: 'safe_mode_left',
    severity: 'high',
    detail: { held_for_ms: heldFor, entered_reason: current.reason },
    mirror: false,
  }).catch(() => {});

  return { ok: true, heldFor };
}
