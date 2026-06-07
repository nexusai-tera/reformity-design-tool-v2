-- ============================================================
-- FINALOOK — Phase 2D: Secure Render API + Usage Enforcement
-- Run this in the Supabase SQL editor (project uywzmgjmlnodjlbnwyty).
-- Safe to re-run (idempotent: create or replace + revoke/grant).
--
-- What it does:
--   * plan_render_limit()  — maps a plan name to a monthly render limit
--   * consume_render()     — atomically checks quota + consumes ONE render
--   * refund_render()      — gives a render back if the Gemini call failed
-- Enforcement lives in the DATABASE so it cannot be bypassed from the browser.
-- Only the server (service_role) may execute these functions.
-- ============================================================

-- Plan -> monthly render limit. NULL = unlimited.
create or replace function public.plan_render_limit(p_plan text, p_fallback int)
returns int
language sql
immutable
as $$
  select case lower(coalesce(p_plan, ''))
    when 'solo' then 30
    when 'pro'  then 100
    when 'crew' then null      -- unlimited
    else p_fallback            -- trial / unknown -> fall back to usage.render_limit
  end;
$$;

-- ------------------------------------------------------------
-- consume_render(user_id)
-- Returns jsonb:
--   { allowed, reason, plan, status, used, "limit", remaining }
-- allowed=true means one render has been consumed (renders_used += 1).
-- ------------------------------------------------------------
create or replace function public.consume_render(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan         text;
  v_status       text;
  v_trial_ends   timestamptz;
  v_used         int;
  v_row_limit    int;
  v_limit_type   text;
  v_period_start timestamptz;
  v_eff_limit    int;
begin
  -- Lock this user's usage row for the duration of the transaction
  select renders_used, render_limit, limit_type, period_start
    into v_used, v_row_limit, v_limit_type, v_period_start
    from public.usage
    where user_id = p_user_id
    order by created_at asc
    limit 1
    for update;

  if not found then
    return jsonb_build_object('allowed', false, 'reason', 'no_usage_row');
  end if;

  -- Latest subscription for this user
  select plan, status, trial_ends_at
    into v_plan, v_status, v_trial_ends
    from public.subscriptions
    where user_id = p_user_id
    order by created_at desc
    limit 1;

  if v_status is null then
    return jsonb_build_object('allowed', false, 'reason', 'no_subscription');
  end if;

  -- Monthly reset: roll the window if it is older than ~30 days.
  -- Resets for any non-'total' limit type (including NULL), so a missing
  -- limit_type never permanently locks a user out.
  if coalesce(v_limit_type, 'monthly') <> 'total' and v_period_start < now() - interval '30 days' then
    v_used := 0;
    v_period_start := now();
    update public.usage
      set renders_used = 0, period_start = v_period_start
      where user_id = p_user_id;
  end if;

  -- Determine the effective limit + whether access is allowed at all
  if v_status = 'trialing' then
    if v_trial_ends is not null and now() >= v_trial_ends then
      return jsonb_build_object('allowed', false, 'reason', 'trial_expired',
        'plan', v_plan, 'status', v_status, 'used', v_used, 'limit', v_row_limit);
    end if;
    v_eff_limit := v_row_limit;                       -- trial uses the per-row limit (default 30)

  elsif v_status in ('active', 'past_due') then
    -- 'past_due' keeps access during Stripe's dunning/retry grace window.
    v_eff_limit := public.plan_render_limit(v_plan, v_row_limit);

  else
    -- canceled, past_due, incomplete, unpaid, paused, etc.
    return jsonb_build_object('allowed', false, 'reason', 'inactive_subscription',
      'plan', v_plan, 'status', v_status, 'used', v_used);
  end if;

  -- Enforce the limit (NULL = unlimited)
  if v_eff_limit is not null and v_used >= v_eff_limit then
    return jsonb_build_object('allowed', false, 'reason', 'limit_reached',
      'plan', v_plan, 'status', v_status, 'used', v_used, 'limit', v_eff_limit, 'remaining', 0);
  end if;

  -- Consume one render
  update public.usage
    set renders_used = v_used + 1
    where user_id = p_user_id;

  return jsonb_build_object(
    'allowed', true, 'reason', 'ok',
    'plan', v_plan, 'status', v_status,
    'used', v_used + 1, 'limit', v_eff_limit,
    'remaining', case when v_eff_limit is null then null else v_eff_limit - (v_used + 1) end
  );
end;
$$;

-- ------------------------------------------------------------
-- refund_render(user_id) — compensating action when the render failed
-- ------------------------------------------------------------
create or replace function public.refund_render(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.usage
    set renders_used = greatest(renders_used - 1, 0)
    where user_id = p_user_id;
end;
$$;

-- ------------------------------------------------------------
-- Lock execution down to the server (service_role) only.
-- The browser must NOT be able to call these directly.
-- ------------------------------------------------------------
revoke all on function public.plan_render_limit(text, int) from public, anon, authenticated;
revoke all on function public.consume_render(uuid)         from public, anon, authenticated;
revoke all on function public.refund_render(uuid)          from public, anon, authenticated;
grant execute on function public.plan_render_limit(text, int) to service_role;
grant execute on function public.consume_render(uuid)         to service_role;
grant execute on function public.refund_render(uuid)          to service_role;
