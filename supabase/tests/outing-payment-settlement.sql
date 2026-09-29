begin;

----------------------------------------------------------------------
-- OUTING PAYMENT SETTLEMENT TEST
--
-- This test uses an existing MOVA profile.
--
-- Everything created by this script is rolled back at the end.
----------------------------------------------------------------------

do $$
declare
  owner_user uuid;

  test_outing uuid;
  owner_member uuid;

  consent_result jsonb;
  intent_result jsonb;
  attach_result jsonb;

  mismatch_result jsonb;
  completion_result jsonb;
  duplicate_result jsonb;

  intent_id uuid;

  idempotency_hash text :=
    repeat(
      'a',
      64
    );

  mismatch_payload_hash text :=
    repeat(
      'b',
      64
    );

  success_payload_hash text :=
    repeat(
      'c',
      64
    );

  test_provider_reference text :=
    'MOVA-settlement-test-001';

  test_provider_transaction_id text :=
    '123456789012345678';
begin

  --------------------------------------------------------------------
  -- LOAD AN EXISTING MOVA PROFILE
  --------------------------------------------------------------------

  select user_id
  into owner_user
  from public.profiles
  order by created_at
  limit 1;

  if owner_user is null
  then
    raise exception
      'Settlement test requires at least one MOVA profile.';
  end if;

  raise notice
    'Existing MOVA profile loaded.';

  --------------------------------------------------------------------
  -- CREATE TEST OUTING
  --
  -- Existing outing migration automatically creates the owner member
  -- when an outing is inserted.
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
    'Payment Settlement Test',
    'Lagos',
    now() +
      interval '3 days',
    'NGN',
    750000
  )
  returning id
  into test_outing;

  if test_outing is null
  then
    raise exception
      'Test outing was not created.';
  end if;

  raise notice
    'Test outing created.';

  --------------------------------------------------------------------
  -- LOAD AUTOMATIC OWNER MEMBERSHIP
  --------------------------------------------------------------------

  select id
  into owner_member
  from public.outing_members
  where outing_id =
    test_outing
    and user_id =
      owner_user
    and removed_at is null
    and role =
      'owner'
  limit 1;

  if owner_member is null
  then
    raise exception
      'Owner membership missing.';
  end if;

  raise notice
    'Owner membership loaded.';

  --------------------------------------------------------------------
  -- OWNER OPTS INTO PAYER SELECTION
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
      'Owner consent failed: %',
      consent_result;
  end if;

  if consent_result->>'optedIn'
      <> 'true'
  then
    raise exception
      'Owner was not opted in: %',
      consent_result;
  end if;

  raise notice
    'Owner opted into payer selection.';

  --------------------------------------------------------------------
  -- SELECT OWNER AS PAYER
  --
  -- This test deliberately sets the member directly because roulette
  -- behaviour has already been tested separately.
  --------------------------------------------------------------------

  update public.outings
  set selected_member_id =
    owner_member
  where id =
    test_outing;

  if not exists (
    select 1
    from public.outings
    where id =
      test_outing
      and selected_member_id =
        owner_member
  )
  then
    raise exception
      'Selected payer was not stored.';
  end if;

  raise notice
    'Owner selected as payer.';

  --------------------------------------------------------------------
  -- PREPARE TRUSTED MOVA PAYMENT INTENT
  --------------------------------------------------------------------

  select public.prepare_outing_payment_intent(
    owner_user,
    test_outing,
    'card',
    idempotency_hash
  )
  into intent_result;

  if intent_result->>'status'
      <> 'created'
  then
    raise exception
      'Payment intent creation failed: %',
      intent_result;
  end if;

  if intent_result->>'intentId'
      is null
  then
    raise exception
      'Payment intent ID missing: %',
      intent_result;
  end if;

  intent_id :=
    (
      intent_result->>'intentId'
    )::uuid;

  if (
    intent_result->>'amountMinor'
  )::bigint <>
      750000
  then
    raise exception
      'Trusted payment amount is incorrect: %',
      intent_result;
  end if;

  if intent_result->>'currency'
      <> 'NGN'
  then
    raise exception
      'Trusted payment currency is incorrect: %',
      intent_result;
  end if;

  raise notice
    'Trusted payment intent created.';

  --------------------------------------------------------------------
  -- ATTACH MOCK PAYSTACK CHECKOUT
  --------------------------------------------------------------------

  select public.attach_outing_payment_checkout(
    owner_user,
    intent_id,
    'paystack',
    'access_code_settlement_test',
    test_provider_reference,
    'https://checkout.paystack.com/test-settlement',
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
      intent_id
      and status =
        'checkout_ready'
      and provider =
        'paystack'
      and provider_reference =
        test_provider_reference
  )
  then
    raise exception
      'Provider checkout was not stored correctly.';
  end if;

  raise notice
    'Provider checkout prepared for settlement.';

  --------------------------------------------------------------------
  -- WRONG VERIFIED AMOUNT MUST NOT COMPLETE PAYMENT
  --------------------------------------------------------------------

  select public.complete_outing_payment_from_provider(
    'paystack',
    'charge.success',
    test_provider_reference,
    test_provider_transaction_id,
    750001,
    'NGN',
    'card',
    now(),
    mismatch_payload_hash
  )
  into mismatch_result;

  if mismatch_result->>'status'
      <> 'mismatch'
  then
    raise exception
      'Amount mismatch was not rejected: %',
      mismatch_result;
  end if;

  if exists (
    select 1
    from public.outing_payment_intents
    where id =
      intent_id
      and status =
        'completed'
  )
  then
    raise exception
      'Mismatched provider payment completed the MOVA intent.';
  end if;

  if not exists (
    select 1
    from public.outing_payment_provider_events
    where payment_intent_id =
      intent_id
      and provider =
        'paystack'
      and payload_hash =
        mismatch_payload_hash
  )
  then
    raise exception
      'Mismatched provider event was not audited.';
  end if;

  raise notice
    'Provider amount mismatch is rejected.';

  --------------------------------------------------------------------
  -- CORRECT VERIFIED PAYMENT COMPLETES MOVA INTENT
  --------------------------------------------------------------------

  select public.complete_outing_payment_from_provider(
    'paystack',
    'charge.success',
    test_provider_reference,
    test_provider_transaction_id,
    750000,
    'NGN',
    'card',
    now(),
    success_payload_hash
  )
  into completion_result;

  if completion_result->>'status'
      <> 'completed'
  then
    raise exception
      'Verified payment did not complete: %',
      completion_result;
  end if;

  if completion_result->>'intentId'
      <> intent_id::text
  then
    raise exception
      'Completed intent ID does not match: %',
      completion_result;
  end if;

  if completion_result->>'outingId'
      <> test_outing::text
  then
    raise exception
      'Completed outing ID does not match: %',
      completion_result;
  end if;

  if (
    completion_result->>'amountMinor'
  )::bigint <>
      750000
  then
    raise exception
      'Completed amount is incorrect: %',
      completion_result;
  end if;

  if completion_result->>'currency'
      <> 'NGN'
  then
    raise exception
      'Completed currency is incorrect: %',
      completion_result;
  end if;

  --------------------------------------------------------------------
  -- VERIFY STORED SETTLEMENT
  --------------------------------------------------------------------

  if not exists (
    select 1
    from public.outing_payment_intents
    where id =
      intent_id
      and status =
        'completed'
      and provider =
        'paystack'
      and provider_reference =
        test_provider_reference
      and provider_transaction_id =
        test_provider_transaction_id
      and provider_channel =
        'card'
      and provider_paid_at
        is not null
      and provider_verified_at
        is not null
      and completed_at
        is not null
  )
  then
    raise exception
      'Completed provider settlement was not stored correctly.';
  end if;

  raise notice
    'Verified provider payment completes the MOVA intent.';

  --------------------------------------------------------------------
  -- EXACT WEBHOOK RETRY MUST BE IDEMPOTENT
  --------------------------------------------------------------------

  select public.complete_outing_payment_from_provider(
    'paystack',
    'charge.success',
    test_provider_reference,
    test_provider_transaction_id,
    750000,
    'NGN',
    'card',
    now(),
    success_payload_hash
  )
  into duplicate_result;

  if duplicate_result->>'status'
      <> 'already_completed'
  then
    raise exception
      'Duplicate provider event was not idempotent: %',
      duplicate_result;
  end if;

  --------------------------------------------------------------------
  -- THE DUPLICATE WEBHOOK MUST NOT CREATE ANOTHER EVENT ROW
  --
  -- We expect exactly:
  --
  --   1 mismatch event
  --   1 successful event
  --
  -- The retried successful webhook uses the same payload hash, so its
  -- audit insert is ignored.
  --------------------------------------------------------------------

  if (
    select count(*)
    from public.outing_payment_provider_events
    where payment_intent_id =
      intent_id
  ) <> 2
  then
    raise exception
      'Expected one mismatch audit event and one successful audit event.';
  end if;

  if (
    select count(*)
    from public.outing_payment_provider_events
    where payment_intent_id =
      intent_id
      and payload_hash =
        success_payload_hash
  ) <> 1
  then
    raise exception
      'Duplicate webhook created more than one successful audit event.';
  end if;

  raise notice
    'Duplicate webhook processing is idempotent.';

  --------------------------------------------------------------------
  -- OUTING MAY HAVE ONLY ONE COMPLETED PAYMENT
  --------------------------------------------------------------------

  if (
    select count(*)
    from public.outing_payment_intents
    where outing_id =
      test_outing
      and status =
        'completed'
  ) <> 1
  then
    raise exception
      'Unexpected number of completed payment intents.';
  end if;

  raise notice
    'Outing has exactly one completed payment.';

  --------------------------------------------------------------------
  -- VERIFY PROVIDER TRANSACTION ID
  --------------------------------------------------------------------

  if (
    select provider_transaction_id
    from public.outing_payment_intents
    where id =
      intent_id
  ) <>
    test_provider_transaction_id
  then
    raise exception
      'Provider transaction ID was not stored correctly.';
  end if;

  raise notice
    'Provider transaction ID stored correctly.';

  --------------------------------------------------------------------
  -- SUCCESS
  --------------------------------------------------------------------

  raise notice
    '==========================================';
  raise notice
    'ALL OUTING PAYMENT SETTLEMENT TESTS PASSED';
  raise notice
    '==========================================';

end;
$$;

----------------------------------------------------------------------
-- TEST DATA IS NEVER COMMITTED
----------------------------------------------------------------------

rollback;