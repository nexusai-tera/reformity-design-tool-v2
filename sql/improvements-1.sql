-- ============================================================
-- FINALOOK — Hardening & data-model improvements
-- Run in the Supabase SQL editor. Safe to re-run.
-- ============================================================

-- 1) Idempotent Stripe event handling — prevents double-granting top-up
--    credits if Stripe re-delivers checkout.session.completed.
create table if not exists public.stripe_events (
  id text primary key,
  created_at timestamptz default now()
);
alter table public.stripe_events enable row level security;  -- server-only (no policies = no client access)

create or replace function public.grant_topup_credits(p_session_id text, p_user_id uuid, p_qty int)
returns boolean language plpgsql security definer set search_path=public as $$
declare v_cnt int;
begin
  insert into public.stripe_events(id) values (p_session_id) on conflict (id) do nothing;
  get diagnostics v_cnt = row_count;          -- 1 = first time, 0 = already processed
  if v_cnt = 1 then
    update public.usage
       set render_credits = greatest(coalesce(render_credits,0) + greatest(coalesce(p_qty,0),0), 0)
     where user_id = public.account_id(p_user_id);
    return true;
  end if;
  return false;
end; $$;
revoke all on function public.grant_topup_credits(text,uuid,int) from public, anon, authenticated;
grant execute on function public.grant_topup_credits(text,uuid,int) to service_role;

-- 2) First-class columns on quotes so Leads/Dashboard don't scan JSON payloads.
alter table public.quotes add column if not exists lead_id uuid references public.leads(id) on delete set null;
alter table public.quotes add column if not exists project text;
alter table public.quotes add column if not exists followed_up_at timestamptz;
create index if not exists quotes_lead_idx on public.quotes(lead_id);
