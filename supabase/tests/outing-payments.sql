begin;

do $$
declare
  owner_user uuid;
  second_user uuid;

  outsider_user uuid :=
    gen_random_uuid();

  test_outing uuid;
  zero_amount_outing uuid;

  owner_member uuid;
  second_member uuid;
  zero_amount_member uuid;

  result jsonb;
  repeat_result jsonb;
  conflict_result jsonb;
  attach_result jsonb;

  first_intent_id uuid;
  second_intent_id uuid;

  hash_one text :=
    repeat(
      'a',
      64
    );

  hash_two text :=
    repeat(
      'b',
      64
    );

  hash_three text :=
    repeat(
      'c',
      64
    );
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
      'Payment test requires at least two MOVA profiles.';
  end if;

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
    owner_user,
    'Payment Foundation Test',
    'Lagos',
    now() +
      interval '3 days',
    'NGN',
    750000
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
    and removed_at is null;

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
  -- BOTH REGISTERED MEMBERS OPT IN
  --------------------------------------------------------------------

  perform public.set_outing_member_consent(
    owner_user,
    test_outing,
    true
  );

  perform public.set_outing_member_consent(
    second_user,
    test_outing,
    true
  );

  --------------------------------------------------------------------
  -- NO ROULETTE WINNER = NO PAYMENT
  --------------------------------------------------------------------

  select public.prepare_outing_payment_intent(
    owner_user,
    test_outing,
    'card',
    hash_one
  )
  into result;

  if result->>'status'
      <> 'no_selection'
  then
    raise exception
      'Payment should require a selected payer: %',
      result;
  end if;

  raise notice
    'Payment requires a roulette winner.';

  --------------------------------------------------------------------
  -- SELECT OWNER AS TEST PAYER
  --------------------------------------------------------------------

  update public.outings
  set selected_member_id =
    owner_member
  where id =
    test_outing;

  --------------------------------------------------------------------
  -- NON-MEMBER CANNOT PREPARE PAYMENT
  --------------------------------------------------------------------

  select public.prepare_outing_payment_intent(
    outsider_user,
    test_outing,
    'card',
    hash_one
  )
  into result;

  if result->>'status'
      <> 'not_found'
  then
    raise exception
      'Non-member payment preparation was not hidden.';
  end if;

  raise notice
    'Non-members cannot prepare outing payments.';

  --------------------------------------------------------------------
  -- MEMBER WHO IS NOT THE WINNER CANNOT PAY
  --------------------------------------------------------------------

  select public.prepare_outing_payment_intent(
    second_user,
    test_outing,
    'card',
    hash_one
  )
  into result;

  if result->>'status'
      <> 'not_selected_payer'
  then
    raise exception
      'Non-selected member was allowed to prepare payment: %',
      result;
  end if;

  raise notice
    'Only the selected payer can prepare checkout.';

  --------------------------------------------------------------------
  -- VALID PAYMENT INTENT
  --------------------------------------------------------------------

  select public.prepare_outing_payment_intent(
    owner_user,
    test_outing,
    'card',
    hash_one
  )
  into result;

  if result->>'status'
      <> 'created'
  then
    raise exception
      'Payment intent creation failed: %',
      result;
  end if;

  first_intent_id :=
    (
      result->>'intentId'
    )::uuid;

  if first_intent_id
      is null
  then
    raise exception
      'Payment intent ID missing.';
  end if;

  if (
    result->>'amountMinor'
  )::bigint <>
    750000
  then
    raise exception
      'Payment amount was not copied from outing.';
  end if;

  if result->>'currency'
      <> 'NGN'
  then
    raise exception
      'Payment currency was not copied from outing.';
  end if;

  if result->>'selectedMemberId'
      <> owner_member::text
  then
    raise exception
      'Payment intent was not bound to selected payer.';
  end if;

  if not exists (
    select 1
    from public.outing_payment_intents
    where id =
      first_intent_id
      and outing_id =
        test_outing
      and selected_member_id =
        owner_member
      and payer_user_id =
        owner_user
      and amount_minor =
        750000
      and currency =
        'NGN'
      and method_id =
        'card'
      and status =
        'created'
      and idempotency_key_hash =
        hash_one
  ) then
    raise exception
      'Trusted payment intent was not stored correctly.';
  end if;

  raise notice
    'Trusted payment intent creation works.';

  --------------------------------------------------------------------
  -- SAME IDEMPOTENCY KEY RETURNS SAME INTENT
  --------------------------------------------------------------------

  select public.prepare_outing_payment_intent(
    owner_user,
    test_outing,
    'card',
    hash_one
  )
  into repeat_result;

  if repeat_result->>'status'
      <> 'existing'
  then
    raise exception
      'Idempotent retry did not return existing intent.';
  end if;

  if (
    repeat_result->>'intentId'
  )::uuid <>
    first_intent_id
  then
    raise exception
      'Idempotent retry returned a different intent.';
  end if;

  if (
    select count(*)
    from public.outing_payment_intents
    where outing_id =
      test_outing
  ) <> 1
  then
    raise exception
      'Idempotent retry created a duplicate payment intent.';
  end if;

  raise notice
    'Payment intent idempotency works.';

  --------------------------------------------------------------------
  -- SAME IDEMPOTENCY KEY CANNOT CHANGE METHOD
  --------------------------------------------------------------------

  select public.prepare_outing_payment_intent(
    owner_user,
    test_outing,
    'bank_transfer',
    hash_one
  )
  into conflict_result;

  if conflict_result->>'status'
      <> 'idempotency_conflict'
  then
    raise exception
      'Idempotency-key conflict was not detected.';
  end if;

  raise notice
    'Idempotency keys cannot be reused with different terms.';

  --------------------------------------------------------------------
  -- ATTACH PROVIDER-HOSTED CHECKOUT
  --------------------------------------------------------------------

  select public.attach_outing_payment_checkout(
    owner_user,
    first_intent_id,
    'paystack',
    'checkout_test_001',
    'reference_test_001',
    'https://checkout.example.test/payment/001',
    now() +
      interval '10 minutes'
  )
  into attach_result;

  if attach_result->>'status'
      <> 'ready'
  then
    raise exception
      'Provider checkout attachment failed: %',
      attach_result;
  end if;

  if not exists (
    select 1
    from public.outing_payment_intents
    where id =
      first_intent_id
      and status =
        'checkout_ready'
      and provider =
        'paystack'
      and provider_checkout_id =
        'checkout_test_001'
      and provider_reference =
        'reference_test_001'
      and checkout_url =
        'https://checkout.example.test/payment/001'
  ) then
    raise exception
      'Provider checkout was not persisted.';
  end if;

  raise notice
    'Provider-hosted checkout attachment works.';

  --------------------------------------------------------------------
  -- ATTACH RETRY IS IDEMPOTENT
  --------------------------------------------------------------------

  select public.attach_outing_payment_checkout(
    owner_user,
    first_intent_id,
    'paystack',
    'checkout_test_001',
    'reference_test_001',
    'https://checkout.example.test/payment/001',
    now() +
      interval '10 minutes'
  )
  into attach_result;

  if attach_result->>'status'
      <> 'existing'
  then
    raise exception
      'Provider checkout retry was not idempotent.';
  end if;

  raise notice
    'Provider checkout attachment is idempotent.';

  --------------------------------------------------------------------
  -- ANOTHER LIVE CHECKOUT CANNOT START
  --------------------------------------------------------------------

  select public.prepare_outing_payment_intent(
    owner_user,
    test_outing,
    'bank_transfer',
    hash_two
  )
  into result;

  if result->>'status'
      <> 'payment_in_progress'
  then
    raise exception
      'Second live checkout was not prevented: %',
      result;
  end if;

  raise notice
    'Concurrent checkout attempts are prevented.';

  --------------------------------------------------------------------
  -- EXPIRE OLD CHECKOUT, THEN A NEW ATTEMPT MAY START
  --------------------------------------------------------------------

  update public.outing_payment_intents
  set expires_at =
    now() -
    interval '1 second'
  where id =
    first_intent_id;

  select public.prepare_outing_payment_intent(
    owner_user,
    test_outing,
    'bank_transfer',
    hash_two
  )
  into result;

  if result->>'status'
      <> 'created'
  then
    raise exception
      'New checkout was not allowed after expiration: %',
      result;
  end if;

  second_intent_id :=
    (
      result->>'intentId'
    )::uuid;

  if second_intent_id
      is null
  then
    raise exception
      'Second payment intent ID missing.';
  end if;

  if not exists (
    select 1
    from public.outing_payment_intents
    where id =
      first_intent_id
      and status =
        'expired'
  ) then
    raise exception
      'Old checkout was not expired.';
  end if;

  raise notice
    'Expired checkout may be replaced safely.';

  --------------------------------------------------------------------
  -- CHANGING PAYER INVALIDATES UNCOMPLETED CHECKOUT
  --------------------------------------------------------------------

  update public.outings
  set selected_member_id =
    second_member
  where id =
    test_outing;

  if not exists (
    select 1
    from public.outing_payment_intents
    where id =
      second_intent_id
      and status =
        'cancelled'
  ) then
    raise exception
      'Selection change did not cancel pending checkout.';
  end if;

  raise notice
    'Changing the payer cancels the old checkout.';

  --------------------------------------------------------------------
  -- ZERO-AMOUNT OUTING CANNOT START PAYMENT
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
    'Zero Amount Test',
    'Lagos',
    now() +
      interval '4 days',
    'NGN',
    0
  )
  returning id
  into zero_amount_outing;

  select id
  into zero_amount_member
  from public.outing_members
  where outing_id =
    zero_amount_outing
    and user_id =
      owner_user;

  perform public.set_outing_member_consent(
    owner_user,
    zero_amount_outing,
    true
  );

  update public.outings
  set selected_member_id =
    zero_amount_member
  where id =
    zero_amount_outing;

  select public.prepare_outing_payment_intent(
    owner_user,
    zero_amount_outing,
    'card',
    hash_three
  )
  into result;

  if result->>'status'
      <> 'no_amount'
  then
    raise exception
      'Zero-amount outing was allowed to prepare payment.';
  end if;

  raise notice
    'Zero-amount outings cannot start payment.';

  --------------------------------------------------------------------
  -- SUCCESS
  --------------------------------------------------------------------

  raise notice
    '=========================================';
  raise notice
    'ALL OUTING PAYMENT FOUNDATION TESTS PASSED';
  raise notice
    '=========================================';
end;
$$;

rollback;