-- ============================================================
-- FINALOOK — store the full quote state so quotes can be re-opened/duplicated.
-- Run in the Supabase SQL editor. Safe to re-run.
-- ============================================================
alter table public.quotes add column if not exists payload jsonb;
