/**
 * Talks to the RaidProtector process over loopback.
 *
 * The two bots keep separate databases and separate system users on purpose,
 * so this asks RaidProtector for its state rather than opening its files. If
 * it is down, every call here returns a reason instead of throwing, and the
 * dashboard says so plainly rather than showing an empty page.
 */
import { config } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('raidprotector');

// Short on purpose. This sits in the path of a dashboard page load, and a bot
// that is not answering should cost the page a moment, not hang it.
const TIMEOUT_MS = 2500;

export function configured() {
  return Boolean(config.raidProtector.url && config.raidProtector.token);
}

async function call(method, path, body) {
  if (!configured()) return { ok: false, reason: 'not_configured' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(config.raidProtector.url + path, {
      method,
      headers: {
        authorization: `Bearer ${config.raidProtector.token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    const parsed = await res.json().catch(() => null);
    if (!res.ok) {
      log.warn('call rejected', { method, path, status: res.status });
      return { ok: false, reason: res.status === 401 ? 'bad_token' : 'refused', status: res.status, body: parsed };
    }
    return { ok: true, body: parsed };
  } catch (err) {
    const reason = err.name === 'AbortError' ? 'timeout' : 'unreachable';
    log.warn('call failed', { method, path, reason, err: err.message });
    return { ok: false, reason };
  } finally {
    clearTimeout(timer);
  }
}

export const health = () => call('GET', '/v1/health');
export const guildIds = () => call('GET', '/v1/guilds');
export const pushAccess = (allowed) => call('PUT', '/v1/access', { allowed, source: 'botapprove' });

/**
 * Tell RaidProtector which servers may use it during the beta.
 *
 * The whole list goes every time rather than a diff: a push that fails is
 * repaired by the next one instead of leaving a server wrongly on or off until
 * somebody notices. Licences live here, so this is the side that knows.
 */
export async function syncAccess(client, isLicensed) {
  if (!configured()) return { ok: false, reason: 'not_configured' };
  const ids = [...(client?.guilds?.cache?.keys() ?? [])].filter((id) => isLicensed(id));
  const result = await pushAccess(ids);
  if (result.ok) {
    const { granted = [], revoked = [] } = result.body ?? {};
    if (granted.length || revoked.length) {
      log.info('beta access synced', { allowed: ids.length, granted: granted.length, revoked: revoked.length });
    }
  }
  return result;
}
export const guildState = (guildId) => call('GET', `/v1/guild/${guildId}`);
export const updateSettings = (guildId, patch) => call('PATCH', `/v1/guild/${guildId}`, patch);
export const undoIncident = (incidentId, actorId) =>
  call('POST', `/v1/incident/${incidentId}/undo`, { actorId });
export const cancelBans = (incidentId, actorId) =>
  call('POST', `/v1/incident/${incidentId}/cancel-bans`, { actorId });

export const WHY = {
  not_configured: 'This BotApprove instance has not been pointed at a RaidProtector yet.',
  unreachable: 'RaidProtector is not answering. It may be restarting.',
  timeout: 'RaidProtector took too long to answer.',
  bad_token: 'RaidProtector refused the shared token. The two need reconfiguring.',
  refused: 'RaidProtector refused the request.',
};
