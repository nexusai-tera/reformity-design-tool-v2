// ============================================================
// FINALOOK — /api/q-generate  (Phase 4, public)
// Homeowner-facing render + lead capture for the Virtual Quote page.
// Abuse protection: requires a valid slug whose contractor is on a plan
// that includes the feature, enforces a per-contractor monthly render cap
// (consume_public_render), and requires the homeowner's email.
// ============================================================
import { rpc, sbGet, SERVICE_ROLE, SUPABASE_URL } from './_lib.js';

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

  // Reject oversized or non-image uploads (caps abuse cost; the page sends JPEG).
  if (imageB64.length > 8000000) return res.status(413).json({ error: 'That photo is too large — please use one under ~5 MB.' });
  if (!/^(\/9j\/|iVBORw0)/.test(imageB64)) return res.status(415).json({ error: 'Please upload a JPEG or PNG photo.' });

  // Bot protection (Cloudflare Turnstile) — only enforced once TURNSTILE_SECRET is set.
  const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET;
  if (TURNSTILE_SECRET) {
    try {
      const tv = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ secret: TURNSTILE_SECRET, response: (req.body && req.body.turnstileToken) || '' }),
      });
      const tvd = await tv.json();
      if (!tvd.success) return res.status(403).json({ error: 'Bot check failed — please reload the page and try again.' });
    } catch { /* Cloudflare unreachable — don't block real homeowners */ }
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
  const prompt = `ROLE: You are a professional architectural photo retoucher. You are given a REAL photograph of a property. EDIT that exact photograph — do not invent a new scene or change the viewpoint. Return the same photo with ONLY the change below; every other pixel should stay faithful to the original.

CHANGE: add ${subject}, fully completed and professionally finished, naturally integrated into the existing space.

PRESERVE EXACTLY — keep identical to the original: the house and its windows, doors, roof and siding; existing trees and features not being replaced; neighbouring properties; the sky, weather, time of day and the direction of the sun and shadows; and the camera angle, position, framing and aspect ratio (do not crop, rotate or zoom).

NEVER: add people, pets, vehicles, furniture or décor; add any text, labels, logos or watermarks; duplicate or float any element; bend or warp straight lines (keep verticals truly vertical); or produce a CGI, cartoon, illustrated, HDR or over-saturated look.

OUTPUT: one photorealistic image indistinguishable from a professional DSLR photograph of the finished work — sharp focus, accurate natural lighting, shadows matching the original sun direction, realistic material textures, true-to-life colour, correct proportions and perspective, and the full uncropped frame at the original aspect ratio.`;
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

  // 4) Notify the contractor right away (best-effort) — fast follow-up wins jobs.
  try {
    const SG = process.env.SENDGRID_API_KEY, FROM = process.env.SENDGRID_FROM_EMAIL;
    if (SG && FROM) {
      const owner = await sbGet(`profiles?id=eq.${uid}&select=email,contact_email&limit=1`);
      const to = Array.isArray(owner) && owner[0] ? (owner[0].contact_email || owner[0].email) : null;
      if (to) {
        const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
        await fetch('https://api.sendgrid.com/v3/mail/send', {
          method: 'POST',
          headers: { Authorization: `Bearer ${SG}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            personalizations: [{ to: [{ email: to }] }],
            from: { email: FROM, name: 'Finalook' },
            subject: `New lead: ${name || 'a homeowner'} — ${trade || 'project'} preview`,
            content: [{ type: 'text/html', value:
              `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222;line-height:1.6;">` +
              `<p><b>${esc(name) || 'A homeowner'}</b> just requested a <b>${esc(trade) || 'project'}</b> preview on your Virtual Quote page.</p>` +
              `<p>Email: <a href="mailto:${esc(email)}">${esc(email)}</a>${phone ? (' &nbsp;·&nbsp; Phone: ' + esc(phone)) : ''}</p>` +
              `<p>Respond fast — leads contacted within minutes close far more often. Open Finalook → <b>Leads</b> to see the render and turn it into a quote.</p>` +
              (renderUrl ? `<p><a href="${esc(renderUrl)}">View the render →</a></p>` : '') +
              `</div>` }],
          }),
        });
      }
    }
  } catch { /* best-effort notification */ }

  return res.status(200).json({ render: renderB64, renderUrl });
}
