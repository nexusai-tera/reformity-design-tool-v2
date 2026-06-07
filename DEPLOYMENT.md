# Finalook — Phase 2D / 2E / 3 Deployment Checklist

Everything below ships from the **app** Vercel project (`app.finalook.ai`, Root Directory = `app/`).
Code is written and verified; the steps here are the manual/credential actions that stay with you.

---

## 1. What shipped

- **Phase 2D — Secure render API + usage limits.** `/api/generate` now requires a Supabase login, enforces per-plan render limits in the database (can't be bypassed from the browser), and refunds a render if Gemini returns no image. Header shows a live "renders left" badge; an upgrade overlay appears at the limit.
- **Phase 2E — Stripe billing.** Card-required 14-day trial → paid subscription. `/api/create-checkout`, `/api/stripe-webhook` (syncs `subscriptions`), `/api/create-portal` (manage/cancel). Plans: Solo 30/mo, Pro 100/mo, Crew unlimited.
- **Phase 3 — CRM.** Save quotes to the account, searchable "My Quotes" list, and a public client **approve/decline** page (`/approve?token=…`) that emails you the decision.

---

## 2. SQL to run (Supabase SQL editor)

1. `sql/phase-2d-secure-render.sql` — quota functions (`consume_render`, `refund_render`, `plan_render_limit`).
2. `sql/phase-3-crm.sql` — `quotes` table, RLS, and the public `quotes` storage bucket.

Both are safe to re-run.

---

## 3. Environment variables (app project → Production)

| Variable | Used by | Notes |
|---|---|---|
| `GEMINI_API_KEY` | generate | already set |
| `SUPABASE_SERVICE_ROLE_KEY` | 2D, 2E, 3 | **NEW** — Supabase → Settings → API → service_role. Server-side only. |
| `STRIPE_SECRET_KEY` | 2E | `sk_…` |
| `STRIPE_PRICE_SOLO` / `STRIPE_PRICE_PRO` / `STRIPE_PRICE_CREW` | 2E | Stripe Price IDs (`price_…`) |
| `STRIPE_WEBHOOK_SECRET` | 2E | `whsec_…` from the webhook endpoint |
| `SENDGRID_API_KEY` / `SENDGRID_FROM_EMAIL` | email + approvals | confirm present on the **app** project |
| `APP_URL` | 2E | optional; defaults to `https://app.finalook.ai` |

`SUPABASE_URL` / `SUPABASE_ANON_KEY` are optional (safe public fallbacks are built in).

---

## 4. Stripe setup

1. Create 3 products with **monthly CAD** prices: Solo $49, Pro $99, Crew $199. Copy each Price ID into the env vars above.
2. Add a webhook → `https://app.finalook.ai/api/stripe-webhook`, events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`. Copy its signing secret → `STRIPE_WEBHOOK_SECRET`.
3. Enable the **Customer Portal** (Settings → Billing → Customer portal).
4. Test with card `4242 4242 4242 4242` in test mode first.

---

## 5. Git: files to commit

**New:** `sql/phase-2d-secure-render.sql`, `sql/phase-3-crm.sql`, `app/api/_lib.js`, `app/api/create-checkout.js`, `app/api/stripe-webhook.js`, `app/api/create-portal.js`, `app/api/quote-public.js`, `app/api/quote-decide.js`, `app/approve/index.html`, `app/package.json`, `package.json`.

**Modified:** `app/api/generate.js`, `app/api/send-email.js`, `app/index.html`.

**Deleted:** `api/generate.js`, `send-email.js` (stale root duplicates).

> ⚠️ If your live repo already has an `app/package.json`, **merge** the `stripe` dependency into it instead of overwriting — Vercel installs deps from `app/`, so `stripe` must be listed there.

---

## 6. Deploy order

1. Run both SQL files in Supabase.
2. Add all env vars to the app project.
3. Create Stripe products + webhook + portal.
4. Commit/push, then redeploy the app project (Vercel auto-installs `stripe`).

---

## 7. Smoke test

- Sign in → generate a render → badge ticks down; `usage.renders_used` increments in Supabase.
- Set your `usage.renders_used` to the limit → render is blocked with the upgrade overlay (402).
- Pick a plan → Stripe Checkout (trial) → on return, subscription row updates to `trialing`/`active`.
- Build a quote → **Save & Send for Approval** → open the approval link in a private window → Approve → you receive the decision email and "My Quotes" shows **Approved**.

---

## 8. Open items / product calls

- **Function duration:** renders take 20–40s; `/api/generate` requests `maxDuration: 60`. Confirm your Vercel plan allows it — if a render times out *after* the quota is consumed, that render isn't refunded.
- **`past_due` grace:** users whose card fails keep access during Stripe's retry window (set in `consume_render`). Flip to immediate cutoff if you prefer.
- **Model id:** `gemini-3.1-flash-image-preview` is assumed valid on your key (unchanged from before).
- **DMARC:** still the missing DNS record from the original spec — add it to improve auth/approval email deliverability.
- **Optional:** the pre-existing `logos` bucket has the same un-scoped write policy the `quotes` bucket used to; harden it the same way if desired.
