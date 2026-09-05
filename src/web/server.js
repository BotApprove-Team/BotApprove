import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import session from 'express-session';
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { SqliteStore } from './sessionStore.js';
import { router as authRouter, requireLogin, isInstanceOwner } from './auth.js';
import { router as dashboardRouter } from './routes/dashboard.js';
import { FEATURES } from '../services/featureService.js';
import { blog } from '../db/queries.js';
import { render as renderPost } from '../services/blogService.js';
import {
  constructEvent, handleEvent, isEnabled as stripeEnabled, availablePlans,
  lifetimeAvailability,
} from '../services/stripeService.js';

const log = createLogger('web');

function assetVersion() {
  try {
    const dir = path.join(config.root, 'src/web/public');
    const hash = crypto.createHash('sha256');
    for (const name of ['style.css', 'theme.js', 'icon.svg']) {
      hash.update(fs.readFileSync(path.join(dir, name)));
    }
    return hash.digest('hex').slice(0, 10);
  } catch {
    return String(Date.now());
  }
}

export function createApp() {
  const app = express();

  app.set('trust proxy', config.web.trustProxy);
  app.set('view engine', 'ejs');
  app.set('views', path.join(config.root, 'src/web/views'));
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; " +
      "img-src 'self' https://cdn.discordapp.com https://avatars.githubusercontent.com data:; " +
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src https://fonts.gstatic.com; " +
      "script-src 'self'; form-action 'self'; " +
      "frame-ancestors 'none'; base-uri 'none'",
    );
    next();
  });

  app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
    if (!stripeEnabled()) return res.status(503).send('stripe not configured');

    let event;
    try {
      event = constructEvent(req.body, req.headers['stripe-signature']);
    } catch (err) {
      log.warn('stripe signature rejected', { err: err.message, ip: req.ip });
      return res.status(400).send(`signature verification failed: ${err.message}`);
    }

    res.json({ received: true });

    try {
      const result = await handleEvent(event);
      log.info('stripe event', { type: event.type, id: event.id, ...result });
    } catch (err) {
      log.error('stripe handler failed', { type: event.type, id: event.id, err: err.message });
    }
    return undefined;
  });

  app.use(express.urlencoded({ extended: false, limit: '32kb' }));
  const cssVersion = assetVersion();
  app.use('/static', express.static(path.join(config.root, 'src/web/public'), {
    maxAge: '30d',
  }));

  const secure = config.web.baseUrl.startsWith('https://');
  app.use(session({
    name: 'botapprove.sid',
    store: new SqliteStore(),
    secret: config.web.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure,
      maxAge: 7 * 24 * 3600_000,
    },
  }));

  app.use((req, res, next) => {
    if (req.session && !req.session.csrfToken) {
      req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    }
    res.locals.csrfToken = req.session?.csrfToken ?? '';
    res.locals.user = req.session?.user ?? null;
    res.locals.isOwner = req.session?.user ? isInstanceOwner(req.session.user.id) : false;
    res.locals.paywallEnabled = config.paywall.enabled;
    res.locals.path = req.path;
    res.locals.cssVersion = cssVersion;
    res.locals.flash = null;
    next();
  });

  app.use((req, res, next) => {
    if (req.method !== 'POST') return next();
    const supplied = req.body?._csrf;
    const expected = req.session?.csrfToken;
    if (!expected || !supplied || supplied.length !== expected.length ||
        !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
      log.warn('csrf rejection', { path: req.path, ip: req.ip });
      return res.status(403).render('error', {
        title: 'Request rejected',
        message: 'Your session expired or the request did not come from this site. Reload and retry.',
      });
    }
    return next();
  });

  const plans = () => ({
    freeFeatures: Object.values(FEATURES).filter((f) => f.tier === 'free'),
    premiumFeatures: Object.values(FEATURES).filter((f) => f.tier === 'premium'),
    price: { amount: config.paywall.priceAmount, symbol: config.paywall.priceSymbol },
    inviteUrl: config.inviteUrl,
    portalUrl: config.stripe.portalUrl,
    trial: {
      offered: stripeEnabled() && config.stripe.trialDays > 0,
      days: config.stripe.trialDays,
    },
    plans: availablePlans(),
    prices: {
      monthly: config.paywall.priceAmount,
      yearly: config.stripe.priceAmountYearly,
      lifetime: config.stripe.priceAmountLifetime,
    },
    lifetime: lifetimeAvailability(),
    contactEmail: config.legal.contactEmail,
  });

  app.get('/', (req, res) => {
    if (req.session?.user) return res.redirect('/guilds');
    return res.render('landing', { title: 'BotApprove', ...plans() });
  });

  app.get('/healthz', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

  app.get('/favicon.ico', (_req, res) => res.redirect(301, '/static/icon.svg'));

  const legal = {
    updated: config.legal.updated,
    operator: config.legal.operator,
    contactUrl: config.legal.contactUrl,
  };
  app.get('/pricing', (_req, res) => res.render('pricing', { title: 'Pricing', ...plans() }));

  app.get('/blog', (_req, res) => res.render('blog', {
    title: 'Blog',
    posts: blog.listPublished(50),
  }));

  app.get('/blog/:slug', (req, res) => {
    const post = blog.bySlug(req.params.slug);
    if (!post || !post.published) {
      return res.status(404).render('error', { title: 'Not found', message: 'No such post.' });
    }
    return res.render('post', { title: post.title, post, html: renderPost(post.body) });
  });
  app.get('/terms', (_req, res) =>
    res.render('terms', { title: 'Terms of Service', ...legal, inviteUrl: config.inviteUrl }));
  app.get('/privacy', (_req, res) =>
    res.render('privacy', { title: 'Privacy Policy', ...legal, inviteUrl: config.inviteUrl }));

  app.use(authRouter);

  app.use(['/guilds', '/g', '/admin'], requireLogin);
  app.use(dashboardRouter);

  app.use((req, res) => {
    res.status(404).render('error', { title: 'Not found', message: 'No such page.' });
  });

  app.use((err, req, res, _next) => {
    log.error('request failed', { path: req.path, err: err.message, stack: err.stack });
    res.status(500).render('error', {
      title: 'Server error',
      message: 'Something went wrong. It has been logged.',
    });
  });

  return app;
}

export function startWeb() {
  const app = createApp();
  return new Promise((resolve, reject) => {
    const server = app.listen(config.web.port, config.web.host, () => {
      log.info('web interface listening', {
        host: config.web.host,
        port: config.web.port,
        baseUrl: config.web.baseUrl,
      });
      resolve(server);
    });
    server.on('error', reject);
  });
}
