#!/usr/bin/env node
/**
 * Point-in-time snapshot of the database.
 *
 *   node scripts/backup.js
 *
 * VACUUM INTO takes a consistent, compacted copy of a live database without
 * stopping the bot. Copying the file directly cannot do that under WAL: the
 * -wal sidecar holds committed pages the .db file does not yet contain, so a
 * plain copy can silently lose the most recent approvals.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../src/config.js';

const KEEP_DAYS = Number.parseInt(process.env.BACKUP_KEEP_DAYS ?? '', 10) || 14;
const DIR = process.env.BACKUP_DIR || path.join(path.dirname(config.db.path), 'backups');

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

if (!fs.existsSync(config.db.path)) fail(`No database at ${config.db.path}`);

fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });

const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
const target = path.join(DIR, `botapprove-${stamp}.db`);

// VACUUM INTO refuses to write over an existing file, so a partial file left by
// a killed run would block every attempt after it rather than just its own.
if (fs.existsSync(target)) fs.rmSync(target);

// Opened read-write rather than readonly on purpose: a readonly connection to a
// WAL database has to initialise the -shm file, which it cannot do when no
// other process holds the database open. That would make the backup fail in
// exactly the case where it matters most, with the bot stopped.
const source = new Database(config.db.path, { fileMustExist: true });
try {
  source.prepare('VACUUM INTO ?').run(target);
} finally {
  source.close();
}

// Snapshots hold licence keys, whitelists and the full audit trail.
fs.chmodSync(target, 0o600);
const bytes = fs.statSync(target).size;

// Verified against the copy rather than the live database. A backup that cannot
// be opened is worse than none, because it is only discovered during a restore.
const copy = new Database(target, { readonly: true, fileMustExist: true });
let integrity;
try {
  integrity = copy.pragma('integrity_check', { simple: true });
} finally {
  copy.close();
}

if (integrity !== 'ok') {
  fs.rmSync(target, { force: true });
  fail(`Snapshot failed its integrity check and was discarded: ${integrity}`);
}

// Pruning runs only after a good snapshot exists, so a run that fails cannot
// take the older backups down with it.
const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
let pruned = 0;
for (const name of fs.readdirSync(DIR)) {
  if (!/^botapprove-.+\.db$/.test(name)) continue;
  const full = path.join(DIR, name);
  if (full === target) continue;
  if (fs.statSync(full).mtimeMs >= cutoff) continue;
  fs.rmSync(full, { force: true });
  pruned += 1;
}

const mib = (bytes / 1048576).toFixed(2);
console.log(`snapshot ok  ${target}  ${mib} MiB  kept ${KEEP_DAYS}d  pruned ${pruned}`);
