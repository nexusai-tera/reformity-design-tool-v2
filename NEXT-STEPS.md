# Finalook — where we left off (pick up here)

## Built and in the repo
- Phases 2D, 2E, 3 (secure renders, Stripe billing, CRM + client approvals)
- Phase 4 — Virtual Quote public lead page (`/q/?s=slug`) + Leads inbox
- Phase 5 — QR codes + source tracking
- Phase 6 — Team seats (shared account, invites)
- Phase 10 — Analytics dashboard
- Lead → 1-click quote
- Brief "2-week list": outcome hero, Book-a-Demo (Calendly), OG image, removed material generator + QuickBooks
- Legal pages: privacy.html, terms.html, contact.html

## ⏳ Do these to finish deploying the latest
1. **Run the SQL** in Supabase, in order:
   - `sql/phase-4-virtual-quote.sql`
   - `sql/phase-6-team-seats.sql`
   - `sql/phase-pricing-core-pro.sql`   ← NEW (Core/Pro + render-credit top-ups)
2. **Add the new Stripe price env vars** (app project — TEST mode, Nexus AI sandbox):
   - STRIPE_PRICE_CORE_MONTHLY = price_1TgVOSHeqWY1LwfAsIqWlfs2
   - STRIPE_PRICE_CORE_ANNUAL  = price_1TgVOTHeqWY1LwfAt939h7FG
   - STRIPE_PRICE_PRO_MONTHLY  = price_1TgVOTHeqWY1LwfAeKuwvfW1
   - STRIPE_PRICE_PRO_ANNUAL   = price_1TgVOUHeqWY1LwfAWJ3SUc31
   - STRIPE_PRICE_TOPUP_CORE   = price_1TgVOVHeqWY1LwfA31bzINd8
   - STRIPE_PRICE_TOPUP_PRO    = price_1TgVOWHeqWY1LwfAt9d44w3c
   - (Old SOLO/PRO/CREW price vars are no longer used — safe to delete.)
3. **Push + redeploy** the app project (pricing migration + audit quick wins live in `app/`).
4. **Landing project:** deploy `vercel.json` (root) so `finalook.ai/q/<slug>` → app. (Marketing index.html untouched.)

## Audit quick wins — shipped (need your bits to fully activate)
- Email-to-contractor on every new lead (needs SENDGRID_API_KEY + SENDGRID_FROM_EMAIL, already set).
- Upload size + JPEG/PNG check on the public `/q/` page.
- Cloudflare Turnstile wired (no-op until you set `TURNSTILE_SITEKEY` in `app/q/index.html` + `TURNSTILE_SECRET` env var).
- `vercel.json` adds the branded `/q/<slug>` rewrite.

## ⚠ Notes / decisions
- **Pro Virtual Quote = unlimited leads.** No hard ceiling on anonymous Gemini cost per contractor — Turnstile + size checks bound abuse. Say the word to add a safety ceiling (e.g. 300/mo).
- **Top-ups:** +30 render credits, $59 (Core) / $39 (Pro). Credits never expire, used after the monthly allotment.

## ⚠ Test before relying on it
- **Phase 6 data isolation:** make a 2nd account, invite it from **Team**, confirm it sees your team's data; make a 3rd un-invited account and confirm it sees **none** of your data.

## Bigger items still open
- **Go live on Stripe** (everything is in test/sandbox today) — recreate products/prices/webhook in live mode, swap env vars.
- **DMARC DNS record** in GoDaddy: `_dmarc` TXT `v=DMARC1; p=none; rua=mailto:info@nexusaigta.ca`
- Marketing site (Phase 9) — you're handling.
- Phase 11 (white-label) — deferred.
- Pre-launch polish: real testimonials/video, verified stat figures, confirm `hello@finalook.ai` inbox.

## To resume with Claude
Reopen the Claude desktop app. Either continue the same conversation, or start a new one, reconnect this folder, and say "continue the Finalook build — read NEXT-STEPS.md."
