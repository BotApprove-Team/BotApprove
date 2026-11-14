/**
 * /verify, the web step of RaidProtector's verification.
 *
 * Mounted ahead of the session middleware on purpose, so visiting it never
 * creates a session, sets a cookie or writes a row. The link's token arrives
 * after the # and is posted by the page's script, so it is not in the URL the
 * server sees either. Nothing here logs who came by.
 *
 * This process checks the work. RaidProtector checks the token again and hands
 * out the role, because the internet-facing process is trusted to say the work
 * was done, never to say who passed.
 */
import express from 'express';
import { config } from '../../config.js';
import { openLink, challenge, checkWork } from '../../services/verifyLink.js';
import { completeVerification } from '../../services/raidprotector.js';

const SAY = {
  expired: 'This link has run out. Press Verify in Discord again for a fresh one.',
  bad_token: 'This is not a link RaidProtector gave out. Press Verify in Discord to get yours.',
  not_configured: 'Verification is not switched on for this site.',
  verification_off: 'This server has switched verification off, so there is nothing to finish. You can go back to Discord.',
  role_missing: 'The role this server gives has been deleted. Tell a moderator to run /verify setup again.',
  left_server: 'You are not in that server any more.',
  not_in_server: 'RaidProtector is no longer in that server.',
  cannot_assign: 'You passed, but RaidProtector could not give you the role. Tell a moderator to check that its role sits above the one it gives.',
  unreachable: 'You passed, but RaidProtector did not answer. Press Verify in Discord again in a minute.',
  work_expired: 'The check took too long. Reload the page and it will start again.',
  work_wrong: 'That did not check out. Reload the page and let it run again.',
};

export function verifyRouter({ cssVersion }) {
  const router = express.Router();
  const json = express.json({ limit: '4kb' });

  router.get('/verify', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.render('verify', {
      title: 'Checkpoint',
      product: 'raidprotector',
      // No sign-in button on a page that promises it never asks you to sign in.
      bareHead: true,
      cardTitle: 'RaidProtector checkpoint',
      cardDescription: 'One short check before you get into the server.',
      path: '/verify',
      indexable: false,
      user: null,
      isOwner: false,
      csrfToken: '',
      cssVersion,
      baseUrl: config.web.baseUrl,
      supportUrl: config.supportUrl,
      repoUrl: config.repoUrl,
      legalNotice: null,
      claudeVisitor: null,
      switchTo: null,
      flash: null,
    });
  });

  router.post('/verify/challenge', json, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const token = String(req.body?.token ?? '');
    const link = openLink(token);
    if (!link.ok) return res.status(400).json({ ok: false, message: SAY[link.reason] ?? SAY.bad_token });
    return res.json({ ok: true, challenge: challenge(token), expires: link.expires });
  });

  router.post('/verify/solve', json, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const token = String(req.body?.token ?? '');
    const link = openLink(token);
    if (!link.ok) return res.status(400).json({ ok: false, message: SAY[link.reason] ?? SAY.bad_token });

    const work = checkWork(token, req.body ?? {});
    if (!work.ok) {
      return res.status(400).json({
        ok: false,
        message: work.reason === 'expired' ? SAY.work_expired : SAY.work_wrong,
      });
    }

    const done = await completeVerification(token);
    if (!done.ok) return res.status(502).json({ ok: false, message: SAY.unreachable });
    if (!done.body?.ok) {
      return res.json({ ok: false, message: SAY[done.body?.reason] ?? SAY.unreachable });
    }
    return res.json({ ok: true, server: String(done.body.guildName ?? '').slice(0, 100) });
  });

  return router;
}
