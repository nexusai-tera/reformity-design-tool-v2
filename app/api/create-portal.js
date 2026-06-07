// ============================================================
// FINALOOK — /api/create-portal  (Phase 2E)
// Opens the Stripe Customer Portal so a user can update their card,
// change plan, or cancel. Requires an existing Stripe customer.
//
// Required env vars on the APP Vercel project:
//   STRIPE_SECRET_KEY
//   SUPABASE_SERVICE_ROLE_KEY
//   APP_URL  (optional; defaults to https://app.finalook.ai)
// ============================================================

import Stripe from 'stripe';
import { getUser, bearer, sbGet, SERVICE_ROLE } from './_lib.js';

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const APP_URL = process.env.APP_URL || 'https://app.finalook.ai';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.STRIPE_SECRET_KEY) return res.status(500).json({ error: 'Stripe is not configured.' });
  if (!SERVICE_ROLE) return res.status(500).json({ error: 'Server auth not configured.' });

  const token = bearer(req);
  if (!token) return res.status(401).json({ error: 'Sign in required.' });
  const user = await getUser(token);
  if (!user) return res.status(401).json({ error: 'Your session expired. Please sign in again.' });

  const rows = await sbGet(
    `subscriptions?user_id=eq.${user.id}&select=stripe_customer_id&order=created_at.desc&limit=1`
  );
  const customerId = Array.isArray(rows) && rows[0] ? rows[0].stripe_customer_id : null;
  if (!customerId) return res.status(400).json({ error: 'No billing account yet. Choose a plan first.' });

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${APP_URL}/`,
    });
    return res.status(200).json({ url: session.url });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
