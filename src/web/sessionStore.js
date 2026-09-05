import session from 'express-session';
import { db } from '../db/index.js';
import { createLogger } from '../logger.js';

const log = createLogger('session-store');

export class SqliteStore extends session.Store {
  constructor({ ttlMs = 7 * 24 * 3600_000 } = {}) {
    super();
    this.ttlMs = ttlMs;
    this.stmts = {
      get: db.prepare('SELECT data, expires_at FROM web_sessions WHERE sid = ?'),
      set: db.prepare(`INSERT INTO web_sessions (sid, data, expires_at) VALUES (?, ?, ?)
                       ON CONFLICT(sid) DO UPDATE SET data = excluded.data,
                                                      expires_at = excluded.expires_at`),
      destroy: db.prepare('DELETE FROM web_sessions WHERE sid = ?'),
      touch: db.prepare('UPDATE web_sessions SET expires_at = ? WHERE sid = ?'),
      sweep: db.prepare('DELETE FROM web_sessions WHERE expires_at <= ?'),
    };

    const timer = setInterval(() => {
      try {
        const { changes } = this.stmts.sweep.run(Date.now());
        if (changes) log.debug('expired sessions swept', { changes });
      } catch (err) {
        log.warn('session sweep failed', { err: err.message });
      }
    }, 3600_000);
    timer.unref?.();
  }

  #expiry(sess) {
    const cookieExpiry = sess?.cookie?.expires ? new Date(sess.cookie.expires).getTime() : null;
    return cookieExpiry ?? Date.now() + this.ttlMs;
  }

  get(sid, cb) {
    try {
      const row = this.stmts.get.get(sid);
      if (!row) return cb(null, null);
      if (row.expires_at <= Date.now()) {
        this.stmts.destroy.run(sid);
        return cb(null, null);
      }
      return cb(null, JSON.parse(row.data));
    } catch (err) {
      return cb(err);
    }
  }

  set(sid, sess, cb) {
    try {
      this.stmts.set.run(sid, JSON.stringify(sess), this.#expiry(sess));
      return cb(null);
    } catch (err) {
      return cb(err);
    }
  }

  destroy(sid, cb) {
    try {
      this.stmts.destroy.run(sid);
      return cb(null);
    } catch (err) {
      return cb(err);
    }
  }

  touch(sid, sess, cb) {
    try {
      this.stmts.touch.run(this.#expiry(sess), sid);
      return cb(null);
    } catch (err) {
      return cb(err);
    }
  }
}
