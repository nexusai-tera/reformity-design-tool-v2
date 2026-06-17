-- ============================================================
-- FINALOOK — "Viewed" tracking for quotes.
-- Records when a client first opens the approval link.
-- Run in the Supabase SQL editor. Safe to re-run.
-- ============================================================
alter table public.quotes add column if not exists viewed_at timestamptz;
