import crypto from 'node:crypto';
import { Router } from 'express';
import { PermissionsBitField } from 'discord.js';
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { getClient } from '../bot/clientRef.js';
import { approverRoles } from '../db/queries.js';

const log = createLogger('web-auth');

const DISCORD_API = 'https://discord.com/api/v10';
const SCOPES = ['identify', 'guilds'];
const redirectUri = `${config.web.baseUrl}/auth/callback`;

export const router = Router();

router.get('/login', (req, res) => {
  const state = crypto.randomBytes(24).toString('hex');
  req.session.oauthState = state;
  req.session.returnTo = typeof req.query.next === 'string' && req.query.next.startsWith('/')
    ? req.query.next
    : '/guilds';

  const url = new URL('https://discord.com/oauth2/authorize');
  url.searchParams.set('client_id', config.discord.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPES.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('prompt', 'none');

  res.redirect(url.toString());
});

router.get('/auth/callback', async (req, res) => {
  const { code, state } = req.query;
  const expected = req.session.oauthState;
  delete req.session.oauthState;

  if (!code || !state || !expected || state !== expected) {
    log.warn('oauth state mismatch', { ip: req.ip });
    return res.status(400).render('error', {
      title: 'Login failed',
      message: 'The login request could not be verified. Start again from the home page.',
    });
  }

  try {
    const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.discord.clientId,
        client_secret: config.discord.clientSecret,
        grant_type: 'authorization_code',
        code: String(code),
        redirect_uri: redirectUri,
      }),
    });
    if (!tokenRes.ok) throw new Error(`token exchange failed: ${tokenRes.status}`);
    const token = await tokenRes.json();

    const authed = { Authorization: `Bearer ${token.access_token}` };
    const [user, guilds] = await Promise.all([
      fetch(`${DISCORD_API}/users/@me`, { headers: authed }).then((r) => r.json()),
      fetch(`${DISCORD_API}/users/@me/guilds`, { headers: authed }).then((r) => r.json()),
    ]);

    req.session.user = {
      id: user.id,
      username: user.username,
      globalName: user.global_name ?? null,
      avatar: user.avatar,
    };
    req.session.guilds = (Array.isArray(guilds) ? guilds : []).map((g) => ({
      id: g.id,
      name: g.name,
      icon: g.icon,
      owner: !!g.owner,
      permissions: String(g.permissions ?? '0'),
    }));
    req.session.loginAt = Date.now();

    log.info('user logged in', { userId: user.id, guilds: req.session.guilds.length });

    const next = req.session.returnTo ?? '/guilds';
    delete req.session.returnTo;
    return res.redirect(next);
  } catch (err) {
    log.error('oauth callback failed', { err: err.message });
    return res.status(502).render('error', {
      title: 'Login failed',
      message: 'Discord did not complete the login. Try again in a moment.',
    });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

export function requireLogin(req, res, next) {
  if (req.session?.user) return next();
  return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
}

export const isInstanceOwner = (userId) => config.ownerIds.includes(userId);

export async function resolveGuildAccess(userId, guildId, { elevated = false } = {}) {
  if (isInstanceOwner(userId) && elevated) {
    const client = getClient();
    const guild = client?.guilds.cache.get(guildId);
    if (!guild) return { allowed: false, reason: 'bot_not_in_guild' };
    return { allowed: true, guild, via: 'instance_owner', canApprove: true, canConfigure: true };
  }

  const client = getClient();
  const guild = client?.guilds.cache.get(guildId);
  if (!guild) return { allowed: false, reason: 'bot_not_in_guild' };

  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return { allowed: false, reason: 'not_a_member' };

  const canConfigure = member.permissions.has(PermissionsBitField.Flags.ManageGuild);
  const roleIds = approverRoles.list(guildId);
  const isApprover = canConfigure || roleIds.some((id) => member.roles.cache.has(id));

  if (!isApprover) return { allowed: false, reason: 'not_an_approver' };

  return { allowed: true, guild, member, canApprove: true, canConfigure, via: 'guild_permissions' };
}

export function requireGuildAccess(level = 'approve') {
  return async (req, res, next) => {
    const { isAdminUnlocked } = await import('./adminAuth.js');
    const access = await resolveGuildAccess(req.session.user.id, req.params.guildId, {
      elevated: isAdminUnlocked(req),
    });
    if (!access.allowed) {
      return res.status(403).render('error', {
        title: 'No access',
        message: {
          bot_not_in_guild: 'BotApprove is not in that server.',
          not_a_member: 'You are not a member of that server.',
          not_an_approver: 'You need Manage Server or an approver role in that server.'
            + (isInstanceOwner(req.session.user.id)
              ? ' As the instance operator you can unlock cross-server access at /admin/unlock.'
              : ''),
        }[access.reason] ?? 'You cannot access that server.',
      });
    }
    if (level === 'configure' && !access.canConfigure) {
      return res.status(403).render('error', {
        title: 'Not permitted',
        message: 'Changing settings requires the Manage Server permission.',
      });
    }
    req.guildAccess = access;
    return next();
  };
}
