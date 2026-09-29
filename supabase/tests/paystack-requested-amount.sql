begin;

do $$
declare
  owner_user uuid;

  fee_outing uuid;
  fee_member uuid;
  fee_intent uuid;

  mismatch_outing uuid;
  mismatch_member uuid;
  mismatch_intent uuid;

  result jsonb;
begin

  --------------------------------------------------------------------
  -- LOAD EXISTING MOVA PROFILE
  --------------------------------------------------------------------

  select user_id
  into owner_user
  from public.profiles
  order by created_at
  limit 1;

  if owner_user is null
  then
    raise exception
      'Test requires at least one MOVA profile.';
  end if;

  raise notice
    'Existing MOVA profile loaded.';

  --------------------------------------------------------------------
  -- SCENARIO 1:
  -- MOVA requests 100000 but Paystack charges 101523 because fees are
  -- passed to the customer.
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
    'Paystack Fee Pass Test',
    'Lagos',
    now() +
      interval '3 days',
    'NGN',
    100000
  )
  returning id
  into fee_outing;

  select id
  into fee_member
  from public.outing_members
  where outing_id =
    fee_outing
    and user_id =
      owner_user
    and removed_at
      is null
  limit 1;

  if fee_member is null
  then
    raise exception
      'Owner membership missing.';
  end if;

  perform public.set_outing_member_consent(
    owner_user,
    fee_outing,
    true
  );

  update public.outings
  set selected_member_id =
    fee_member
  where id =
    fee_outing;

  select public.prepare_outing_payment_intent(
    owner_user,
    fee_outing,
    'card',
    repeat(
      'a',
      64
    )
  )
  into result;

  if result->>'status'
      <> 'created'
  then
    raise exception
      'Unable to create fee-pass payment intent: %',
      result;
  end if;

  fee_intent :=
    (
      result->>'intentId'
    )::uuid;

  select public.attach_outing_payment_checkout(
    owner_user,
    fee_intent,
    'paystack',
    'access_fee_pass_test',
    'MOVA-fee-pass-test',
    'https://checkout.paystack.com/fee-pass-test',
    now() +
      interval '10 minutes'
  )
  into result;

  if result->>'status'
      <> 'ready'
  then
    raise exception
      'Unable to attach fee-pass checkout: %',
      result;
  end if;

  select public.complete_outing_payment_from_provider(
    'paystack',
    'charge.success',
    'MOVA-fee-pass-test',
    '7000000001',
    101523,
    100000,
    'NGN',
    'card',
    now(),
    repeat(
      'b',
      64
    )
  )
  into result;

  if result->>'status'
      <> 'completed'
  then
    raise exception
      'Fee-pass transaction was not completed: %',
      result;
  end if;

  if not exists (
    select 1
    from public.outing_payment_intents
    where id =
      fee_intent
      and status =
        'completed'
      and amount_minor =
        100000
      and provider_requested_amount_minor =
        100000
      and provider_amount_minor =
        101523
      and provider_currency =
        'NGN'
      and reconciliation_state =
        'none'
  )
  then
    raise exception
      'Fee-pass provider amounts were not stored correctly.';
  end if;

  raise notice
    'Paystack fee-pass transaction completed correctly.';

  raise notice
    'MOVA requested: 100000';

  raise notice
    'Paystack charged: 101523';

  --------------------------------------------------------------------
  -- DUPLICATE DELIVERY REMAINS IDEMPOTENT
  --------------------------------------------------------------------

  select public.complete_outing_payment_from_provider(
    'paystack',
    'charge.success',
    'MOVA-fee-pass-test',
    '7000000001',
    101523,
    100000,
    'NGN',
    'card',
    now(),
    repeat(
      'c',
      64
    )
  )
  into result;

  if result->>'status'
      <> 'already_completed'
  then
    raise exception
      'Fee-pass duplicate was not idempotent: %',
      result;
  end if;

  raise notice
    'Fee-pass webhook retry is idempotent.';

  --------------------------------------------------------------------
  -- SCENARIO 2:
  -- The Paystack requested amount itself is wrong.
  --
  -- This must still enter reconciliation.
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
    'Requested Amount Mismatch Test',
    'Abuja',
    now() +
      interval '4 days',
    'NGN',
    100000
  )
  returning id
  into mismatch_outing;

  select id
  into mismatch_member
  from public.outing_members
  where outing_id =
    mismatch_outing
    and user_id =
      owner_user
    and removed_at
      is null
  limit 1;

  if mismatch_member is null
  then
    raise exception
      'Mismatch outing owner membership missing.';
  end if;

  perform public.set_outing_member_consent(
    owner_user,
    mismatch_outing,
    true
  );

  update public.outings
  set selected_member_id =
    mismatch_member
  where id =
    mismatch_outing;

  select public.prepare_outing_payment_intent(
    owner_user,
    mismatch_outing,
    'card',
    repeat(
      'd',
      64
    )
  )
  into result;

  if result->>'status'
      <> 'created'
  then
    raise exception
      'Unable to create mismatch intent: %',
      result;
  end if;

  mismatch_intent :=
    (
      result->>'intentId'
    )::uuid;

  select public.attach_outing_payment_checkout(
    owner_user,
    mismatch_intent,
    'paystack',
    'access_requested_mismatch',
    'MOVA-requested-mismatch',
    'https://checkout.paystack.com/requested-mismatch',
    now() +
      interval '10 minutes'
  )
  into result;

  if result->>'status'
      <> 'ready'
  then
    raise exception
      'Unable to attach mismatch checkout: %',
      result;
  end if;

  select public.complete_outing_payment_from_provider(
    'paystack',
    'charge.success',
    'MOVA-requested-mismatch',
    '7000000002',
    103046,
    101500,
    'NGN',
    'card',
    now(),
    repeat(
      'e',
      64
    )
  )
  into result;

  if result->>'status'
      <> 'reconciliation_required'
    or result->>'reason'
      <> 'amount_or_currency_mismatch'
  then
    raise exception
      'Wrong requested amount was not rejected: %',
      result;
  end if;

  if not exists (
    select 1
    from public.outing_payment_intents
    where id =
      mismatch_intent
      and amount_minor =
        100000
      and provider_requested_amount_minor =
        101500
      and provider_amount_minor =
        103046
      and reconciliation_state =
        'required'
      and reconciliation_reason =
        'amount_or_currency_mismatch'
  )
  then
    raise exception
      'Requested-amount mismatch was not stored correctly.';
  end if;

  raise notice
    'Wrong Paystack requested amount still enters reconciliation.';

  --------------------------------------------------------------------
  -- SUCCESS
  --------------------------------------------------------------------

  raise notice
    '================================================';
  raise notice
    'ALL PAYSTACK REQUESTED-AMOUNT TESTS PASSED';
  raise notice
    '================================================';

end;
$$;

rollback;