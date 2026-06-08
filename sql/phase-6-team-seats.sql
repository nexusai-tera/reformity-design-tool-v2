-- ============================================================
-- FINALOOK — Phase 6: Team seats
-- Members share one team owner's subscription, render quota, branding,
-- quotes, and leads. Built backward-compatibly: a standalone user's
-- account_id() is just themselves, so existing single-user behaviour is
-- unchanged. Run in the Supabase SQL editor. Safe to re-run.
--
-- ⚠ This changes Row-Level Security on quotes/leads/usage/subscriptions/
-- profiles + storage. After running, TEST data isolation: a member should
-- see only their team's data, and a user from another team should see none.
-- ============================================================
create extension if not exists pgcrypto;

-- A member points at their team owner. NULL = standalone owner.
alter table public.profiles add column if not exists owner_id uuid references public.profiles(id) on delete set null;

-- Effective account for a user = their team owner, or themselves.
create or replace function public.account_id(p_uid uuid)
returns uuid language sql stable security definer set search_path=public as $$
  select coalesce((select owner_id from public.profiles where id = p_uid), p_uid);
$$;
grant execute on function public.account_id(uuid) to authenticated, anon, service_role;

-- Total seats per plan (including the owner).
create or replace function public.seat_cap(p_plan text)
returns int language sql immutable as $$
  select case lower(coalesce(p_plan,''))
    when 'crew' then 9999
    when 'pro'  then 3
    else 1
  end;
$$;

create table if not exists public.team_invites (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references public.profiles(id) on delete cascade,
  email text not null,
  status text default 'pending',     -- pending | accepted
  created_at timestamptz default now()
);
create index if not exists team_invites_email_idx on public.team_invites (lower(email));
alter table public.team_invites enable row level security;
drop policy if exists "invites_owner_all" on public.team_invites;
create policy "invites_owner_all" on public.team_invites for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

-- The logged-in user self-joins a team they were invited to (seat-checked).
create or replace function public.accept_pending_invite()
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_uid uuid; v_email text; v_inv record; v_owner uuid; v_plan text; v_cap int; v_count int; v_already uuid;
begin
  v_uid := auth.uid();
  if v_uid is null then return jsonb_build_object('joined', false, 'reason','no_user'); end if;
  select owner_id into v_already from public.profiles where id = v_uid;
  if v_already is not null then return jsonb_build_object('joined', true, 'reason','already_member'); end if;
  select email into v_email from public.profiles where id = v_uid;
  if v_email is null then return jsonb_build_object('joined', false, 'reason','no_email'); end if;
  select * into v_inv from public.team_invites where lower(email)=lower(v_email) and status='pending' order by created_at desc limit 1;
  if v_inv.id is null then return jsonb_build_object('joined', false, 'reason','no_invite'); end if;
  v_owner := v_inv.owner_id;
  if v_owner = v_uid then return jsonb_build_object('joined', false, 'reason','self'); end if;
  select plan into v_plan from public.subscriptions where user_id=v_owner order by created_at desc limit 1;
  v_cap := public.seat_cap(v_plan);
  select count(*) into v_count from public.profiles where owner_id = v_owner;   -- existing members
  if (v_count + 2) > v_cap then return jsonb_build_object('joined', false, 'reason','no_seats'); end if;  -- owner + members
  update public.profiles set owner_id = v_owner where id = v_uid;
  update public.team_invites set status='accepted' where id = v_inv.id;
  return jsonb_build_object('joined', true, 'reason','ok');
end; $$;
grant execute on function public.accept_pending_invite() to authenticated;

-- ---- Account-scoped RLS (backward-compatible: account_id = self for solo) ----
drop policy if exists "profiles_select" on public.profiles;
drop policy if exists "profiles_update" on public.profiles;
create policy "profiles_select" on public.profiles for select
  using (id = auth.uid() or id = public.account_id(auth.uid()) or owner_id = auth.uid());
create policy "profiles_update" on public.profiles for update
  using (id = public.account_id(auth.uid())) with check (id = public.account_id(auth.uid()));

drop policy if exists "quotes_select" on public.quotes;
drop policy if exists "quotes_insert" on public.quotes;
drop policy if exists "quotes_update" on public.quotes;
drop policy if exists "quotes_delete" on public.quotes;
create policy "quotes_select" on public.quotes for select using (user_id = public.account_id(auth.uid()));
create policy "quotes_insert" on public.quotes for insert with check (user_id = public.account_id(auth.uid()));
create policy "quotes_update" on public.quotes for update using (user_id = public.account_id(auth.uid())) with check (user_id = public.account_id(auth.uid()));
create policy "quotes_delete" on public.quotes for delete using (user_id = public.account_id(auth.uid()));

drop policy if exists "leads_select" on public.leads;
drop policy if exists "leads_update" on public.leads;
drop policy if exists "leads_delete" on public.leads;
create policy "leads_select" on public.leads for select using (user_id = public.account_id(auth.uid()));
create policy "leads_update" on public.leads for update using (user_id = public.account_id(auth.uid())) with check (user_id = public.account_id(auth.uid()));
create policy "leads_delete" on public.leads for delete using (user_id = public.account_id(auth.uid()));

drop policy if exists "usage_select" on public.usage;
create policy "usage_select" on public.usage for select using (user_id = public.account_id(auth.uid()));

drop policy if exists "subs_select" on public.subscriptions;
create policy "subs_select" on public.subscriptions for select using (user_id = public.account_id(auth.uid()));

-- ---- Storage: allow writing under the team account's folder ----
drop policy if exists "logo_upload" on storage.objects;
drop policy if exists "logo_update" on storage.objects;
create policy "logo_upload" on storage.objects for insert to authenticated
  with check (bucket_id='logos' and (storage.foldername(name))[1] = public.account_id(auth.uid())::text);
create policy "logo_update" on storage.objects for update to authenticated
  using (bucket_id='logos' and (storage.foldername(name))[1] = public.account_id(auth.uid())::text);

drop policy if exists "quote_upload" on storage.objects;
drop policy if exists "quote_update" on storage.objects;
create policy "quote_upload" on storage.objects for insert to authenticated
  with check (bucket_id='quotes' and (storage.foldername(name))[1] = public.account_id(auth.uid())::text);
create policy "quote_update" on storage.objects for update to authenticated
  using (bucket_id='quotes' and (storage.foldername(name))[1] = public.account_id(auth.uid())::text);

-- ---- consume_render / refund_render resolve the team account ----
create or replace function public.consume_render(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_acct uuid; v_plan text; v_status text; v_trial_ends timestamptz;
  v_used int; v_row_limit int; v_limit_type text; v_period_start timestamptz; v_eff_limit int;
begin
  v_acct := public.account_id(p_user_id);
  select renders_used, render_limit, limit_type, period_start
    into v_used, v_row_limit, v_limit_type, v_period_start
    from public.usage where user_id = v_acct order by created_at asc limit 1 for update;
  if not found then return jsonb_build_object('allowed', false, 'reason', 'no_usage_row'); end if;
  select plan, status, trial_ends_at into v_plan, v_status, v_trial_ends
    from public.subscriptions where user_id = v_acct order by created_at desc limit 1;
  if v_status is null then return jsonb_build_object('allowed', false, 'reason', 'no_subscription'); end if;
  if coalesce(v_limit_type, 'monthly') <> 'total' and v_period_start < now() - interval '30 days' then
    v_used := 0; v_period_start := now();
    update public.usage set renders_used = 0, period_start = v_period_start where user_id = v_acct;
  end if;
  if v_status = 'trialing' then
    if v_trial_ends is not null and now() >= v_trial_ends then
      return jsonb_build_object('allowed', false, 'reason', 'trial_expired', 'plan', v_plan, 'status', v_status, 'used', v_used, 'limit', v_row_limit);
    end if;
    v_eff_limit := v_row_limit;
  elsif v_status in ('active', 'past_due') then
    v_eff_limit := public.plan_render_limit(v_plan, v_row_limit);
  else
    return jsonb_build_object('allowed', false, 'reason', 'inactive_subscription', 'plan', v_plan, 'status', v_status, 'used', v_used);
  end if;
  if v_eff_limit is not null and v_used >= v_eff_limit then
    return jsonb_build_object('allowed', false, 'reason', 'limit_reached', 'plan', v_plan, 'status', v_status, 'used', v_used, 'limit', v_eff_limit, 'remaining', 0);
  end if;
  update public.usage set renders_used = v_used + 1 where user_id = v_acct;
  return jsonb_build_object('allowed', true, 'reason', 'ok', 'plan', v_plan, 'status', v_status,
    'used', v_used + 1, 'limit', v_eff_limit, 'remaining', case when v_eff_limit is null then null else v_eff_limit - (v_used + 1) end);
end; $$;

create or replace function public.refund_render(p_user_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.usage set renders_used = greatest(renders_used - 1, 0) where user_id = public.account_id(p_user_id);
end; $$;
