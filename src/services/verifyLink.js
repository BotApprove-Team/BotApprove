/**
 * The web half of RaidProtector's verification: reading the link it hands out,
 * and the proof of work the page asks for.
 *
 * Both are stateless on purpose. The link is signed by RaidProtector with the
 * secret the two processes already share, and a challenge carries its own
 * expiry and an HMAC, so checking either needs nothing stored. That is what
 * lets the page have no session, no cookie and no database row per visitor.
 *
 * The work is bound to the link it was issued for. Without that, one solved
 * challenge could be replayed for a few hundred accounts inside its expiry,
 * which would make the whole exercise free for exactly the people it is for.
 */
import crypto from 'node:crypto';
import { config } from '../config.js';

const CHALLENGE_TTL_MS = 10 * 60_000;
// Roughly a second or two on a phone, much less on a laptop. Enough that a
// few hundred accounts cost something real, not so much that a person waits.
export const MAX_NUMBER = 250_000;

const secret = () => config.raidProtector.token;
const linkKey = (s) => crypto.createHash('sha256').update(`rp-verify-link:${s}`).digest();
const workKey = (s) => crypto.createHash('sha256').update(`rp-verify-work:${s}`).digest();
const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
const same = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));

/** The same check RaidProtector's verify.open() makes, with the same secret. */
export function openLink(token, { now = Date.now(), key = secret() } = {}) {
  if (!key) return { ok: false, reason: 'not_configured' };
  const parts = String(token ?? '').split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'bad_token' };
  const expected = crypto.createHmac('sha256', linkKey(key)).update(parts[0]).digest('base64url');
  if (!same(expected, parts[1])) return { ok: false, reason: 'bad_token' };
  let claims;
  try {
    claims = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'bad_token' };
  }
  if (!/^\d{5,25}$/.test(String(claims.g)) || !/^\d{5,25}$/.test(String(claims.u))
    || !Number.isFinite(claims.e)) {
    return { ok: false, reason: 'bad_token' };
  }
  if (now > claims.e) return { ok: false, reason: 'expired' };
  return { ok: true, guildId: claims.g, userId: claims.u, expires: claims.e };
}

const boundTo = (token) => sha256hex(`for:${token}`).slice(0, 32);

/**
 * A challenge in the shape ALTCHA popularised: find the number that, appended
 * to the salt, hashes to the challenge. The salt carries the expiry and which
 * link it belongs to, and the signature stops anyone writing their own.
 */
export function challenge(token, { now = Date.now(), key = secret(), max = MAX_NUMBER } = {}) {
  const salt = `${crypto.randomBytes(12).toString('hex')}?expires=${now + CHALLENGE_TTL_MS}&for=${boundTo(token)}`;
  const number = crypto.randomInt(0, max);
  const target = sha256hex(salt + number);
  return {
    algorithm: 'SHA-256',
    salt,
    challenge: target,
    maxnumber: max,
    signature: crypto.createHmac('sha256', workKey(key)).update(target).digest('hex'),
  };
}

export function checkWork(token, { salt, challenge: target, signature, number },
  { now = Date.now(), key = secret() } = {}) {
  if (typeof salt !== 'string' || typeof target !== 'string' || typeof signature !== 'string') {
    return { ok: false, reason: 'malformed' };
  }
  if (!Number.isInteger(number) || number < 0 || number > MAX_NUMBER) return { ok: false, reason: 'malformed' };
  const params = new URLSearchParams(salt.split('?')[1] ?? '');
  const expires = Number(params.get('expires'));
  if (!Number.isFinite(expires) || now > expires) return { ok: false, reason: 'expired' };
  if (params.get('for') !== boundTo(token)) return { ok: false, reason: 'other_link' };
  const expected = crypto.createHmac('sha256', workKey(key)).update(target).digest('hex');
  if (!same(expected, signature)) return { ok: false, reason: 'forged' };
  if (sha256hex(salt + number) !== target) return { ok: false, reason: 'wrong_answer' };
  return { ok: true };
}
