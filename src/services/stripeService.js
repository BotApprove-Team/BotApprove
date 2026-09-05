import Stripe from 'stripe';
import { config } from '../config.js';
import { entitlements } from '../db/queries.js';
import { grantEntitlement, markBillingLapse, resolveEntitlement } from './entitlementService.js';
import { record } from './securityService.js';
import { createLogger } from '../logger.js';

const log = createLogger('stripe');

export const isEnabled = () =>
  config.stripe.enabled && !!(config.stripe.secretKey && config.stripe.priceId);

export const isConfigured = () => !!(config.stripe.secretKey && config.stripe.priceId);

let client = null;
export function stripe() {
  if (!isEnabled()) return null;
  if (!client) client = new Stripe(config.stripe.secretKey);
  return client;
}

export function trialOffer(guildId) {
  const days = config.stripe.trialDays;
  if (!isEnabled() || days <= 0) return { eligible: false, days: 0 };
  if (!guildId) return { eligible: false, days };
  if (entitlements.hasUsedStripeTrial(guildId)) {
    return { eligible: false, days, reason: 'already_used' };
  }
  if (resolveEntitlement(guildId).licensed) {
    return { eligible: false, days, reason: 'already_licensed' };
  }
  return { eligible: true, days };
}

export const PLANS = {
  monthly: { recurring: true, priceKey: 'priceId' },
  yearly: { recurring: true, priceKey: 'priceIdYearly' },
  lifetime: { recurring: false, priceKey: 'priceIdLifetime' },
};

export function planPrice(plan) {
  const spec = PLANS[plan];
  if (!spec) return null;
  const price = config.stripe[spec.priceKey];
  return price ? { ...spec, plan, price } : null;
}

/** Which plans this instance can actually sell, so the UI offers no dead buttons. */
export function availablePlans() {
  if (!isEnabled()) return [];
  return Object.keys(PLANS).filter((plan) => planPrice(plan));
}

export async function createCheckoutSession({ guildId, guildName, userId, plan = 'monthly' }) {
  const s = stripe();
  if (!s) return { ok: false, reason: 'stripe_not_configured' };

  const spec = planPrice(plan);
  if (!spec) return { ok: false, reason: 'unknown_plan' };

  const existing = entitlements.get(guildId);
  // A one-off purchase never gets a trial: a free period before a single
  // payment means nothing, and Stripe rejects trial data in payment mode.
  const offer = spec.recurring ? trialOffer(guildId) : { eligible: false, days: 0 };
  const meta = { guild_id: guildId, guild_name: guildName ?? '', bought_by: userId };

  try {
    const session = await s.checkout.sessions.create({
      mode: spec.recurring ? 'subscription' : 'payment',
      line_items: [{ price: spec.price, quantity: 1 }],
      success_url: `${config.web.baseUrl}/g/${guildId}?billing=started`,
      cancel_url: `${config.web.baseUrl}/pricing`,
      client_reference_id: guildId,
      ...(spec.recurring
        ? {
          subscription_data: {
            metadata: meta,
            ...(offer.eligible ? { trial_period_days: offer.days } : {}),
          },
        }
        // No subscription to hang metadata on, so the guild link lives on the
        // payment intent as well as the session.
        : { payment_intent_data: { metadata: meta } }),
      metadata: {
        guild_id: guildId,
        plan: spec.plan,
        trial_days: offer.eligible ? String(offer.days) : '0',
      },
      allow_promotion_codes: true,
      ...(existing?.external_id?.startsWith('cus_') ? { customer: existing.external_id } : {}),
    });

    await record({
      guildId,
      actorId: userId,
      action: 'checkout_started',
      severity: 'info',
      detail: { session: session.id, plan: spec.plan, trial_days: offer.eligible ? offer.days : 0 },
      mirror: false,
    });

    return { ok: true, url: session.url };
  } catch (err) {
    log.error('checkout session failed', { guildId, err: err.message });
    return { ok: false, reason: err.message };
  }
}

export async function createPortalSession({ guildId }) {
  const s = stripe();
  if (!s) return { ok: false, reason: 'stripe_not_configured' };

  const row = entitlements.get(guildId);
  const customerId = row?.external_id?.startsWith('cus_') ? row.external_id : null;
  if (!customerId) return { ok: false, reason: 'no_subscription' };

  try {
    const session = await s.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${config.web.baseUrl}/g/${guildId}`,
    });
    return { ok: true, url: session.url };
  } catch (err) {
    log.error('portal session failed', { guildId, err: err.message });
    return { ok: false, reason: err.message };
  }
}

async function resolveGuildId(event) {
  const obj = event.data.object;

  if (obj?.metadata?.guild_id) return obj.metadata.guild_id;
  if (obj?.client_reference_id) return obj.client_reference_id;

  const subId = obj?.subscription
    ?? (obj?.object === 'subscription' ? obj.id : null);
  if (subId) {
    const s = stripe();
    const sub = await s.subscriptions.retrieve(subId).catch(() => null);
    if (sub?.metadata?.guild_id) return sub.metadata.guild_id;
  }

  if (obj?.customer) {
    const row = entitlements.all().find((r) => r.external_id === obj.customer);
    if (row) return row.guild_id;
  }
  return null;
}

const toMs = (sec) => (typeof sec === 'number' ? sec * 1000 : null);

export async function handleEvent(event) {
  const guildId = await resolveGuildId(event);
  if (!guildId) {
    log.warn('event could not be matched to a guild', { type: event.type, id: event.id });
    return { handled: false, reason: 'no_guild' };
  }

  const obj = event.data.object;

  switch (event.type) {
    case 'checkout.session.completed': {
      // A one-off purchase. This event is the only one it will ever produce:
      // there is no subscription behind it, so no invoice.paid to extend it and
      // no cancellation to end it. It is granted once, with no expiry, and
      // flagged so a later billing event cannot take it away.
      if (obj.mode === 'payment') {
        await grantEntitlement(guildId, {
          tier: 'pro',
          expiresAt: null,
          source: 'stripe',
          note: 'stripe lifetime',
          actorId: 'stripe',
        });
        entitlements.upsert(guildId, {
          tier: 'pro',
          status: 'active',
          expiresAt: null,
          source: 'stripe',
          externalId: typeof obj.customer === 'string' ? obj.customer : null,
          note: 'stripe lifetime',
        });
        entitlements.markPerpetual(guildId);

        log.info('lifetime purchase activated', { guildId, customer: obj.customer });
        return { handled: true, action: 'lifetime_activated' };
      }

      const trialDays = Number.parseInt(obj.metadata?.trial_days ?? '0', 10);
      const onTrial = Number.isFinite(trialDays) && trialDays > 0;
      const tier = onTrial ? 'trial' : 'pro';
      const note = onTrial ? `stripe subscription, ${trialDays} day trial` : 'stripe subscription';

      await grantEntitlement(guildId, {
        tier,
        expiresAt: null,
        source: 'stripe',
        note,
        actorId: 'stripe',
      });
      entitlements.upsert(guildId, {
        tier,
        status: 'active',
        expiresAt: null,
        source: 'stripe',
        externalId: typeof obj.customer === 'string' ? obj.customer : null,
        note,
      });
      if (onTrial) entitlements.markStripeTrialUsed(guildId);

      log.info('subscription activated', { guildId, customer: obj.customer, trialDays });
      return { handled: true, action: onTrial ? 'trial_started' : 'activated' };
    }

    case 'invoice.paid': {
      const periodEnd = toMs(obj.lines?.data?.[0]?.period?.end)
        ?? toMs(obj.period_end);
      const paidReal = (obj.amount_paid ?? 0) > 0;
      const current = entitlements.get(guildId);
      entitlements.upsert(guildId, {
        tier: paidReal ? 'pro' : (current?.tier ?? 'pro'),
        status: 'active',
        expiresAt: periodEnd,
        source: 'stripe',
        externalId: typeof obj.customer === 'string' ? obj.customer : null,
        note: paidReal ? 'stripe subscription' : (current?.note ?? 'stripe subscription'),
      });
      await record({
        guildId,
        action: paidReal ? 'subscription_renewed' : 'trial_invoice',
        severity: 'info',
        detail: { until: periodEnd, amount_paid: obj.amount_paid ?? 0 },
        mirror: false,
      });
      return { handled: true, action: paidReal ? 'renewed' : 'trial_invoice' };
    }

    case 'invoice.payment_failed':
      await markBillingLapse(guildId, 'payment_failed', {
        externalId: typeof obj.customer === 'string' ? obj.customer : null,
      });
      return { handled: true, action: 'payment_failed' };

    case 'customer.subscription.deleted':
      await markBillingLapse(guildId, 'cancelled', {
        externalId: typeof obj.customer === 'string' ? obj.customer : null,
      });
      return { handled: true, action: 'cancelled' };

    default:
      return { handled: false, reason: 'unhandled_type' };
  }
}

export function constructEvent(rawBody, signature) {
  const s = stripe();
  if (!s) throw new Error('stripe not configured');
  if (!config.stripe.webhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET is not set');
  return s.webhooks.constructEvent(rawBody, signature, config.stripe.webhookSecret);
}
