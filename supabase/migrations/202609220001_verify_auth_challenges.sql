begin;

-- Count an attempt only while the challenge is valid.
-- The update is atomic, including concurrent requests.
create function public.reserve_signup_attempt(p_challenge_id uuid)
returns text
language sql
security invoker
set search_path = ''
as $$
  update public.auth_challenges
  set attempts = attempts + 1
  where id = p_challenge_id
    and purpose = 'signup'
    and consumed_at is null
    and expires_at > now()
    and attempts < 5
  returning email;
$$;

-- Allow a successful challenge to be completed only once.
create function public.complete_signup_challenge(p_challenge_id uuid)
returns boolean
language sql
security invoker
set search_path = ''
as $$
  with completed as (
    update public.auth_challenges
    set consumed_at = now()
    where id = p_challenge_id
      and purpose = 'signup'
      and consumed_at is null
      and expires_at > now()
      and attempts between 1 and 5
    returning id
  )
  select exists(select 1 from completed);
$$;

revoke all on function public.reserve_signup_attempt(uuid)
  from public, anon, authenticated;

revoke all on function public.complete_signup_challenge(uuid)
  from public, anon, authenticated;

grant execute on function public.reserve_signup_attempt(uuid)
  to service_role;

grant execute on function public.complete_signup_challenge(uuid)
  to service_role;

commit;