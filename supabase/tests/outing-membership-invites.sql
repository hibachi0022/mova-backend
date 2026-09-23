begin;

do $$
declare
  owner_user uuid;
  joining_user uuid;

  test_outing uuid;

  guest_result jsonb;
  code_result jsonb;
  lookup_result jsonb;
  join_result jsonb;
  repeat_join_result jsonb;
  consent_result jsonb;
  forbidden_result jsonb;
  blocked_result jsonb;

  first_hash text :=
    repeat(
      'a',
      64
    );

  second_hash text :=
    repeat(
      'b',
      64
    );

  first_code_id uuid;
  joining_member_id uuid;
begin
  --------------------------------------------------------------------
  -- TWO EXISTING MOVA USERS
  --------------------------------------------------------------------

  select user_id
  into owner_user
  from public.profiles
  order by created_at
  limit 1;

  select user_id
  into joining_user
  from public.profiles
  where user_id <>
    owner_user
  order by created_at
  limit 1;

  if owner_user is null
    or joining_user is null
  then
    raise exception
      'This test requires at least two MOVA profiles.';
  end if;

  --------------------------------------------------------------------
  -- CREATE TEST OUTING
  --------------------------------------------------------------------

  insert into public.outings (
    created_by_user_id,
    title,
    location,
    starts_at,
    currency,
    amount_minor
  )
  values (
    owner_user,
    'Membership API Test',
    'Lagos',
    now() +
      interval '3 days',
    'NGN',
    250000
  )
  returning id
  into test_outing;

  --------------------------------------------------------------------
  -- OWNER CAN ADD GUEST
  --------------------------------------------------------------------

  select public.add_outing_guest(
    owner_user,
    test_outing,
    'Guest Tester'
  )
  into guest_result;

  if guest_result->>'status'
      <> 'added'
  then
    raise exception
      'Owner could not add guest: %',
      guest_result;
  end if;

  if not exists (
    select 1
    from public.outing_members
    where outing_id =
      test_outing
      and guest_display_name =
        'Guest Tester'
      and opted_in =
        false
      and removed_at is null
  ) then
    raise exception
      'Guest membership was not stored correctly.';
  end if;

  raise notice
    'Guest addition works.';

  --------------------------------------------------------------------
  -- NON-HOST CANNOT ADD GUEST
  --------------------------------------------------------------------

  select public.add_outing_guest(
    joining_user,
    test_outing,
    'Not Allowed'
  )
  into forbidden_result;

  if forbidden_result->>'status'
      <> 'forbidden'
  then
    raise exception
      'Non-host guest addition was not rejected.';
  end if;

  raise notice
    'Guest host permission works.';

  --------------------------------------------------------------------
  -- OWNER CREATES JOIN CODE
  --------------------------------------------------------------------

  select public.create_outing_join_code(
    owner_user,
    test_outing,
    first_hash,
    'AAAA',
    now() +
      interval '1 hour',
    3
  )
  into code_result;

  if code_result->>'status'
      <> 'created'
  then
    raise exception
      'Join code creation failed: %',
      code_result;
  end if;

  first_code_id :=
    (
      code_result->>'codeId'
    )::uuid;

  if first_code_id is null then
    raise exception
      'Join-code ID was missing.';
  end if;

  raise notice
    'Join-code creation works.';

  --------------------------------------------------------------------
  -- LOOKUP WORKS
  --------------------------------------------------------------------

  select public.lookup_outing_join_code(
    first_hash
  )
  into lookup_result;

  if lookup_result->>'status'
      <> 'ready'
    or (
      lookup_result->>'outingId'
    )::uuid <>
      test_outing
  then
    raise exception
      'Join-code lookup failed: %',
      lookup_result;
  end if;

  raise notice
    'Join-code lookup works.';

  --------------------------------------------------------------------
  -- JOIN USER
  --------------------------------------------------------------------

  select public.join_outing_with_code(
    first_hash,
    joining_user
  )
  into join_result;

  if join_result->>'status'
      <> 'joined'
  then
    raise exception
      'User could not join outing: %',
      join_result;
  end if;

  joining_member_id :=
    (
      join_result->>'memberId'
    )::uuid;

  if joining_member_id is null then
    raise exception
      'Joined member ID missing.';
  end if;

  if not exists (
    select 1
    from public.outing_members
    where id =
      joining_member_id
      and outing_id =
        test_outing
      and user_id =
        joining_user
      and role =
        'member'
      and opted_in =
        false
      and removed_at is null
  ) then
    raise exception
      'Joined membership was not stored correctly.';
  end if;

  if not exists (
    select 1
    from public.outing_join_codes
    where id =
      first_code_id
      and use_count =
        1
  ) then
    raise exception
      'Join-code use count did not increment.';
  end if;

  raise notice
    'Joining by code works.';

  --------------------------------------------------------------------
  -- RETRY DOES NOT CONSUME SECOND USE
  --------------------------------------------------------------------

  select public.join_outing_with_code(
    first_hash,
    joining_user
  )
  into repeat_join_result;

  if repeat_join_result->>'status'
      <> 'already_member'
  then
    raise exception
      'Existing membership retry was not idempotent.';
  end if;

  if not exists (
    select 1
    from public.outing_join_codes
    where id =
      first_code_id
      and use_count =
        1
  ) then
    raise exception
      'Repeated join consumed another code use.';
  end if;

  raise notice
    'Repeated join is idempotent.';

  --------------------------------------------------------------------
  -- USER CONTROLS OWN PAYER CONSENT
  --------------------------------------------------------------------

  select public.set_outing_member_consent(
    joining_user,
    test_outing,
    true
  )
  into consent_result;

  if consent_result->>'status'
      <> 'updated'
  then
    raise exception
      'Payer consent could not be updated.';
  end if;

  if not exists (
    select 1
    from public.outing_members
    where id =
      joining_member_id
      and opted_in =
        true
      and opted_in_at
        is not null
  ) then
    raise exception
      'Payer consent was not stored correctly.';
  end if;

  raise notice
    'Payer-selection consent works.';

  --------------------------------------------------------------------
  -- GENERATING NEW CODE REVOKES OLD CODE
  --------------------------------------------------------------------

  select public.create_outing_join_code(
    owner_user,
    test_outing,
    second_hash,
    'BBBB',
    now() +
      interval '1 hour',
    3
  )
  into code_result;

  if code_result->>'status'
      <> 'created'
  then
    raise exception
      'Replacement code could not be created.';
  end if;

  select public.lookup_outing_join_code(
    first_hash
  )
  into lookup_result;

  if lookup_result->>'status'
      <> 'invalid'
  then
    raise exception
      'Old join code remained active.';
  end if;

  select public.lookup_outing_join_code(
    second_hash
  )
  into lookup_result;

  if lookup_result->>'status'
      <> 'ready'
  then
    raise exception
      'Replacement join code was not active.';
  end if;

  raise notice
    'Code replacement revokes old code.';

  --------------------------------------------------------------------
  -- REMOVE JOINING USER FROM OUTING FOR BLOCK TEST
  --------------------------------------------------------------------

  update public.outing_members
  set removed_at =
    now()
  where id =
    joining_member_id;

  --------------------------------------------------------------------
  -- BLOCK BETWEEN INVITE ISSUER AND JOINING USER
  --------------------------------------------------------------------

  insert into public.user_blocks (
    blocker_id,
    blocked_id
  )
  values (
    owner_user,
    joining_user
  )
  on conflict (
    blocker_id,
    blocked_id
  )
  do nothing;

  select public.join_outing_with_code(
    second_hash,
    joining_user
  )
  into blocked_result;

  if blocked_result->>'status'
      <> 'blocked'
  then
    raise exception
      'Blocked user was allowed to join: %',
      blocked_result;
  end if;

  raise notice
    'Blocking prevents join-code use.';

  --------------------------------------------------------------------
  -- SUCCESS
  --------------------------------------------------------------------

  raise notice
    '===============================================';
  raise notice
    'ALL OUTING MEMBERSHIP / INVITE TESTS PASSED';
  raise notice
    '===============================================';
end;
$$;

rollback;