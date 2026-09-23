begin;

do $$
declare
  user_one uuid;
  user_two uuid;

  outing_one uuid;
  outing_two uuid;

  user_two_member uuid;
  other_outing_member uuid;

  invitation_one uuid;
begin
  --------------------------------------------------------------------
  -- We need two existing MOVA profiles.
  --------------------------------------------------------------------

  select user_id
  into user_one
  from public.profiles
  order by created_at
  limit 1;

  select user_id
  into user_two
  from public.profiles
  where user_id <> user_one
  order by created_at
  limit 1;

  if user_one is null
    or user_two is null then
    raise exception
      'Outings test requires at least two MOVA profiles.';
  end if;

  raise notice
    'Using two existing MOVA profiles.';

  --------------------------------------------------------------------
  -- CREATE OUTING
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
    user_one,
    'MOVA Foundation Test',
    'Lagos',
    now() +
      interval '3 days',
    'NGN',
    500000
  )
  returning id
  into outing_one;

  if outing_one is null then
    raise exception
      'Outing was not created.';
  end if;

  raise notice
    'Outing created successfully.';

  --------------------------------------------------------------------
  -- CREATOR MUST AUTOMATICALLY BECOME OWNER
  --------------------------------------------------------------------

  if not exists (
    select 1
    from public.outing_members
    where outing_id =
      outing_one
      and user_id =
        user_one
      and role =
        'owner'
      and removed_at
        is null
  ) then
    raise exception
      'Outing creator was not automatically made owner.';
  end if;

  raise notice
    'Creator automatically became owner.';

  --------------------------------------------------------------------
  -- SECOND REGISTERED MEMBER
  --------------------------------------------------------------------

  insert into public.outing_members (
    outing_id,
    user_id,
    role,
    added_by_user_id
  )
  values (
    outing_one,
    user_two,
    'member',
    user_one
  )
  returning id
  into user_two_member;

  if user_two_member
      is null then
    raise exception
      'Second member was not created.';
  end if;

  --------------------------------------------------------------------
  -- DUPLICATE ACTIVE MEMBERSHIP MUST FAIL
  --------------------------------------------------------------------

  begin
    insert into public.outing_members (
      outing_id,
      user_id,
      role,
      added_by_user_id
    )
    values (
      outing_one,
      user_two,
      'member',
      user_one
    );

    raise exception
      'Duplicate active registered membership was allowed.';
  exception
    when unique_violation then
      null;
  end;

  raise notice
    'Duplicate registered membership prevented.';

  --------------------------------------------------------------------
  -- GUEST MEMBER
  --------------------------------------------------------------------

  insert into public.outing_members (
    outing_id,
    guest_display_name,
    role,
    added_by_user_id
  )
  values (
    outing_one,
    'Guest Tester',
    'member',
    user_one
  );

  if not exists (
    select 1
    from public.outing_members
    where outing_id =
      outing_one
      and guest_display_name =
        'Guest Tester'
  ) then
    raise exception
      'Guest member was not created.';
  end if;

  raise notice
    'Guest membership works.';

  --------------------------------------------------------------------
  -- PAYER CONSENT MUST HAVE TIMESTAMP
  --------------------------------------------------------------------

  begin
    update public.outing_members
    set opted_in = true
    where id =
      user_two_member;

    raise exception
      'Opt-in without opted_in_at was allowed.';
  exception
    when check_violation then
      null;
  end;

  update public.outing_members
  set
    opted_in = true,
    opted_in_at = now()
  where id =
    user_two_member;

  if not exists (
    select 1
    from public.outing_members
    where id =
      user_two_member
      and opted_in = true
      and opted_in_at
        is not null
  ) then
    raise exception
      'Valid payer opt-in failed.';
  end if;

  raise notice
    'Payer consent rules work.';

  --------------------------------------------------------------------
  -- SELECTED MEMBER FROM SAME OUTING
  --------------------------------------------------------------------

  update public.outings
  set selected_member_id =
    user_two_member
  where id =
    outing_one;

  if not exists (
    select 1
    from public.outings
    where id =
      outing_one
      and selected_member_id =
        user_two_member
  ) then
    raise exception
      'Valid selected payer was not stored.';
  end if;

  raise notice
    'Valid selected payer accepted.';

  --------------------------------------------------------------------
  -- CREATE A DIFFERENT OUTING
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
    user_two,
    'Second MOVA Test',
    'Abuja',
    now() +
      interval '4 days',
    'NGN',
    100000
  )
  returning id
  into outing_two;

  select id
  into other_outing_member
  from public.outing_members
  where outing_id =
    outing_two
    and user_id =
      user_two
    and role =
      'owner';

  if other_outing_member
      is null then
    raise exception
      'Second outing owner membership was not created.';
  end if;

  --------------------------------------------------------------------
  -- CANNOT SELECT MEMBER FROM ANOTHER OUTING
  --------------------------------------------------------------------

  begin
    update public.outings
    set selected_member_id =
      other_outing_member
    where id =
      outing_one;

    raise exception
      'A payer from another outing was accepted.';
  exception
    when check_violation then
      null;
  end;

  raise notice
    'Cross-outing payer selection prevented.';

  --------------------------------------------------------------------
  -- DIRECT INVITATION
  --------------------------------------------------------------------

  insert into public.outing_invitations (
    outing_id,
    invited_by_user_id,
    invitee_user_id
  )
  values (
    outing_one,
    user_one,
    user_two
  )
  returning id
  into invitation_one;

  if invitation_one
      is null then
    raise exception
      'Direct invitation was not created.';
  end if;

  --------------------------------------------------------------------
  -- DUPLICATE PENDING INVITATION MUST FAIL
  --------------------------------------------------------------------

  begin
    insert into public.outing_invitations (
      outing_id,
      invited_by_user_id,
      invitee_user_id
    )
    values (
      outing_one,
      user_one,
      user_two
    );

    raise exception
      'Duplicate pending invitation was allowed.';
  exception
    when unique_violation then
      null;
  end;

  raise notice
    'Duplicate pending invitations prevented.';

  --------------------------------------------------------------------
  -- JOIN CODE
  --------------------------------------------------------------------

  insert into public.outing_join_codes (
    outing_id,
    created_by_user_id,
    code_hash,
    code_hint,
    max_uses
  )
  values (
    outing_one,
    user_one,
    repeat(
      'a',
      64
    ),
    'TEST',
    10
  );

  if not exists (
    select 1
    from public.outing_join_codes
    where outing_id =
      outing_one
      and code_hash =
        repeat(
          'a',
          64
        )
  ) then
    raise exception
      'Join code was not created.';
  end if;

  --------------------------------------------------------------------
  -- HASH MUST BE UNIQUE
  --------------------------------------------------------------------

  begin
    insert into public.outing_join_codes (
      outing_id,
      created_by_user_id,
      code_hash,
      code_hint
    )
    values (
      outing_two,
      user_two,
      repeat(
        'a',
        64
      ),
      'TEST'
    );

    raise exception
      'Duplicate join-code hash was allowed.';
  exception
    when unique_violation then
      null;
  end;

  raise notice
    'Join-code uniqueness works.';

  --------------------------------------------------------------------
  -- INVALID CURRENCY MUST FAIL
  --------------------------------------------------------------------

  begin
    insert into public.outings (
      created_by_user_id,
      title,
      location,
      starts_at,
      currency,
      amount_minor
    )
    values (
      user_one,
      'Bad Currency',
      'Lagos',
      now() +
        interval '5 days',
      'ngn',
      100
    );

    raise exception
      'Invalid lowercase currency was accepted.';
  exception
    when check_violation then
      null;
  end;

  raise notice
    'Currency validation works.';

  --------------------------------------------------------------------
  -- SUCCESS
  --------------------------------------------------------------------

  raise notice
    '===========================================';
  raise notice
    'ALL OUTINGS FOUNDATION TESTS PASSED';
  raise notice
    '===========================================';
end;
$$;

rollback;