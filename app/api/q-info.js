// ============================================================
// FINALOOK — /api/q-info  (Phase 4, public)
// Returns a contractor's public branding + whether their Virtual Quote
// page can render right now (by slug). No auth; service_role read.
// ============================================================
import { rpc, SERVICE_ROLE } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!SERVICE_ROLE) return res.status(500).json({ error: 'Server not configured.' });

  const slug =
    (req.query && req.query.slug) ||
    new URL(req.url, 'http://localhost').searchParams.get('slug');
  if (!slug) return res.status(400).json({ error: 'Missing slug.' });

  const r = await rpc('q_lookup', { p_slug: String(slug) });
  if (!r.ok) return res.status(500).json({ error: 'Lookup failed.' });
  const d = r.data || {};
  if (!d.found) return res.status(404).json({ error: 'Page not found.' });

  return res.status(200).json({
    company: d.company || 'Your Contractor',
    logo: d.logo || null,
    enabled: !!d.enabled,
    available: !!d.available,
  });
}
