import imageSize from 'image-size';
import { createLogger } from '../logger.js';

const log = createLogger('image-probe');

const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 8_000;

async function download(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ac.signal, redirect: 'follow' });
    if (!res.ok) return { ok: false, reason: `http_${res.status}` };

    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > MAX_BYTES) return { ok: false, reason: 'too_large' };

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.byteLength > MAX_BYTES) return { ok: false, reason: 'too_large' };

    return {
      ok: true,
      buffer,
      contentType: res.headers.get('content-type') ?? 'application/octet-stream',
    };
  } catch (err) {
    return { ok: false, reason: err.name === 'AbortError' ? 'timeout' : 'network_error', err };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeAsset(url, { kind }) {
  if (!url) return { kind, present: false };

  const dl = await download(url);
  if (!dl.ok) {
    log.warn('asset download failed', { kind, url, reason: dl.reason });
    return { kind, present: true, error: dl.reason };
  }

  try {
    const dims = imageSize(dl.buffer);
    return {
      kind,
      present: true,
      width: dims.width,
      height: dims.height,
      type: dims.type,
      bytes: dl.buffer.byteLength,
      buffer: dl.buffer,
      contentType: dl.contentType,
    };
  } catch (err) {
    log.warn('asset header unreadable', { kind, url, err: err.message });
    return { kind, present: true, error: 'unreadable_header', bytes: dl.buffer.byteLength };
  }
}

export async function probeUserAssets(user, thresholdPx) {
  const avatarUrl = user.avatar
    ? user.avatarURL({ size: 4096, extension: 'png', forceStatic: true })
    : null;
  const bannerUrl = user.banner
    ? user.bannerURL({ size: 4096, extension: 'png', forceStatic: true })
    : null;

  const [avatar, banner] = await Promise.all([
    probeAsset(avatarUrl, { kind: 'avatar' }),
    probeAsset(bannerUrl, { kind: 'banner' }),
  ]);

  const flags = [];
  for (const asset of [avatar, banner]) {
    if (!asset.present) continue;
    if (asset.error) {
      flags.push({ kind: asset.kind, level: 'unknown', reason: asset.error });
      continue;
    }
    if (asset.width < thresholdPx) {
      flags.push({
        kind: asset.kind,
        level: 'low_res',
        width: asset.width,
        height: asset.height,
      });
    }
  }

  return { avatar, banner, flags, thresholdPx, defaultAvatar: !user.avatar };
}
