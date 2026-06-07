// ============================================================
// FINALOOK — /api/quote-public  (Phase 3)
// Public, read-only lookup of a quote by its public_token, for the
// client-facing approval page. Uses the service_role key server-side
// and returns only safe fields (never user_id / client_email).
// ============================================================

import { sbGet } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const token =
    (req.query && req.query.token) ||
    new URL(req.url, 'http://localhost').searchParams.get('token');
  if (!token) return res.status(400).json({ error: 'Missing token.' });

  const rows = await sbGet(
    `quotes?public_token=eq.${encodeURIComponent(token)}` +
      `&select=quote_number,client_name,project_address,company_name,logo_url,total,currency,pdf_url,render_url,status,client_note&limit=1`
  );
  if (!Array.isArray(rows) || !rows[0]) return res.status(404).json({ error: 'Quote not found.' });

  return res.status(200).json(rows[0]);
}
