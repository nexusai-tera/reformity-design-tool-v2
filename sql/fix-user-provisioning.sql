-- ============================================================
-- FINALOOK — Fix: auto-provision rows on signup + backfill existing users
-- Symptom this fixes: a logged-in user has NO row in profiles/subscriptions/
-- usage, so renders are blocked, the Stripe webhook updates 0 rows, and
-- onboarding never saves. Run in the Supabase SQL editor. Safe to re-run.
-- ============================================================

-- 1) (Re)install the signup trigger so EVERY new auth user gets provisioned.
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email)
    values (new.id, new.email)
    on conflict (id) do nothing;

  insert into public.subscriptions (user_id, plan, status, trial_ends_at)
    values (new.id, 'trial', 'trialing', now() + interval '14 days');

  insert into public.usage (user_id, renders_used, render_limit, limit_type, period_start)
    values (new.id, 0, 30, 'monthly', now());

  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 2) Backfill any EXISTING users who are missing their rows.
insert into public.profiles (id, email)
  select u.id, u.email
  from auth.users u
  left join public.profiles p on p.id = u.id
  where p.id is null;

insert into public.subscriptions (user_id, plan, status, trial_ends_at)
  select u.id, 'trial', 'trialing', now() + interval '14 days'
  from auth.users u
  left join public.subscriptions s on s.user_id = u.id
  where s.user_id is null;

insert into public.usage (user_id, renders_used, render_limit, limit_type, period_start)
  select u.id, 0, 30, 'monthly', now()
  from auth.users u
  left join public.usage us on us.user_id = u.id
  where us.user_id is null;
