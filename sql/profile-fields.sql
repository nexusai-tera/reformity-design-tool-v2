-- ============================================================
-- FINALOOK — split profile contact + address into separate columns.
-- Run in the Supabase SQL editor. Safe to re-run.
-- ============================================================
alter table public.profiles add column if not exists contact_phone     text;
alter table public.profiles add column if not exists contact_email     text;
alter table public.profiles add column if not exists business_city      text;
alter table public.profiles add column if not exists business_province  text;
alter table public.profiles add column if not exists business_postal    text;
