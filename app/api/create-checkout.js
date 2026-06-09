// ============================================================
// FINALOOK — /api/create-checkout  (Phase 2E + pricing migration)
// Creates a Stripe Checkout session for the logged-in user:
//   - subscription -> Core / Pro, monthly or annual, 14-day card-required trial
//   - topup        -> one-time purchase of render credits (mode: payment)
//
// Required env vars on the APP Vercel project:
//   STRIPE_SECRET_KEY
//   STRIPE_PRICE_CORE_MONTHLY / STRIPE_PRICE_CORE_ANNUAL
//   STRIPE_PRICE_PRO_MONTHLY  / STRIPE_PRICE_PRO_ANNUAL
//   STRIPE_PRICE_TOPUP_CORE   / STRIPE_PRICE_TOPUP_PRO   (one-time prices)
//   SUPABASE_SERVICE_ROLE_KEY
//   APP_URL (optional; defaults to https://app.finalook.ai)
// ============================================================

import Stripe from 'stripe';
import { getUser, bearer, sbGet, sbPatch, SERVICE_ROLE } from './_lib.js';

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const APP_URL = process.env.APP_URL || 'https://app.finalook.ai';

const PRICES = {
  monthly: { core: process.env.STRIPE_PRICE_CORE_MONTHLY, pro: process.env.STRIPE_PRICE_PRO_MONTHLY },
  annual:  { core: process.env.STRIPE_PRICE_CORE_ANNUAL,  pro: process.env.STRIPE_PRICE_PRO_ANNUAL },
};
const TOPUP = { core: process.env.STRIPE_PRICE_TOPUP_CORE, pro: process.env.STRIPE_PRICE_TOPUP_PRO };
const TOPUP_CREDITS = 30; // render credits granted per top-up

async function resolveCustomer(user) {
  const rows = await sbGet(
    `subscriptions?user_id=eq.${user.id}&select=stripe_customer_id&order=created_at.desc&limit=1`
  );
  if (Array.isArray(rows) && rows[0] && rows[0].stripe_customer_id) return rows[0].stripe_customer_id;
  const customer = await stripe.customers.create({ email: user.email, metadata: { user_id: user.id } });
  await sbPatch(`subscriptions?user_id=eq.${user.id}`, { stripe_customer_id: customer.id });
  return customer.id;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.STRIPE_SECRET_KEY) return res.status(500).json({ error: 'Stripe is not configured.' });
  if (!SERVICE_ROLE) return res.status(500).json({ error: 'Server auth not configured.' });

  const token = bearer(req);
  if (!token) return res.status(401).json({ error: 'Sign in required.' });
  const user = await getUser(token);
  if (!user) return res.status(401).json({ error: 'Your session expired. Please sign in again.' });

  const type = String(req.body?.type || 'subscription').toLowerCase();

  let customerId;
  try {
    customerId = await resolveCustomer(user);
  } catch (err) {
    return res.status(500).json({ error: 'Could not create billing profile: ' + err.message });
  }

  // ---- One-time render-credit top-up -------------------------------------
  if (type === 'topup') {
    const subRows = await sbGet(`subscriptions?user_id=eq.${user.id}&select=plan&order=created_at.desc&limit=1`);
    const curPlan = ((Array.isArray(subRows) && subRows[0] && subRows[0].plan) || '').toLowerCase();
    const topupPrice = curPlan === 'pro' ? TOPUP.pro : TOPUP.core;
    if (!topupPrice) return res.status(400).json({ error: 'Render top-ups are not configured yet.' });
    try {
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        customer: customerId,
        client_reference_id: user.id,
        line_items: [{ price: topupPrice, quantity: 1 }],
        metadata: { user_id: user.id, type: 'topup', credits: String(TOPUP_CREDITS) },
        payment_intent_data: { metadata: { user_id: user.id, type: 'topup', credits: String(TOPUP_CREDITS) } },
        success_url: `${APP_URL}/?topup=success`,
        cancel_url: `${APP_URL}/?topup=cancel`,
      });
      return res.status(200).json({ url: session.url });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ---- Subscription (Core / Pro) -----------------------------------------
  const plan = String(req.body?.plan || '').toLowerCase();
  const period = String(req.body?.period || 'monthly').toLowerCase() === 'annual' ? 'annual' : 'monthly';
  const price = (PRICES[period] || {})[plan];
  if (!price) return res.status(400).json({ error: `Unknown or unconfigured plan: "${plan}" (${period}).` });

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      client_reference_id: user.id,
      line_items: [{ price, quantity: 1 }],
      subscription_data: {
        trial_period_days: 14,
        metadata: { user_id: user.id, plan, period },
      },
      payment_method_collection: 'always', // card required, even for the trial
      allow_promotion_codes: true,
      success_url: `${APP_URL}/?checkout=success`,
      cancel_url: `${APP_URL}/?checkout=cancel`,
    });
    return res.status(200).json({ url: session.url });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
