import crypto from 'node:crypto';
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { record } from '../services/securityService.js';

const log = createLogger('admin-auth');

const attempts = new Map();
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60_000;

function looksLikeHash(v) {
  return typeof v === 'string' && v.includes(':');
}

export function isConfigured() {
  return looksLikeHash(config.admin.passwordHash) && looksLikeHash(config.admin.passwordHash2);
}

export function verifyPassword(supplied, stage = 1) {
  const hash = stage === 2 ? config.admin.passwordHash2 : config.admin.passwordHash;
  if (!looksLikeHash(hash)) return false;
  const [salt, expected] = hash.split(':');
  if (!salt || !expected) return false;

  let derived;
  try {
    derived = crypto.scryptSync(String(supplied ?? ''), salt, 64).toString('hex');
  } catch {
    return false;
  }
  const a = Buffer.from(derived, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function currentStage(req) {
  const at = req.session?.adminStage1At;
  if (typeof at === 'number' && Date.now() - at < config.admin.stageTtlMs) return 2;
  return 1;
}

function resetStage(req) {
  if (req.session) delete req.session.adminStage1At;
}

export function isAdminUnlocked(req) {
  const until = req.session?.adminUnlockedUntil;
  return typeof until === 'number' && until > Date.now();
}

export function unlockRemaining(req) {
  if (!isAdminUnlocked(req)) return 0;
  return Math.max(0, Math.round((req.session.adminUnlockedUntil - Date.now()) / 60000));
}

function lockoutState(req) {
  const key = req.sessionID;
  const rec = attempts.get(key);
  if (!rec) return { locked: false, count: 0 };
  if (rec.until && rec.until > Date.now()) {
    return { locked: true, until: rec.until, count: rec.count };
  }
  if (rec.until && rec.until <= Date.now()) {
    attempts.delete(key);
    return { locked: false, count: 0 };
  }
  return { locked: false, count: rec.count };
}

export async function attemptUnlock(req, password) {
  const state = lockoutState(req);
  if (state.locked) {
    return { ok: false, reason: 'locked_out', minutes: Math.ceil((state.until - Date.now()) / 60000) };
  }
  if (!isConfigured()) return { ok: false, reason: 'not_configured' };

  const stage = currentStage(req);

  if (!verifyPassword(password, stage)) {
    const count = state.count + 1;
    attempts.set(req.sessionID, {
      count,
      until: count >= MAX_ATTEMPTS ? Date.now() + LOCKOUT_MS : null,
    });
    resetStage(req);

    log.alert('admin unlock failed', {
      userId: req.session?.user?.id, ip: req.ip, attempt: count, stage,
    });
    await record({
      actorId: req.session?.user?.id,
      action: 'admin_unlock_failed',
      severity: count >= MAX_ATTEMPTS ? 'critical' : 'high',
      detail: { attempt: count, stage, ip: req.ip },
      mirror: false,
    }).catch(() => {});

    return {
      ok: false,
      reason: count >= MAX_ATTEMPTS ? 'locked_out' : 'wrong_password',
      remaining: Math.max(0, MAX_ATTEMPTS - count),
      minutes: LOCKOUT_MS / 60000,
      restarted: stage === 2,
    };
  }

  if (stage === 1) {
    req.session.adminStage1At = Date.now();
    return {
      ok: false,
      reason: 'stage_two',
      seconds: Math.round(config.admin.stageTtlMs / 1000),
    };
  }

  attempts.delete(req.sessionID);
  resetStage(req);
  req.session.adminUnlockedUntil = Date.now() + config.admin.unlockTtlMs;

  log.info('admin unlocked', { userId: req.session?.user?.id });
  await record({
    actorId: req.session?.user?.id,
    action: 'admin_unlocked',
    severity: 'medium',
    detail: { minutes: config.admin.unlockTtlMs / 60000, ip: req.ip },
    mirror: false,
  }).catch(() => {});

  return { ok: true };
}

export async function lock(req) {
  delete req.session.adminUnlockedUntil;
  resetStage(req);
  await record({
    actorId: req.session?.user?.id, action: 'admin_locked', severity: 'info', mirror: false,
  }).catch(() => {});
}

export function requireUnlocked(req, res, next) {
  if (isAdminUnlocked(req)) return next();
  req.session.adminReturnTo = req.method === 'GET' ? req.originalUrl : '/admin';
  return res.redirect('/admin/unlock');
}
