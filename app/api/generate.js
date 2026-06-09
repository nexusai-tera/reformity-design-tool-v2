// ============================================================
// FINALOOK — /api/generate  (Phase 2D: authenticated + quota-enforced)
//
// Flow:
//   1. Require a valid Supabase login (JWT in the Authorization header).
//   2. Atomically check + consume one render via the consume_render() RPC
//      (uses the SERVICE_ROLE key, server-side only — bypasses RLS).
//   3. Call Gemini.
//   4. If Gemini did not return an image, refund the render so the user
//      is never charged for a failure.
//
// Required env vars on the APP Vercel project (app.finalook.ai):
//   GEMINI_API_KEY                (already set)
//   SUPABASE_SERVICE_ROLE_KEY     (NEW — server-side only, never in the browser)
//   SUPABASE_URL                  (optional; falls back to the known project URL)
//   SUPABASE_ANON_KEY             (optional; public, falls back to the known anon key)
// ============================================================

export const config = { maxDuration: 60 }; // image renders can take 20-40s

const SUPABASE_URL =
  process.env.SUPABASE_URL || 'https://uywzmgjmlnodjlbnwyty.supabase.co';

// Anon key is safe to expose (it is already in the frontend). Env overrides it.
const SUPABASE_ANON =
  process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV5d3ptZ2ptbG5vZGpsYm53eXR5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA3Nzg4NDgsImV4cCI6MjA5NjM1NDg0OH0.6QkKWqpEe_jnKXmBJOUhmCSqOcG5sDJwStky3_88kms';

const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Verify a user access token and return the user object (or null).
async function getUser(token) {
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.id ? u : null;
  } catch {
    return null;
  }
}

// Call a Postgres function via PostgREST using the service_role key.
async function rpc(name, args) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { ok: r.ok, status: r.status, data };
}

function quotaMessage(q) {
  switch (q && q.reason) {
    case 'trial_expired':
      return 'Your free trial has ended. Upgrade to keep generating renders.';
    case 'limit_reached':
      return `You've used all ${q.limit} renders for this period. Upgrade for more.`;
    case 'inactive_subscription':
      return 'Your subscription is inactive. Please update your billing to continue.';
    case 'no_subscription':
    case 'no_usage_row':
      return 'Your account is missing billing setup. Please contact support.';
    default:
      return 'Render limit reached. Please upgrade to continue.';
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured' });
  }
  if (!SERVICE_ROLE) {
    return res
      .status(500)
      .json({ error: 'Server auth not configured (SUPABASE_SERVICE_ROLE_KEY missing).' });
  }

  // 1) Authenticate ----------------------------------------------------------
  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Sign in required.' });
  }
  const user = await getUser(token);
  if (!user) {
    return res.status(401).json({ error: 'Your session expired. Please sign in again.' });
  }

  // 2) Quota check + consume (atomic, server-side) ---------------------------
  const consume = await rpc('consume_render', { p_user_id: user.id });
  if (!consume.ok) {
    return res.status(500).json({ error: 'Usage check failed.', detail: consume.data });
  }
  const q = consume.data || {};
  if (!q.allowed) {
    return res.status(402).json({
      error: quotaMessage(q),
      code: 'quota',
      reason: q.reason,
      plan: q.plan,
      status: q.status,
      used: q.used,
      limit: q.limit,
    });
  }

  // 3) Call Gemini -----------------------------------------------------------
  let geminiStatus = 502;
  let geminiData = null;
  let hadImage = false;
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body),
      }
    );
    geminiStatus = r.status;
    geminiData = await r.json();
    const parts = geminiData?.candidates?.[0]?.content?.parts || [];
    hadImage = !!parts.find((p) => p.inlineData || p.inline_data);
  } catch (err) {
    geminiData = { error: { message: err.message } };
    geminiStatus = 502;
  }

  // 4) Refund if no image was produced ---------------------------------------
  const success = geminiStatus >= 200 && geminiStatus < 300 && hadImage;
  if (!success) {
    await rpc('refund_render', { p_user_id: user.id, p_bucket: q.bucket || 'monthly' }); // best-effort, refunds the bucket consumed
    // Pass the upstream status through (429 stays 429 so the client can retry).
    return res.status(geminiStatus).json(geminiData);
  }

  // 5) Success ---------------------------------------------------------------
  res.setHeader('X-Render-Used', String(q.used));
  if (q.limit != null) res.setHeader('X-Render-Limit', String(q.limit));
  return res.status(200).json(geminiData);
}
