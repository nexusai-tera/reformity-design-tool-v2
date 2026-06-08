// ============================================================
// FINALOOK — /api/q-generate  (Phase 4, public)
// Homeowner-facing render + lead capture for the Virtual Quote page.
// Abuse protection: requires a valid slug whose contractor is on a plan
// that includes the feature, enforces a per-contractor monthly render cap
// (consume_public_render), and requires the homeowner's email.
// ============================================================
import { rpc, SERVICE_ROLE, SUPABASE_URL } from './_lib.js';

export const config = { maxDuration: 60 };

const GEMINI = process.env.GEMINI_API_KEY;

const TRADE = {
  fence: 'a new privacy fence',
  deck: 'a new wooden deck',
  interlock: 'new interlocking stone paving',
  concrete: 'a clean new concrete patio or driveway',
  landscaping: 'professional landscaping with fresh plants, greenery, and tidy edging',
  masonry: 'new masonry / stonework',
};

async function uploadLeadFile(path, b64, contentType) {
  try {
    const bytes = Buffer.from(b64, 'base64');
    const r = await fetch(`${SUPABASE_URL}/storage/v1/object/leads/${path}`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_ROLE,
        Authorization: `Bearer ${SERVICE_ROLE}`,
        'Content-Type': contentType,
        'x-upsert': 'true',
      },
      body: bytes,
    });
    if (!r.ok) return null;
    return `${SUPABASE_URL}/storage/v1/object/public/leads/${path}`;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!GEMINI) return res.status(500).json({ error: 'Render is not configured.' });
  if (!SERVICE_ROLE) return res.status(500).json({ error: 'Server not configured.' });

  const { slug, trade, name, email, phone, imageB64, source } = req.body || {};
  const src = String(source || 'virtual_quote').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || 'virtual_quote';
  if (!slug || !imageB64) return res.status(400).json({ error: 'Missing photo or page.' });
  if (!email || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid email is required to see your preview.' });
  }

  // 1) Cap check + consume (atomic, server-side) — bounds anonymous Gemini cost.
  const c = await rpc('consume_public_render', { p_slug: String(slug) });
  if (!c.ok) return res.status(500).json({ error: 'Could not check availability.' });
  const cc = c.data || {};
  if (!cc.allowed) {
    const msg =
      cc.reason === 'cap_reached'
        ? "This contractor has reached this month's preview limit — please contact them directly."
        : cc.reason === 'disabled'
        ? 'This preview page is not active right now.'
        : 'Preview is not available.';
    return res.status(403).json({ error: msg, reason: cc.reason });
  }
  const uid = cc.user_id;

  // 2) Render with Gemini.
  const subject = TRADE[String(trade || '').toLowerCase()] || 'a professional finished outdoor renovation';
  const prompt = `Transform this photo of a property by adding ${subject}. Render in sharp, photorealistic detail with accurate natural lighting, correct shadows consistent with the original photo, and realistic material textures. Keep the exact same camera angle, perspective, sky, and background. The result must look like a real DSLR photograph of the completed work — avoid any CGI, cartoonish, or over-saturated appearance.`;
  let renderB64 = null;
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent?key=${GEMINI}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: 'image/jpeg', data: imageB64 } }] }],
          generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
        }),
      }
    );
    const data = await r.json();
    const part = (data?.candidates?.[0]?.content?.parts || []).find((p) => p.inlineData || p.inline_data);
    renderB64 = part ? (part.inlineData || part.inline_data).data : null;
  } catch {
    /* handled below */
  }
  if (!renderB64) {
    return res.status(502).json({ error: 'The preview could not be generated — please try a clearer photo.' });
  }

  // 3) Store before/after + save the lead (best-effort; never block the homeowner's result).
  const id = (globalThis.crypto && globalThis.crypto.randomUUID)
    ? globalThis.crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2);
  const photoUrl = await uploadLeadFile(`${uid}/${id}-before.jpg`, imageB64, 'image/jpeg');
  const renderUrl = await uploadLeadFile(`${uid}/${id}-after.png`, renderB64, 'image/png');
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/leads`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_ROLE,
        Authorization: `Bearer ${SERVICE_ROLE}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        user_id: uid,
        name: name || null,
        email,
        phone: phone || null,
        trade: trade || null,
        photo_url: photoUrl,
        render_url: renderUrl,
        source: src,
        status: 'new',
      }),
    });
  } catch {
    /* lead save failed — still return the render to the homeowner */
  }

  return res.status(200).json({ render: renderB64, renderUrl });
}
