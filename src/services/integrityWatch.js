import { check, summarise, SEAL_PATH } from './integrity.js';
import { enter, state } from './safeMode.js';
import { createLogger } from '../logger.js';

const log = createLogger('integrity');

export async function enforceIntegrity(reason = 'periodic') {
  let result;
  try {
    result = check();
  } catch (err) {
    log.error('integrity check failed to run', { reason, err: err.message });
    return { ok: false, error: err.message };
  }

  if (!result.sealed) {
    if (reason === 'startup') {
      log.warn('no seal on disk, code is not being checked', { path: SEAL_PATH });
    }
    return { sealed: false };
  }

  if (result.ok) {
    if (reason === 'startup') log.info('code matches the seal', { root: result.root });
    return { sealed: true, ok: true };
  }

  const touched = [...result.changed, ...result.added, ...result.removed];
  log.alert('code does not match the seal', {
    reason,
    sealedAt: result.sealedAt,
    changed: result.changed.slice(0, 20),
    added: result.added.slice(0, 20),
    removed: result.removed.slice(0, 20),
  });

  if (state()) return { sealed: true, ok: false, ...result, alreadySafe: true };

  await enter({
    reason: `Code does not match the seal taken at deploy (${summarise(result)}). `
      + `First difference: ${touched[0] ?? 'unknown'}.`,
    source: 'integrity',
  }).catch((err) => log.error('could not enter safe mode', { err: err.message }));

  return { sealed: true, ok: false, ...result, entered: true };
}
