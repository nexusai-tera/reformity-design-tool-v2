// ============================================================
// FINALOOK — /api/quote-decide  (Phase 3)
// Public endpoint the client hits to approve or decline a quote.
// Identifies the quote by its public_token, records the decision
// (service_role), and emails the contractor (best-effort via SendGrid).
//
// Body: { token, decision: 'approved' | 'declined', note? }
// ============================================================

import { sbGet, sbPatch, SERVICE_ROLE } from './_lib.js';

const SENDGRID_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL;

// Escape client-supplied text before putting it in the contractor's HTML email.
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])
  );
}

async function emailContractor(toEmail, q) {
  if (!SENDGRID_KEY || !FROM_EMAIL || !toEmail) return;
  const approved = q.status === 'approved';
  const label = approved ? 'APPROVED' : 'DECLINED';
  const color = approved ? '#3a9e52' : '#e05555';
  const total = `${q.currency || 'CAD'} ${Number(q.total || 0).toLocaleString('en-CA', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
  const body = {
    personalizations: [{ to: [{ email: toEmail }] }],
    from: { email: FROM_EMAIL, name: 'Finalook' },
    subject: `Quote ${q.quote_number || ''} ${label} by ${q.client_name || 'your client'}`,
    content: [
      {
        type: 'text/html',
        value: `
          <div style="font-family:Arial,sans-serif;font-size:14px;color:#222;line-height:1.6;">
            <p>Your client <b>${esc(q.client_name) || ''}</b> has
               <b style="color:${color};">${label}</b> quote <b>${esc(q.quote_number) || ''}</b>.</p>
            ${q.client_note ? `<p style="background:#f6f6f6;border-left:3px solid ${color};padding:8px 12px;">"${esc(q.client_note)}"</p>` : ''}
            <p>Total: <b>${total}</b></p>
            <hr style="border:none;border-top:1px solid #eee;margin:16px 0;"/>
            <p style="font-size:11px;color:#999;">Sent automatically by Finalook.</p>
          </div>`,
      },
    ],
  };
  try {
    await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${SENDGRID_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    /* best-effort: never block the decision on email */
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!SERVICE_ROLE) return res.status(500).json({ error: 'Server not configured.' });

  const { token, decision, note } = req.body || {};
  if (!token || !['approved', 'declined'].includes(decision)) {
    return res.status(400).json({ error: 'Invalid request.' });
  }

  const rows = await sbGet(`quotes?public_token=eq.${encodeURIComponent(token)}&select=*&limit=1`);
  if (!Array.isArray(rows) || !rows[0]) return res.status(404).json({ error: 'Quote not found.' });
  const quote = rows[0];

  // Once decided, lock it.
  if (quote.status === 'approved' || quote.status === 'declined') {
    return res.status(200).json({ ok: true, status: quote.status, already: true });
  }

  const patch = {
    status: decision,
    decided_at: new Date().toISOString(),
    client_note: note ? String(note).slice(0, 1000) : null,
  };
  const upd = await sbPatch(`quotes?public_token=eq.${encodeURIComponent(token)}`, patch);
  if (!upd.ok) return res.status(500).json({ error: 'Could not record your decision.' });

  // Notify the contractor (best-effort).
  const owner = await sbGet(`profiles?id=eq.${quote.user_id}&select=email&limit=1`);
  const toEmail = Array.isArray(owner) && owner[0] ? owner[0].email : null;
  await emailContractor(toEmail, { ...quote, ...patch });

  return res.status(200).json({ ok: true, status: decision });
}
