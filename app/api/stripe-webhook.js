// ============================================================
// FINALOOK — /api/stripe-webhook  (Phase 2E)
// Receives Stripe events and syncs the subscriptions table.
// The webhook signature is verified with the Stripe SDK.
//
// Required env vars on the APP Vercel project:
//   STRIPE_SECRET_KEY
//   STRIPE_WEBHOOK_SECRET   (from the Stripe webhook endpoint you create)
//   STRIPE_PRICE_CORE_MONTHLY / _PRO_MONTHLY / _CORE_ANNUAL / _PRO_ANNUAL  (to map price -> plan)
//   SUPABASE_SERVICE_ROLE_KEY
//
// IMPORTANT: bodyParser is disabled so we can verify the raw payload.
// ============================================================

import Stripe from 'stripe';
import { sbPatch, rpc } from './_lib.js';

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

export const config = { api: { bodyParser: false } };

const PRICE_TO_PLAN = {};
const mapPrice = (id, plan) => { if (id) PRICE_TO_PLAN[id] = plan; };
mapPrice(process.env.STRIPE_PRICE_CORE_MONTHLY, 'core');
mapPrice(process.env.STRIPE_PRICE_PRO_MONTHLY, 'pro');
mapPrice(process.env.STRIPE_PRICE_CORE_ANNUAL, 'core');
mapPrice(process.env.STRIPE_PRICE_PRO_ANNUAL, 'pro');

async function readRaw(req) {
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
  return Buffer.concat(chunks);
}

// Map a Stripe subscription.status to our subscriptions.status.
function mapStatus(s) {
  switch (s) {
    case 'incomplete_expired':
      return 'canceled';
    default:
      return s; // trialing, active, past_due, canceled, unpaid, incomplete, paused
  }
}

async function syncSubscription(sub) {
  const userId = sub.metadata && sub.metadata.user_id;
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
  const priceId = sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].price
    ? sub.items.data[0].price.id
    : null;
  const plan = priceId ? PRICE_TO_PLAN[priceId] || null : null;

  const patch = {
    status: mapStatus(sub.status),
    stripe_subscription_id: sub.id,
  };
  if (customerId) patch.stripe_customer_id = customerId;
  if (plan) patch.plan = plan;
  if (sub.trial_end) patch.trial_ends_at = new Date(sub.trial_end * 1000).toISOString();

  // Prefer matching by user_id (from metadata); fall back to the Stripe customer id.
  if (userId) {
    await sbPatch(`subscriptions?user_id=eq.${userId}`, patch);
  } else if (customerId) {
    await sbPatch(`subscriptions?stripe_customer_id=eq.${customerId}`, patch);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!WEBHOOK_SECRET || !process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: 'Stripe webhook is not configured.' });
  }

  let event;
  try {
    const raw = await readRaw(req);
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(raw, sig, WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).json({ error: `Webhook signature verification failed: ${err.message}` });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const s = event.data.object;
        if (s.mode === 'subscription' && s.subscription) {
          const sub = await stripe.subscriptions.retrieve(s.subscription);
          if ((!sub.metadata || !sub.metadata.user_id) && s.client_reference_id) {
            sub.metadata = { ...(sub.metadata || {}), user_id: s.client_reference_id };
          }
          await syncSubscription(sub);
        } else if (s.mode === 'payment' && s.metadata && s.metadata.type === 'topup') {
          // One-time render-credit top-up — add the credits to the buyer's account.
          const uid = s.metadata.user_id || s.client_reference_id;
          const credits = parseInt(s.metadata.credits || '0', 10) || 0;
          if (uid && credits > 0) await rpc('add_render_credits', { p_user_id: uid, p_qty: credits });
        }
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        await syncSubscription(event.data.object);
        break;
      }
      default:
        break;
    }
    return res.status(200).json({ received: true });
  } catch (err) {
    // Return 500 so Stripe retries delivery.
    return res.status(500).json({ error: err.message });
  }
}
