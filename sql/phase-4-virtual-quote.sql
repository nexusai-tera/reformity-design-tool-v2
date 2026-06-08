-- ============================================================
-- FINALOOK — Phase 4: Virtual Quote (branded homeowner lead-gen page)
-- Run in the Supabase SQL editor. Safe to re-run.
--
-- Adds: a public "slug" + virtual-quote settings on profiles, a leads
-- table, a public 'leads' storage bucket, and ABUSE-PROTECTED functions
-- so anonymous homeowners can't run up unlimited Gemini renders:
--   * public_render_cap(plan,status) — monthly cap by plan (0 = off)
--   * q_lookup(slug)                  — branding + availability (read)
--   * consume_public_render(slug)     — atomic cap check + consume
-- ============================================================
create extension if not exists pgcrypto;

alter table public.profiles add column if not exists slug text unique;
alter table public.profiles add column if not exists public_quote_enabled boolean default false;
alter table public.profiles add column if not exists public_renders_used int default 0;
alter table public.profiles add column if not exists public_period_start timestamptz default now();

create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete cascade,
  name text, email text, phone text, trade text,
  photo_url text, render_url text,
  status text default 'new',          -- new | contacted | won | lost
  source text default 'virtual_quote',
  created_at timestamptz default now()
);
create index if not exists leads_user_idx on public.leads(user_id);

alter table public.leads enable row level security;
drop policy if exists "leads_select" on public.leads;
drop policy if exists "leads_update" on public.leads;
drop policy if exists "leads_delete" on public.leads;
create policy "leads_select" on public.leads for select using (auth.uid() = user_id);
create policy "leads_update" on public.leads for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "leads_delete" on public.leads for delete using (auth.uid() = user_id);
-- Lead inserts happen server-side via the service_role key (the public page),
-- so there is intentionally no anon/authenticated insert policy.

-- Public-read bucket for homeowner photos + their renders.
insert into storage.buckets (id, name, public) values ('leads','leads',true) on conflict (id) do nothing;
drop policy if exists "leads_read" on storage.objects;
create policy "leads_read" on storage.objects for select to public using (bucket_id='leads');
-- Writes are server-side (service_role), so no authenticated write policy is needed.

-- Monthly public-render cap by plan (0 = feature off). Keeps anonymous Gemini cost bounded.
create or replace function public.public_render_cap(p_plan text, p_status text)
returns int language sql immutable as $$
  select case
    when p_status not in ('active','trialing') then 0
    when lower(coalesce(p_plan,'')) = 'crew'  then 200
    when lower(coalesce(p_plan,'')) = 'pro'   then 50
    when lower(coalesce(p_plan,'')) = 'trial' then 10   -- let trial users demo it
    else 0                                              -- Solo: not included
  end;
$$;

-- Read-only: contractor branding + whether the public page can render right now.
create or replace function public.q_lookup(p_slug text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_uid uuid; v_company text; v_logo text; v_enabled boolean; v_used int; v_ps timestamptz; v_plan text; v_status text; v_cap int;
begin
  select id, company_name, logo_url, public_quote_enabled, public_renders_used, public_period_start
    into v_uid, v_company, v_logo, v_enabled, v_used, v_ps
    from public.profiles where lower(slug)=lower(p_slug) limit 1;
  if v_uid is null then return jsonb_build_object('found', false); end if;
  select plan, status into v_plan, v_status from public.subscriptions where user_id=v_uid order by created_at desc limit 1;
  if v_ps < now() - interval '30 days' then v_used := 0; end if;
  v_cap := public.public_render_cap(v_plan, v_status);
  return jsonb_build_object('found', true, 'company', v_company, 'logo', v_logo,
    'enabled', coalesce(v_enabled,false), 'available', (coalesce(v_enabled,false) and v_cap > v_used));
end; $$;

-- Atomic: check the contractor's monthly public-render cap and consume one.
create or replace function public.consume_public_render(p_slug text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_uid uuid; v_enabled boolean; v_used int; v_ps timestamptz; v_plan text; v_status text; v_cap int;
begin
  select id, public_quote_enabled, public_renders_used, public_period_start
    into v_uid, v_enabled, v_used, v_ps
    from public.profiles where lower(slug)=lower(p_slug) limit 1 for update;
  if v_uid is null then return jsonb_build_object('allowed', false, 'reason', 'not_found'); end if;
  if not coalesce(v_enabled,false) then return jsonb_build_object('allowed', false, 'reason', 'disabled'); end if;
  select plan, status into v_plan, v_status from public.subscriptions where user_id=v_uid order by created_at desc limit 1;
  if v_ps < now() - interval '30 days' then v_used := 0; v_ps := now(); update public.profiles set public_renders_used=0, public_period_start=v_ps where id=v_uid; end if;
  v_cap := public.public_render_cap(v_plan, v_status);
  if v_used >= v_cap then return jsonb_build_object('allowed', false, 'reason', 'cap_reached'); end if;
  update public.profiles set public_renders_used = v_used + 1 where id = v_uid;
  return jsonb_build_object('allowed', true, 'user_id', v_uid);
end; $$;

revoke all on function public.public_render_cap(text,text)   from public, anon, authenticated;
revoke all on function public.q_lookup(text)                 from public, anon, authenticated;
revoke all on function public.consume_public_render(text)    from public, anon, authenticated;
grant execute on function public.public_render_cap(text,text) to service_role;
grant execute on function public.q_lookup(text)               to service_role;
grant execute on function public.consume_public_render(text)  to service_role;
