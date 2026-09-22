begin;

-- The original auth_challenges table only allowed signup challenges.
-- Password recovery must use an explicitly different purpose so that
-- signup codes can never be treated as password-reset authorization.
alter table public.auth_challenges
  drop constraint if exists auth_challenges_purpose_check;

alter table public.auth_challenges
  add constraint auth_challenges_purpose_check
    check (purpose in ('signup', 'password_reset'));

-- Speed up password-reset challenge lookups by normalized email.
create index if not exists auth_challenges_password_reset_email_idx
  on public.auth_challenges (lower(email), created_at desc)
  where purpose = 'password_reset';

-- There should only be one unfinished password-reset challenge for an
-- email at a time. Expired challenges are deliberately still considered
-- active until the request function retires them.
create unique index if not exists auth_challenges_one_active_password_reset_idx
  on public.auth_challenges (lower(email))
  where purpose = 'password_reset'
    and consumed_at is null;

-- Reserve a password-reset email request.
--
-- Behaviour:
--   * first request creates the challenge
--   * subsequent requests have a 60-second cooldown
--   * at most five resends are allowed during the 24-hour challenge window
--   * verification attempts are preserved when another code is requested
--   * an expired OTP can be renewed while the 24-hour challenge is eligible
--   * requests for the same email are serialized to avoid duplicate rows
create or replace function public.reserve_password_reset_request(
  p_email text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  normalized_email text := lower(btrim(p_email));
  challenge public.auth_challenges%rowtype;
  new_challenge_id uuid;
begin
  if normalized_email is null or normalized_email = '' then
    return jsonb_build_object(
      'status', 'invalid'
    );
  end if;

  -- Serialize password-reset activity for this email address.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'mova-password-reset:' || normalized_email,
      0
    )
  );

  select *
  into challenge
  from public.auth_challenges
  where purpose = 'password_reset'
    and lower(email) = normalized_email
    and consumed_at is null
  order by created_at desc
  limit 1
  for update;

  if found then
    -- A 24-hour request window has ended. Retire it and allow a fresh one.
    if challenge.created_at <= now() - interval '24 hours' then
      update public.auth_challenges
      set consumed_at = now()
      where id = challenge.id;

    -- Attempts/resend budgets must not be bypassed by requesting another code.
    elsif challenge.attempts >= 5
       or challenge.resend_count >= 5 then
      return jsonb_build_object(
        'status', 'invalid'
      );

    elsif challenge.next_resend_at > now() then
      return jsonb_build_object(
        'status', 'cooldown'
      );

    else
      update public.auth_challenges
      set
        expires_at = now() + interval '10 minutes',
        next_resend_at = now() + interval '60 seconds',
        resend_count = resend_count + 1
      where id = challenge.id;

      return jsonb_build_object(
        'status', 'ready',
        'challengeId', challenge.id,
        'email', normalized_email
      );
    end if;
  end if;

  insert into public.auth_challenges (
    email,
    purpose
  )
  values (
    normalized_email,
    'password_reset'
  )
  returning id into new_challenge_id;

  return jsonb_build_object(
    'status', 'ready',
    'challengeId', new_challenge_id,
    'email', normalized_email
  );
end;
$$;

-- Reserve one password-reset verification attempt.
--
-- The attempt is counted BEFORE Supabase verifies the recovery OTP.
-- This prevents concurrent or repeated guesses from bypassing the
-- five-attempt limit.
create or replace function public.reserve_password_reset_attempt(
  p_email text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  normalized_email text := lower(btrim(p_email));
  challenge public.auth_challenges%rowtype;
begin
  if normalized_email is null or normalized_email = '' then
    return jsonb_build_object(
      'status', 'invalid'
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'mova-password-reset:' || normalized_email,
      0
    )
  );

  select *
  into challenge
  from public.auth_challenges
  where purpose = 'password_reset'
    and lower(email) = normalized_email
    and consumed_at is null
  order by created_at desc
  limit 1
  for update;

  if not found then
    return jsonb_build_object(
      'status', 'invalid'
    );
  end if;

  if challenge.created_at <= now() - interval '24 hours'
    or challenge.expires_at <= now()
    or challenge.attempts >= 5
  then
    return jsonb_build_object(
      'status', 'invalid'
    );
  end if;

  update public.auth_challenges
  set attempts = attempts + 1
  where id = challenge.id;

  return jsonb_build_object(
    'status', 'ready',
    'challengeId', challenge.id,
    'email', normalized_email
  );
end;
$$;

-- Complete a successfully verified password-reset challenge exactly once.
--
-- The backend will call this only after Supabase accepts a recovery OTP.
-- Marking it consumed prevents the application's challenge from being reused
-- even if another request reaches the backend concurrently.
create or replace function public.complete_password_reset_challenge(
  p_challenge_id uuid
)
returns boolean
language sql
security invoker
set search_path = ''
as $$
  with completed as (
    update public.auth_challenges
    set consumed_at = now()
    where id = p_challenge_id
      and purpose = 'password_reset'
      and consumed_at is null
      and expires_at > now()
      and created_at > now() - interval '24 hours'
      and attempts between 1 and 5
    returning id
  )
  select exists(
    select 1
    from completed
  );
$$;

-- These functions are backend-only.
revoke all on function public.reserve_password_reset_request(text)
  from public, anon, authenticated;

revoke all on function public.reserve_password_reset_attempt(text)
  from public, anon, authenticated;

revoke all on function public.complete_password_reset_challenge(uuid)
  from public, anon, authenticated;

grant execute on function public.reserve_password_reset_request(text)
  to service_role;

grant execute on function public.reserve_password_reset_attempt(text)
  to service_role;

grant execute on function public.complete_password_reset_challenge(uuid)
  to service_role;

commit;