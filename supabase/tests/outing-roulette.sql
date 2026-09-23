begin;

do $$
declare
  owner_user uuid;
  second_user uuid;

  outsider_user uuid :=
    gen_random_uuid();

  test_outing uuid;

  owner_member uuid;
  second_member uuid;
  guest_member uuid;

  spin_result jsonb;
  second_spin_result jsonb;
  consent_result jsonb;

  winner uuid;
begin
  --------------------------------------------------------------------
  -- TWO EXISTING MOVA PROFILES
  --------------------------------------------------------------------

  select user_id
  into owner_user
  from public.profiles
  order by created_at
  limit 1;

  select user_id
  into second_user
  from public.profiles
  where user_id <>
    owner_user
  order by created_at
  limit 1;

  if owner_user is null
    or second_user is null
  then
    raise exception
      'Roulette test requires at least two MOVA profiles.';
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
    'Roulette Foundation Test',
    'Lagos',
    now() +
      interval '3 days',
    'NGN',
    500000
  )
  returning id
  into test_outing;

  select id
  into owner_member
  from public.outing_members
  where outing_id =
    test_outing
    and user_id =
      owner_user
    and role =
      'owner';

  if owner_member is null then
    raise exception
      'Owner membership missing.';
  end if;

  --------------------------------------------------------------------
  -- ADD SECOND REGISTERED MEMBER
  --------------------------------------------------------------------

  insert into public.outing_members (
    outing_id,
    user_id,
    role,
    opted_in,
    added_by_user_id
  )
  values (
    test_outing,
    second_user,
    'member',
    false,
    owner_user
  )
  returning id
  into second_member;

  --------------------------------------------------------------------
  -- ADD NON-OPTED-IN GUEST
  --------------------------------------------------------------------

  insert into public.outing_members (
    outing_id,
    guest_display_name,
    role,
    opted_in,
    added_by_user_id
  )
  values (
    test_outing,
    'Guest Tester',
    'member',
    false,
    owner_user
  )
  returning id
  into guest_member;

  --------------------------------------------------------------------
  -- CANNOT SELECT NON-OPTED-IN MEMBER
  --------------------------------------------------------------------

  begin
    update public.outings
    set selected_member_id =
      guest_member
    where id =
      test_outing;

    raise exception
      'Non-opted-in member was accepted as selected payer.';
  exception
    when check_violation then
      null;
  end;

  raise notice
    'Selected-payer eligibility constraint works.';

  --------------------------------------------------------------------
  -- ZERO ELIGIBLE MEMBERS
  --------------------------------------------------------------------

  select public.spin_outing_roulette(
    owner_user,
    test_outing
  )
  into spin_result;

  if spin_result->>'status'
      <> 'insufficient_members'
  then
    raise exception
      'Roulette should reject zero eligible members: %',
      spin_result;
  end if;

  raise notice
    'Zero eligible members rejected.';

  --------------------------------------------------------------------
  -- ONE ELIGIBLE MEMBER
  --------------------------------------------------------------------

  select public.set_outing_member_consent(
    owner_user,
    test_outing,
    true
  )
  into consent_result;

  if consent_result->>'status'
      <> 'updated'
  then
    raise exception
      'Owner opt-in failed.';
  end if;

  select public.spin_outing_roulette(
    owner_user,
    test_outing
  )
  into spin_result;

  if spin_result->>'status'
      <> 'insufficient_members'
  then
    raise exception
      'Roulette should reject one eligible member: %',
      spin_result;
  end if;

  raise notice
    'Single eligible member rejected.';

  --------------------------------------------------------------------
  -- SECOND USER OPTS IN
  --------------------------------------------------------------------

  select public.set_outing_member_consent(
    second_user,
    test_outing,
    true
  )
  into consent_result;

  if consent_result->>'status'
      <> 'updated'
  then
    raise exception
      'Second member opt-in failed.';
  end if;

  --------------------------------------------------------------------
  -- NON-MEMBER CANNOT SPIN
  --------------------------------------------------------------------

  select public.spin_outing_roulette(
    outsider_user,
    test_outing
  )
  into spin_result;

  if spin_result->>'status'
      <> 'forbidden'
  then
    raise exception
      'Non-member was allowed to spin: %',
      spin_result;
  end if;

  raise notice
    'Non-member spin prevented.';

  --------------------------------------------------------------------
  -- VALID SPIN
  --------------------------------------------------------------------

  select public.spin_outing_roulette(
    owner_user,
    test_outing
  )
  into spin_result;

  if spin_result->>'status'
      <> 'selected'
  then
    raise exception
      'Valid roulette spin failed: %',
      spin_result;
  end if;

  winner :=
    (
      spin_result->>'selectedMemberId'
    )::uuid;

  if winner not in (
    owner_member,
    second_member
  ) then
    raise exception
      'Roulette selected an ineligible member.';
  end if;

  if winner =
      guest_member
  then
    raise exception
      'Non-opted-in guest was selected.';
  end if;

  if not exists (
    select 1
    from public.outings
    where id =
      test_outing
      and selected_member_id =
        winner
  ) then
    raise exception
      'Winner was not persisted on outing.';
  end if;

  if not exists (
    select 1
    from public.outing_roulette_spins
    where outing_id =
      test_outing
      and selected_member_id =
        winner
      and eligible_count =
        2
  ) then
    raise exception
      'Roulette spin audit was not stored.';
  end if;

  raise notice
    'Valid roulette selection works.';

  --------------------------------------------------------------------
  -- REPEATED SPIN RETURNS SAME WINNER
  --------------------------------------------------------------------

  select public.spin_outing_roulette(
    owner_user,
    test_outing
  )
  into second_spin_result;

  if second_spin_result->>'status'
      <> 'already_selected'
  then
    raise exception
      'Repeated spin was not protected: %',
      second_spin_result;
  end if;

  if (
    second_spin_result->>'selectedMemberId'
  )::uuid <>
    winner
  then
    raise exception
      'Repeated spin changed the winner.';
  end if;

  if (
    select count(*)
    from public.outing_roulette_spins
    where outing_id =
      test_outing
  ) <> 1
  then
    raise exception
      'Repeated spin created another audit record.';
  end if;

  raise notice
    'Repeated spin cannot manipulate the winner.';

  --------------------------------------------------------------------
  -- ELIGIBILITY CHANGE CLEARS OLD WINNER
  --------------------------------------------------------------------

  select public.set_outing_member_consent(
    second_user,
    test_outing,
    false
  )
  into consent_result;

  if exists (
    select 1
    from public.outings
    where id =
      test_outing
      and selected_member_id
        is not null
  ) then
    raise exception
      'Old winner was not cleared after eligibility changed.';
  end if;

  raise notice
    'Eligibility change clears stale winner.';

  --------------------------------------------------------------------
  -- ONE ELIGIBLE MEMBER AGAIN
  --------------------------------------------------------------------

  select public.spin_outing_roulette(
    owner_user,
    test_outing
  )
  into spin_result;

  if spin_result->>'status'
      <> 'insufficient_members'
  then
    raise exception
      'Roulette should reject reduced eligible roster.';
  end if;

  --------------------------------------------------------------------
  -- RESTORE SECOND MEMBER AND SPIN AGAIN
  --------------------------------------------------------------------

  select public.set_outing_member_consent(
    second_user,
    test_outing,
    true
  )
  into consent_result;

  select public.spin_outing_roulette(
    second_user,
    test_outing
  )
  into spin_result;

  if spin_result->>'status'
      <> 'selected'
  then
    raise exception
      'Second valid roulette spin failed.';
  end if;

  if (
    select count(*)
    from public.outing_roulette_spins
    where outing_id =
      test_outing
  ) <> 2
  then
    raise exception
      'Expected two completed roulette audit records.';
  end if;

  raise notice
    'New eligible roster can be spun again.';

  --------------------------------------------------------------------
  -- INACTIVE OUTING CANNOT SPIN
  --------------------------------------------------------------------

  update public.outings
  set
    selected_member_id =
      null,
    status =
      'completed'
  where id =
    test_outing;

  select public.spin_outing_roulette(
    owner_user,
    test_outing
  )
  into spin_result;

  if spin_result->>'status'
      <> 'inactive'
  then
    raise exception
      'Completed outing was allowed to spin.';
  end if;

  raise notice
    'Inactive outing spin prevented.';

  --------------------------------------------------------------------
  -- SUCCESS
  --------------------------------------------------------------------

  raise notice
    '=========================================';
  raise notice
    'ALL OUTING ROULETTE TESTS PASSED';
  raise notice
    '=========================================';
end;
$$;

rollback;