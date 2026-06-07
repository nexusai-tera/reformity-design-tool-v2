// ============================================================
// FINALOOK — /api/create-checkout  (Phase 2E)
// Creates a Stripe Checkout session for the logged-in user.
// Card-required 14-day trial -> paid subscription.
//
// Required env vars on the APP Vercel project:
//   STRIPE_SECRET_KEY
//   STRIPE_PRICE_SOLO   (Stripe Price ID for the $49 plan)
//   STRIPE_PRICE_PRO    (Stripe Price ID for the $99 plan)
//   STRIPE_PRICE_CREW   (Stripe Price ID for the $199 plan)
//   SUPABASE_SERVICE_ROLE_KEY
//   APP_URL             (optional; defaults to https://app.finalook.ai)
// ============================================================

import Stripe from 'stripe';
import { getUser, bearer, sbGet, sbPatch, SERVICE_ROLE } from './_lib.js';

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const APP_URL = process.env.APP_URL || 'https://app.finalook.ai';

const PRICES = {
  solo: process.env.STRIPE_PRICE_SOLO,
  pro: process.env.STRIPE_PRICE_PRO,
  crew: process.env.STRIPE_PRICE_CREW,
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.STRIPE_SECRET_KEY) return res.status(500).json({ error: 'Stripe is not configured.' });
  if (!SERVICE_ROLE) return res.status(500).json({ error: 'Server auth not configured.' });

  const token = bearer(req);
  if (!token) return res.status(401).json({ error: 'Sign in required.' });
  const user = await getUser(token);
  if (!user) return res.status(401).json({ error: 'Your session expired. Please sign in again.' });

  const plan = String(req.body?.plan || '').toLowerCase();
  const price = PRICES[plan];
  if (!price) return res.status(400).json({ error: `Unknown or unconfigured plan: "${plan}".` });

  // Find or create the Stripe customer for this user.
  let customerId = null;
  const rows = await sbGet(
    `subscriptions?user_id=eq.${user.id}&select=stripe_customer_id&order=created_at.desc&limit=1`
  );
  if (Array.isArray(rows) && rows[0] && rows[0].stripe_customer_id) {
    customerId = rows[0].stripe_customer_id;
  }
  if (!customerId) {
    try {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { user_id: user.id },
      });
      customerId = customer.id;
      await sbPatch(`subscriptions?user_id=eq.${user.id}`, { stripe_customer_id: customerId });
    } catch (err) {
      return res.status(500).json({ error: 'Could not create billing profile: ' + err.message });
    }
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      client_reference_id: user.id,
      line_items: [{ price, quantity: 1 }],
      subscription_data: {
        trial_period_days: 14,
        metadata: { user_id: user.id, plan },
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
