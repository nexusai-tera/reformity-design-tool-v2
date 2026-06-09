-- ============================================================
-- FINALOOK — Pricing migration: Core ($199) / Pro ($299)
-- Clean slate (no grandfathering) + render-credit top-ups.
--
-- PREREQUISITES (run these first, in order, if you haven't):
--   sql/phase-4-virtual-quote.sql
--   sql/phase-6-team-seats.sql      (defines public.account_id)
--
-- Safe to run multiple times. "Success. No rows returned" = success.
-- ============================================================

-- 1) Monthly render allotment per plan. NULL = unlimited.
create or replace function public.plan_render_limit(p_plan text, p_fallback int)
returns int language sql immutable as $$
  select case lower(coalesce(p_plan, ''))
    when 'core' then 30
    when 'pro'  then 100
    when 'solo' then 30        -- legacy, harmless
    when 'crew' then null      -- legacy, harmless
    else p_fallback            -- trial / unknown -> usage.render_limit
  end;
$$;

-- 2) Render-credit balance (top-ups). Persists across the monthly reset.
alter table public.usage add column if not exists render_credits int not null default 0;

-- 3) Add purchased credits to an account (called by the Stripe webhook).
create or replace function public.add_render_credits(p_user_id uuid, p_qty int)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.usage
     set render_credits = greatest(coalesce(render_credits, 0) + coalesce(p_qty, 0), 0)
   where user_id = public.account_id(p_user_id);
end; $$;

-- 4) consume_render — account-aware, with top-up overflow + bucket in the result.
create or replace function public.consume_render(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_acct uuid; v_plan text; v_status text; v_trial_ends timestamptz;
  v_used int; v_row_limit int; v_limit_type text; v_period_start timestamptz;
  v_eff_limit int; v_credits int;
begin
  v_acct := public.account_id(p_user_id);
  select renders_used, render_limit, limit_type, period_start, coalesce(render_credits, 0)
    into v_used, v_row_limit, v_limit_type, v_period_start, v_credits
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

  -- Monthly allotment exhausted? Fall back to purchased top-up credits.
  if v_eff_limit is not null and v_used >= v_eff_limit then
    if v_credits > 0 then
      update public.usage set render_credits = v_credits - 1 where user_id = v_acct;
      return jsonb_build_object('allowed', true, 'reason', 'ok', 'bucket', 'credit',
        'plan', v_plan, 'status', v_status, 'used', v_used, 'limit', v_eff_limit,
        'credits', v_credits - 1, 'remaining', 0);
    end if;
    return jsonb_build_object('allowed', false, 'reason', 'limit_reached',
      'plan', v_plan, 'status', v_status, 'used', v_used, 'limit', v_eff_limit, 'remaining', 0, 'credits', v_credits);
  end if;

  -- Consume from the monthly bucket.
  update public.usage set renders_used = v_used + 1 where user_id = v_acct;
  return jsonb_build_object('allowed', true, 'reason', 'ok', 'bucket', 'monthly',
    'plan', v_plan, 'status', v_status, 'used', v_used + 1, 'limit', v_eff_limit, 'credits', v_credits,
    'remaining', case when v_eff_limit is null then null else v_eff_limit - (v_used + 1) end);
end; $$;

-- 5) refund_render — reverse the right bucket. Drop the old 1-arg form first.
drop function if exists public.refund_render(uuid);
create or replace function public.refund_render(p_user_id uuid, p_bucket text default 'monthly')
returns void language plpgsql security definer set search_path = public as $$
declare v_acct uuid;
begin
  v_acct := public.account_id(p_user_id);
  if lower(coalesce(p_bucket, 'monthly')) = 'credit' then
    update public.usage set render_credits = coalesce(render_credits, 0) + 1 where user_id = v_acct;
  else
    update public.usage set renders_used = greatest(renders_used - 1, 0) where user_id = v_acct;
  end if;
end; $$;

-- 6) Virtual Quote monthly lead cap. Core = off (0). Pro = unlimited (NULL).
create or replace function public.public_render_cap(p_plan text, p_status text)
returns int language sql immutable as $$
  select case
    when p_status not in ('active','trialing') then 0
    when lower(coalesce(p_plan,'')) = 'pro'   then null   -- unlimited
    when lower(coalesce(p_plan,'')) = 'crew'  then 200    -- legacy
    when lower(coalesce(p_plan,'')) = 'trial' then 10     -- trial demo
    else 0                                                -- Core / Solo: not included
  end;
$$;

-- 7) q_lookup — branding + availability (NULL cap = unlimited).
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
    'enabled', coalesce(v_enabled,false),
    'available', (coalesce(v_enabled,false) and (v_cap is null or v_cap > v_used)));
end; $$;

-- 8) consume_public_render — NULL cap = unlimited.
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
  if v_cap is not null and v_used >= v_cap then return jsonb_build_object('allowed', false, 'reason', 'cap_reached'); end if;
  update public.profiles set public_renders_used = v_used + 1 where id = v_uid;
  return jsonb_build_object('allowed', true, 'user_id', v_uid);
end; $$;

-- 9) Re-lock execution to the server (service_role) only.
revoke all on function public.plan_render_limit(text,int)     from public, anon, authenticated;
revoke all on function public.consume_render(uuid)            from public, anon, authenticated;
revoke all on function public.refund_render(uuid,text)        from public, anon, authenticated;
revoke all on function public.add_render_credits(uuid,int)    from public, anon, authenticated;
revoke all on function public.public_render_cap(text,text)    from public, anon, authenticated;
revoke all on function public.q_lookup(text)                  from public, anon, authenticated;
revoke all on function public.consume_public_render(text)     from public, anon, authenticated;
grant execute on function public.plan_render_limit(text,int)  to service_role;
grant execute on function public.consume_render(uuid)         to service_role;
grant execute on function public.refund_render(uuid,text)     to service_role;
grant execute on function public.add_render_credits(uuid,int) to service_role;
grant execute on function public.public_render_cap(text,text) to service_role;
grant execute on function public.q_lookup(text)               to service_role;
grant execute on function public.consume_public_render(text)  to service_role;
