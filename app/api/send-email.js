import { getUser, bearer } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Require a logged-in user so this endpoint can't be used as an open email relay.
  const token = bearer(req);
  const user = token ? await getUser(token) : null;
  if (!user) return res.status(401).json({ error: 'Sign in required.' });

  const SENDGRID_KEY = process.env.SENDGRID_API_KEY;
  const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL; // must be a verified sender in SendGrid

  if (!SENDGRID_KEY || !FROM_EMAIL) {
    return res.status(500).json({ error: 'Email is not configured on the server yet.' });
  }

  const { to, clientName, companyName, quoteNumber, pdfBase64, approvalUrl, total } = req.body || {};

  if (!to || !pdfBase64) {
    return res.status(400).json({ error: 'Missing recipient or PDF.' });
  }

  const safeCompany = companyName || 'Your Contractor';
  const safeClient = clientName || 'there';
  const safeQuote = quoteNumber || 'Quote';

  // Phase 3: if an approval link is provided, add a "Review & Approve" button.
  const approveBlock = approvalUrl
    ? `
          <p style="margin:20px 0;">
            <a href="${approvalUrl}" style="background:#3a9e52;color:#06210f;text-decoration:none;font-weight:bold;padding:13px 26px;border-radius:6px;display:inline-block;">Review &amp; Approve Your Quote</a>
          </p>
          <p style="font-size:12px;color:#777;">Or paste this link into your browser:<br/><a href="${approvalUrl}" style="color:#3a9e52;">${approvalUrl}</a></p>`
    : '';

  const intro = approvalUrl
    ? `Thank you for the opportunity to quote your project. Your detailed quotation is attached as a PDF, including a design preview of the proposed work. When you're ready, you can approve or decline it online using the button below.`
    : `Thank you for the opportunity to quote your project. Please find your detailed quotation attached as a PDF, including a design preview of the proposed work.`;

  const body = {
    personalizations: [{ to: [{ email: to }] }],
    from: { email: FROM_EMAIL, name: safeCompany },
    subject: `Your Quote from ${safeCompany} (${safeQuote})`,
    content: [{
      type: 'text/html',
      value: `
        <div style="font-family:Arial,sans-serif;font-size:14px;color:#222;line-height:1.6;">
          <p>Hi ${safeClient},</p>
          <p>${intro}</p>
          ${approveBlock}
          <p>If you have any questions, simply reply to this email.</p>
          <p>Best regards,<br/>${safeCompany}</p>
          <hr style="border:none;border-top:1px solid #eee;margin:20px 0;"/>
          <p style="font-size:11px;color:#999;">This quotation includes AI-generated design renders for illustrative purposes only. Actual materials, colours, and final appearance may vary.</p>
        </div>`
    }],
    attachments: [{
      content: pdfBase64,
      filename: `${safeQuote}.pdf`,
      type: 'application/pdf',
      disposition: 'attachment'
    }]
  };

  try {
    const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SENDGRID_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (response.status === 202) {
      return res.status(200).json({ success: true });
    }

    const errText = await response.text();
    return res.status(response.status).json({ error: 'SendGrid error: ' + errText });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
