import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(ROOT, 'src');

export const SEAL_PATH = path.join(ROOT, 'integrity.json');

function walk(dir, out = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function measure() {
  const files = {};
  for (const dir of [SRC, path.join(ROOT, 'scripts')]) {
    if (!fs.existsSync(dir)) continue;
    for (const full of walk(dir)) {
      files[path.relative(ROOT, full).split(path.sep).join('/')] = hashFile(full);
    }
  }
  for (const extra of ['package.json', 'package-lock.json']) {
    const full = path.join(ROOT, extra);
    if (fs.existsSync(full)) files[extra] = hashFile(full);
  }

  const root = crypto.createHash('sha256')
    .update(Object.entries(files).map(([f, h]) => `${f}:${h}`).join('\n'))
    .digest('hex');

  return { root, files };
}

export function readSeal(at = SEAL_PATH) {
  try {
    const parsed = JSON.parse(fs.readFileSync(at, 'utf8'));
    return parsed?.root && parsed?.files ? parsed : null;
  } catch {
    return null;
  }
}

export function compare(seal, current) {
  const changed = [];
  const added = [];
  const removed = [];

  for (const [file, hash] of Object.entries(current.files)) {
    if (!(file in seal.files)) added.push(file);
    else if (seal.files[file] !== hash) changed.push(file);
  }
  for (const file of Object.keys(seal.files)) {
    if (!(file in current.files)) removed.push(file);
  }

  return { ok: !changed.length && !added.length && !removed.length, changed, added, removed };
}

export function summarise(diff) {
  return [
    diff.changed.length ? `${diff.changed.length} changed` : null,
    diff.added.length ? `${diff.added.length} added` : null,
    diff.removed.length ? `${diff.removed.length} removed` : null,
  ].filter(Boolean).join(', ');
}

export function check() {
  const seal = readSeal();
  if (!seal) return { sealed: false };

  const current = measure();
  if (current.root === seal.root) return { sealed: true, ok: true, root: current.root };

  return { sealed: true, sealedAt: seal.sealedAt ?? null, ...compare(seal, current) };
}
