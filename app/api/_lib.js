// ============================================================
// FINALOOK — shared server helpers for the serverless API functions.
// Files prefixed with "_" are NOT deployed as routes by Vercel, but
// can be imported by the route files in this folder.
// ============================================================

export const SUPABASE_URL =
  process.env.SUPABASE_URL || 'https://uywzmgjmlnodjlbnwyty.supabase.co';

// Anon key is public (already in the frontend). Env overrides it.
export const SUPABASE_ANON =
  process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV5d3ptZ2ptbG5vZGpsYm53eXR5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA3Nzg4NDgsImV4cCI6MjA5NjM1NDg0OH0.6QkKWqpEe_jnKXmBJOUhmCSqOcG5sDJwStky3_88kms';

export const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Verify a user access token (JWT) and return the user object, or null.
export async function getUser(token) {
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

// Read the Bearer token from a request, or null.
export function bearer(req) {
  const h = req.headers.authorization || req.headers.Authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

// PostgREST GET with the service_role key (bypasses RLS). Returns parsed JSON or null.
export async function sbGet(path) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// PostgREST PATCH with the service_role key. Returns { ok, status, data }.
export async function sbPatch(path, body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { ok: r.ok, status: r.status, data };
}

// Call a Postgres function via PostgREST RPC with the service_role key. Returns { ok, status, data }.
export async function rpc(name, args) {
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
