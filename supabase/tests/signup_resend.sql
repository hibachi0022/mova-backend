begin;

do $$
declare
  test_id uuid := gen_random_uuid();
  result jsonb;
  saved_attempts integer;
  saved_resends integer;
  saved_expiry timestamptz;
  iteration integer;
begin
  -- Only this temporary row is changed.
  insert into public.auth_challenges (
    id,
    email,
    attempts,
    created_at,
    expires_at,
    next_resend_at
  )
  values (
    test_id,
    'resend-test@example.invalid',
    2,
    now() - interval '20 minutes',
    now() - interval '10 minutes',
    now() - interval '1 second'
  );

  -- Expired codes can be resent while the challenge remains eligible.
  result := public.reserve_signup_resend(test_id);

  if result->>'status' is distinct from 'ready' then
    raise exception 'FAIL: first resend should be allowed';
  end if;

  -- Repeated requests must be blocked.
  result := public.reserve_signup_resend(test_id);

  if result->>'status' is distinct from 'cooldown' then
    raise exception 'FAIL: immediate resend should hit cooldown';
  end if;

  if public.finish_signup_resend(test_id) is distinct from true then
    raise exception 'FAIL: challenge renewal should succeed';
  end if;

  select attempts, resend_count, expires_at
  into saved_attempts, saved_resends, saved_expiry
  from public.auth_challenges
  where id = test_id;

  if saved_attempts is distinct from 2 then
    raise exception 'FAIL: resend must preserve verification attempts';
  end if;

  if saved_resends is distinct from 1 then
    raise exception 'FAIL: blocked requests must not increase resend count';
  end if;

  if saved_expiry is distinct from now() + interval '10 minutes' then
    raise exception 'FAIL: renewal should grant ten minutes';
  end if;

  -- Advance only the test row's cooldown, without waiting.
  for iteration in 2..5 loop
    update public.auth_challenges
    set next_resend_at = now() - interval '1 second'
    where id = test_id;

    result := public.reserve_signup_resend(test_id);

    if result->>'status' is distinct from 'ready' then
      raise exception 'FAIL: resend % should be allowed', iteration;
    end if;
  end loop;

  update public.auth_challenges
  set next_resend_at = now() - interval '1 second'
  where id = test_id;

  result := public.reserve_signup_resend(test_id);

  if result->>'status' is distinct from 'invalid' then
    raise exception 'FAIL: sixth resend must be rejected';
  end if;

  -- Isolate the consumed-challenge rule.
  update public.auth_challenges
  set resend_count = 0,
      consumed_at = now()
  where id = test_id;

  result := public.reserve_signup_resend(test_id);

  if result->>'status' is distinct from 'invalid' then
    raise exception 'FAIL: consumed challenge must be rejected';
  end if;

  -- Isolate the exhausted-attempt rule.
  update public.auth_challenges
  set consumed_at = null,
      attempts = 5
  where id = test_id;

  result := public.reserve_signup_resend(test_id);

  if result->>'status' is distinct from 'invalid' then
    raise exception 'FAIL: exhausted verification attempts must be rejected';
  end if;

  -- Client roles must not be able to call these functions directly.
  if has_function_privilege(
    'anon', 'public.reserve_signup_resend(uuid)', 'EXECUTE'
  ) or has_function_privilege(
    'authenticated', 'public.reserve_signup_resend(uuid)', 'EXECUTE'
  ) or has_function_privilege(
    'anon', 'public.finish_signup_resend(uuid)', 'EXECUTE'
  ) or has_function_privilege(
    'authenticated', 'public.finish_signup_resend(uuid)', 'EXECUTE'
  ) then
    raise exception 'FAIL: client roles have access to resend functions';
  end if;
end;
$$;

select 'PASS: resend database checks completed' as result;

rollback;