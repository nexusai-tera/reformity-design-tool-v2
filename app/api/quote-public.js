// ============================================================
// FINALOOK — /api/quote-public  (Phase 3)
// Public, read-only lookup of a quote by its public_token, for the
// client-facing approval page. Uses the service_role key server-side
// and returns only safe fields (never user_id / client_email).
// ============================================================

import { sbGet, sbPatch } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const token =
    (req.query && req.query.token) ||
    new URL(req.url, 'http://localhost').searchParams.get('token');
  if (!token) return res.status(400).json({ error: 'Missing token.' });

  const rows = await sbGet(
    `quotes?public_token=eq.${encodeURIComponent(token)}` +
      `&select=user_id,quote_number,client_name,project_address,company_name,logo_url,total,currency,pdf_url,render_url,status,client_note,payload&limit=1`
  );
  if (!Array.isArray(rows) || !rows[0]) return res.status(404).json({ error: 'Quote not found.' });

  const q = rows[0];
  const uid = q.user_id;
  delete q.user_id; // never expose the owner id to the public page

  // Attach the contractor's contact details so the client knows who's quoting and how to reach them.
  if (uid) {
    const pr = await sbGet(
      `profiles?id=eq.${encodeURIComponent(uid)}` +
        `&select=company_name,contact_phone,contact_email,contact_info,business_address,business_city,business_province,business_postal&limit=1`
    );
    if (Array.isArray(pr) && pr[0]) q.contractor = pr[0];
  }

  // Record the client's first open as "viewed" (best-effort; only flips a 'sent' quote).
  if (q.status === 'sent') {
    try {
      await sbPatch(
        `quotes?public_token=eq.${encodeURIComponent(token)}&status=eq.sent`,
        { status: 'viewed', viewed_at: new Date().toISOString() }
      );
    } catch (e) { /* non-fatal */ }
  }

  return res.status(200).json(q);
}
