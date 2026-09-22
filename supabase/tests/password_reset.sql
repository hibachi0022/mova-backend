begin;

do $$
declare
  test_tag text := replace(gen_random_uuid()::text, '-', '');

  request_email text;
  attempt_email text;
  old_email text;
  signup_email text;

  result jsonb;

  request_challenge_id uuid;
  attempt_challenge_id uuid;
  replacement_challenge_id uuid;
  old_challenge_id uuid;
  renewed_challenge_id uuid;
  signup_challenge_id uuid;

  saved_attempts integer;
  saved_resends integer;
  saved_purpose text;
  saved_expiry timestamptz;
  saved_consumed_at timestamptz;

  iteration integer;
begin
  request_email :=
    'password-reset-request-' || test_tag || '@example.invalid';

  attempt_email :=
    'password-reset-attempt-' || test_tag || '@example.invalid';

  old_email :=
    'password-reset-old-' || test_tag || '@example.invalid';

  signup_email :=
    'password-reset-signup-' || test_tag || '@example.invalid';

  ----------------------------------------------------------------------
  -- 1. FIRST PASSWORD-RESET REQUEST
  ----------------------------------------------------------------------

  result := public.reserve_password_reset_request(request_email);

  if result->>'status' is distinct from 'ready' then
    raise exception
      'FAIL: first password-reset request should be allowed';
  end if;

  if result->>'challengeId' is null then
    raise exception
      'FAIL: first password-reset request should return a challenge ID';
  end if;

  if result->>'email' is distinct from request_email then
    raise exception
      'FAIL: password-reset request returned the wrong email';
  end if;

  request_challenge_id :=
    (result->>'challengeId')::uuid;

  select
    purpose,
    attempts,
    resend_count,
    expires_at
  into
    saved_purpose,
    saved_attempts,
    saved_resends,
    saved_expiry
  from public.auth_challenges
  where id = request_challenge_id;

  if saved_purpose is distinct from 'password_reset' then
    raise exception
      'FAIL: recovery challenge must use password_reset purpose';
  end if;

  if saved_attempts is distinct from 0 then
    raise exception
      'FAIL: new password-reset challenge should start with zero attempts';
  end if;

  if saved_resends is distinct from 0 then
    raise exception
      'FAIL: initial request must not count as a resend';
  end if;

  if saved_expiry <= now() then
    raise exception
      'FAIL: new password-reset challenge must not start expired';
  end if;

  ----------------------------------------------------------------------
  -- 2. IMMEDIATE SECOND REQUEST MUST HIT COOLDOWN
  ----------------------------------------------------------------------

  result := public.reserve_password_reset_request(request_email);

  if result->>'status' is distinct from 'cooldown' then
    raise exception
      'FAIL: immediate password-reset request should hit cooldown';
  end if;

  select resend_count
  into saved_resends
  from public.auth_challenges
  where id = request_challenge_id;

  if saved_resends is distinct from 0 then
    raise exception
      'FAIL: blocked cooldown request must not increase resend count';
  end if;

  ----------------------------------------------------------------------
  -- 3. RESEND AFTER COOLDOWN MUST RENEW AN EXPIRED OTP
  ----------------------------------------------------------------------

  /*
   * To simulate an expired OTP we must keep the table invariant:
   *
   *   expires_at > created_at
   *
   * Moving created_at into the past first gives us a valid challenge
   * whose OTP has expired but whose 24-hour recovery window remains open.
   */
  update public.auth_challenges
  set
    created_at = now() - interval '20 minutes',
    expires_at = now() - interval '1 second',
    next_resend_at = now() - interval '1 second'
  where id = request_challenge_id;

  result := public.reserve_password_reset_request(request_email);

  if result->>'status' is distinct from 'ready' then
    raise exception
      'FAIL: password-reset resend should be allowed after cooldown';
  end if;

  if (result->>'challengeId')::uuid
      is distinct from request_challenge_id then
    raise exception
      'FAIL: eligible resend should reuse the existing challenge';
  end if;

  select
    attempts,
    resend_count,
    expires_at
  into
    saved_attempts,
    saved_resends,
    saved_expiry
  from public.auth_challenges
  where id = request_challenge_id;

  if saved_attempts is distinct from 0 then
    raise exception
      'FAIL: requesting another code must preserve verification attempts';
  end if;

  if saved_resends is distinct from 1 then
    raise exception
      'FAIL: first resend should set resend_count to one';
  end if;

  if saved_expiry is distinct from now() + interval '10 minutes' then
    raise exception
      'FAIL: resend should renew OTP validity for ten minutes';
  end if;

  ----------------------------------------------------------------------
  -- 4. FIVE RESENDS ALLOWED; SIXTH RESEND REJECTED
  ----------------------------------------------------------------------

  for iteration in 2..5 loop
    update public.auth_challenges
    set next_resend_at = now() - interval '1 second'
    where id = request_challenge_id;

    result :=
      public.reserve_password_reset_request(request_email);

    if result->>'status' is distinct from 'ready' then
      raise exception
        'FAIL: password-reset resend % should be allowed',
        iteration;
    end if;
  end loop;

  select resend_count
  into saved_resends
  from public.auth_challenges
  where id = request_challenge_id;

  if saved_resends is distinct from 5 then
    raise exception
      'FAIL: five completed resends should produce resend_count = 5';
  end if;

  update public.auth_challenges
  set next_resend_at = now() - interval '1 second'
  where id = request_challenge_id;

  result :=
    public.reserve_password_reset_request(request_email);

  if result->>'status' is distinct from 'invalid' then
    raise exception
      'FAIL: sixth password-reset resend must be rejected';
  end if;

  ----------------------------------------------------------------------
  -- 5. VERIFICATION ATTEMPT BUDGET
  ----------------------------------------------------------------------

  result := public.reserve_password_reset_request(attempt_email);

  if result->>'status' is distinct from 'ready' then
    raise exception
      'FAIL: verification-attempt test challenge was not created';
  end if;

  attempt_challenge_id :=
    (result->>'challengeId')::uuid;

  for iteration in 1..5 loop
    result :=
      public.reserve_password_reset_attempt(attempt_email);

    if result->>'status' is distinct from 'ready' then
      raise exception
        'FAIL: verification attempt % should be allowed',
        iteration;
    end if;

    if (result->>'challengeId')::uuid
        is distinct from attempt_challenge_id then
      raise exception
        'FAIL: verification attempt returned wrong challenge';
    end if;
  end loop;

  select attempts
  into saved_attempts
  from public.auth_challenges
  where id = attempt_challenge_id;

  if saved_attempts is distinct from 5 then
    raise exception
      'FAIL: five reservations should produce attempts = 5';
  end if;

  result :=
    public.reserve_password_reset_attempt(attempt_email);

  if result->>'status' is distinct from 'invalid' then
    raise exception
      'FAIL: sixth password-reset verification attempt must be rejected';
  end if;

  ----------------------------------------------------------------------
  -- 6. SUCCESSFUL CHALLENGE COMPLETION MUST BE SINGLE-USE
  ----------------------------------------------------------------------

  if public.complete_password_reset_challenge(
    attempt_challenge_id
  ) is distinct from true then
    raise exception
      'FAIL: eligible password-reset challenge should complete';
  end if;

  if public.complete_password_reset_challenge(
    attempt_challenge_id
  ) is distinct from false then
    raise exception
      'FAIL: completed password-reset challenge must not complete twice';
  end if;

  select consumed_at
  into saved_consumed_at
  from public.auth_challenges
  where id = attempt_challenge_id;

  if saved_consumed_at is null then
    raise exception
      'FAIL: completed password-reset challenge must be marked consumed';
  end if;

  ----------------------------------------------------------------------
  -- 7. A CONSUMED CHALLENGE MUST NOT BLOCK A FRESH RESET
  ----------------------------------------------------------------------

  result :=
    public.reserve_password_reset_request(attempt_email);

  if result->>'status' is distinct from 'ready' then
    raise exception
      'FAIL: consumed challenge should allow a fresh reset request';
  end if;

  replacement_challenge_id :=
    (result->>'challengeId')::uuid;

  if replacement_challenge_id
      is not distinct from attempt_challenge_id then
    raise exception
      'FAIL: fresh reset request should create a new challenge';
  end if;

  ----------------------------------------------------------------------
  -- 8. ONLY ONE UNCONSUMED PASSWORD-RESET CHALLENGE PER EMAIL
  ----------------------------------------------------------------------

  begin
    insert into public.auth_challenges (
      email,
      purpose
    )
    values (
      attempt_email,
      'password_reset'
    );

    raise exception
      'FAIL: duplicate active password-reset challenge was allowed';

  exception
    when unique_violation then
      null;
  end;

  ----------------------------------------------------------------------
  -- 9. CHALLENGES OLDER THAN 24 HOURS ARE RETIRED AND REPLACED
  ----------------------------------------------------------------------

  old_challenge_id := gen_random_uuid();

  insert into public.auth_challenges (
    id,
    email,
    purpose,
    attempts,
    created_at,
    expires_at,
    next_resend_at,
    resend_count
  )
  values (
    old_challenge_id,
    old_email,
    'password_reset',
    1,
    now() - interval '25 hours',
    now() - interval '24 hours',
    now() - interval '24 hours',
    1
  );

  result :=
    public.reserve_password_reset_request(old_email);

  if result->>'status' is distinct from 'ready' then
    raise exception
      'FAIL: challenge older than 24 hours should allow a new request';
  end if;

  renewed_challenge_id :=
    (result->>'challengeId')::uuid;

  if renewed_challenge_id
      is not distinct from old_challenge_id then
    raise exception
      'FAIL: 24-hour-old challenge should be replaced';
  end if;

  select consumed_at
  into saved_consumed_at
  from public.auth_challenges
  where id = old_challenge_id;

  if saved_consumed_at is null then
    raise exception
      'FAIL: 24-hour-old challenge should be retired';
  end if;

  ----------------------------------------------------------------------
  -- 10. SIGNUP AND PASSWORD-RESET PURPOSES MUST REMAIN SEPARATE
  ----------------------------------------------------------------------

  signup_challenge_id := gen_random_uuid();

  insert into public.auth_challenges (
    id,
    email,
    purpose
  )
  values (
    signup_challenge_id,
    signup_email,
    'signup'
  );

  result :=
    public.reserve_password_reset_attempt(signup_email);

  if result->>'status' is distinct from 'invalid' then
    raise exception
      'FAIL: signup challenge must not authorize password reset';
  end if;

  select attempts
  into saved_attempts
  from public.auth_challenges
  where id = signup_challenge_id;

  if saved_attempts is distinct from 0 then
    raise exception
      'FAIL: password-reset function modified signup challenge attempts';
  end if;

  ----------------------------------------------------------------------
  -- 11. CLIENT ROLES MUST NOT EXECUTE PASSWORD-RESET FUNCTIONS
  ----------------------------------------------------------------------

  if has_function_privilege(
    'anon',
    'public.reserve_password_reset_request(text)',
    'EXECUTE'
  ) or has_function_privilege(
    'authenticated',
    'public.reserve_password_reset_request(text)',
    'EXECUTE'
  ) or has_function_privilege(
    'anon',
    'public.reserve_password_reset_attempt(text)',
    'EXECUTE'
  ) or has_function_privilege(
    'authenticated',
    'public.reserve_password_reset_attempt(text)',
    'EXECUTE'
  ) or has_function_privilege(
    'anon',
    'public.complete_password_reset_challenge(uuid)',
    'EXECUTE'
  ) or has_function_privilege(
    'authenticated',
    'public.complete_password_reset_challenge(uuid)',
    'EXECUTE'
  ) then
    raise exception
      'FAIL: client roles have access to password-reset functions';
  end if;
end;
$$;

select
  'PASS: password-reset database checks completed' as result;

rollback;