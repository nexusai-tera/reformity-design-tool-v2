-- ============================================================
-- FINALOOK — Phase 3: CRM (saved quotes + client approval loop)
-- Run in the Supabase SQL editor (project uywzmgjmlnodjlbnwyty).
-- Safe to re-run.
-- ============================================================

create extension if not exists pgcrypto;

create table if not exists public.quotes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete cascade,
  quote_number    text,
  client_name     text,
  client_email    text,
  project_address text,
  company_name    text,                              -- snapshot for the approval page
  logo_url        text,                              -- snapshot
  total           numeric,
  currency        text default 'CAD',
  pdf_url         text,
  render_url      text,
  status          text default 'draft',              -- draft | sent | approved | declined
  public_token    text unique default encode(gen_random_bytes(16), 'hex'),
  client_note     text,
  sent_at         timestamptz,
  decided_at      timestamptz,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

create index if not exists quotes_user_idx  on public.quotes(user_id);
create index if not exists quotes_token_idx on public.quotes(public_token);

alter table public.quotes enable row level security;

-- Owners manage only their own quotes. Public (client) approval access is
-- handled server-side via the service_role key + the public_token, so there is
-- intentionally NO anon RLS policy on this table.
drop policy if exists "quotes_select" on public.quotes;
drop policy if exists "quotes_insert" on public.quotes;
drop policy if exists "quotes_update" on public.quotes;
drop policy if exists "quotes_delete" on public.quotes;
create policy "quotes_select" on public.quotes for select using (auth.uid() = user_id);
create policy "quotes_insert" on public.quotes for insert with check (auth.uid() = user_id);
create policy "quotes_update" on public.quotes for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "quotes_delete" on public.quotes for delete using (auth.uid() = user_id);

-- Public-read storage bucket for saved quote PDFs + render snapshots.
insert into storage.buckets (id, name, public)
  values ('quotes', 'quotes', true)
  on conflict (id) do nothing;

drop policy if exists "quote_upload" on storage.objects;
drop policy if exists "quote_update" on storage.objects;
drop policy if exists "quote_read"   on storage.objects;
-- Owner-scoped writes: a user may only write under their own "<uid>/" folder,
-- so one contractor cannot overwrite another's quote PDF/render.
create policy "quote_upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'quotes' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "quote_update" on storage.objects for update to authenticated
  using (bucket_id = 'quotes' and (storage.foldername(name))[1] = auth.uid()::text);
-- No public SELECT policy: the bucket is public, so the approval page loads the
-- PDF/render via their public URLs. Omitting SELECT blocks anonymous listing /
-- enumeration of every quote in the bucket.
