begin;

do $$
declare
  owner_user uuid;

  first_outing uuid;
  first_member uuid;
  first_intent uuid;

  second_outing uuid;
  second_member uuid;
  second_intent uuid;
  second_retry_intent uuid;

  third_intent uuid;

  result jsonb;

  first_reference text :=
    'MOVA-reconcile-late-001';

  second_reference text :=
    'MOVA-reconcile-refund-001';

  third_reference text :=
    'MOVA-reconcile-double-001';

  first_transaction text :=
    '900000000000000001';

  second_transaction text :=
    '900000000000000002';

  third_transaction text :=
    '900000000000000003';

  first_idempotency text :=
    repeat(
      'a',
      64
    );

  first_retry_idempotency text :=
    repeat(
      'b',
      64
    );

  second_idempotency text :=
    repeat(
      'c',
      64
    );

  second_retry_idempotency text :=
    repeat(
      'd',
      64
    );

  first_payload text :=
    repeat(
      'e',
      64
    );

  first_duplicate_payload text :=
    repeat(
      'f',
      64
    );

  second_payload text :=
    repeat(
      '1',
      64
    );

  third_payload text :=
    repeat(
      '2',
      64
    );
begin

  --------------------------------------------------------------------
  -- EXISTING MOVA USER
  --------------------------------------------------------------------

  select user_id
  into owner_user
  from public.profiles
  order by created_at
  limit 1;

  if owner_user is null
  then
    raise exception
      'Reconciliation test requires at least one MOVA profile.';
  end if;

  raise notice
    'Existing MOVA profile loaded.';

  --------------------------------------------------------------------
  -- SCENARIO 1
  --
  -- Paystack confirms payment after MOVA expired the checkout.
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
    'Late Payment Reconciliation Test',
    'Lagos',
    now() +
      interval '3 days',
    'NGN',
    750000
  )
  returning id
  into first_outing;

  select id
  into first_member
  from public.outing_members
  where outing_id =
    first_outing
    and user_id =
      owner_user
    and removed_at is null
  limit 1;

  if first_member is null
  then
    raise exception
      'First outing owner membership missing.';
  end if;

  perform public.set_outing_member_consent(
    owner_user,
    first_outing,
    true
  );

  update public.outings
  set selected_member_id =
    first_member
  where id =
    first_outing;

  select public.prepare_outing_payment_intent(
    owner_user,
    first_outing,
    'card',
    first_idempotency
  )
  into result;

  if result->>'status'
      <> 'created'
  then
    raise exception
      'First payment intent creation failed: %',
      result;
  end if;

  first_intent :=
    (
      result->>'intentId'
    )::uuid;

  select public.attach_outing_payment_checkout(
    owner_user,
    first_intent,
    'paystack',
    'access_reconcile_late_001',
    first_reference,
    'https://checkout.paystack.com/reconcile-late-001',
    now() +
      interval '10 minutes'
  )
  into result;

  if result->>'status'
      <> 'ready'
  then
    raise exception
      'First checkout attachment failed: %',
      result;
  end if;

  update public.outing_payment_intents
  set status =
    'expired'
  where id =
    first_intent;

  select public.complete_outing_payment_from_provider(
    'paystack',
    'charge.success',
    first_reference,
    first_transaction,
    750000,
    'NGN',
    'card',
    now(),
    first_payload
  )
  into result;

  if result->>'status'
      <> 'reconciliation_required'
  then
    raise exception
      'Late provider success did not enter reconciliation: %',
      result;
  end if;

  if result->>'reason'
      <> 'late_success_expired'
  then
    raise exception
      'Unexpected late-payment reconciliation reason: %',
      result;
  end if;

  if not exists (
    select 1
    from public.outing_payment_intents
    where id =
      first_intent
      and status =
        'expired'
      and reconciliation_state =
        'required'
      and reconciliation_reason =
        'late_success_expired'
      and provider_transaction_id =
        first_transaction
      and provider_amount_minor =
        750000
      and provider_currency =
        'NGN'
      and provider_paid_at
        is not null
      and provider_verified_at
        is not null
  )
  then
    raise exception
      'Late provider payment was not stored for reconciliation.';
  end if;

  raise notice
    'Late verified payment enters reconciliation.';

  --------------------------------------------------------------------
  -- OPEN RECONCILIATION MUST BLOCK A SECOND CHARGE
  --------------------------------------------------------------------

  begin
    perform public.prepare_outing_payment_intent(
      owner_user,
      first_outing,
      'card',
      first_retry_idempotency
    );

    raise exception
      'Expected reconciliation to block a second payment attempt.';
  exception
    when raise_exception then
      if sqlerrm not like
        '%OUTING_PAYMENT_RECONCILIATION_REQUIRED%'
      then
        raise;
      end if;
  end;

  raise notice
    'Open reconciliation blocks a second payment attempt.';

  --------------------------------------------------------------------
  -- OPERATOR ACCEPTS THE VERIFIED LATE PAYMENT
  --------------------------------------------------------------------

  select public.resolve_outing_payment_reconciliation(
    first_intent,
    'accepted_payment',
    'Verified late Paystack payment accepted for the outing.'
  )
  into result;

  if result->>'status'
      <> 'resolved'
    or result->>'resolution'
      <> 'accepted_payment'
  then
    raise exception
      'Late payment reconciliation did not resolve: %',
      result;
  end if;

  if not exists (
    select 1
    from public.outing_payment_intents
    where id =
      first_intent
      and status =
        'completed'
      and reconciliation_state =
        'resolved'
      and reconciliation_resolution =
        'accepted_payment'
      and reconciliation_resolved_at
        is not null
      and completed_at
        is not null
  )
  then
    raise exception
      'Accepted reconciliation did not complete the payment.';
  end if;

  raise notice
    'Accepted late payment becomes the completed outing payment.';

  --------------------------------------------------------------------
  -- WEBHOOK RETRY AFTER ACCEPTED PAYMENT IS IDEMPOTENT
  --------------------------------------------------------------------

  select public.complete_outing_payment_from_provider(
    'paystack',
    'charge.success',
    first_reference,
    first_transaction,
    750000,
    'NGN',
    'card',
    now(),
    first_duplicate_payload
  )
  into result;

  if result->>'status'
      <> 'already_completed'
  then
    raise exception
      'Completed reconciliation was not idempotent: %',
      result;
  end if;

  raise notice
    'Accepted reconciliation remains idempotent.';

  --------------------------------------------------------------------
  -- SCENARIO 2
  --
  -- A late provider payment is refunded rather than accepted.
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
    'Refund Reconciliation Test',
    'Abuja',
    now() +
      interval '4 days',
    'NGN',
    500000
  )
  returning id
  into second_outing;

  select id
  into second_member
  from public.outing_members
  where outing_id =
    second_outing
    and user_id =
      owner_user
    and removed_at is null
  limit 1;

  if second_member is null
  then
    raise exception
      'Second outing owner membership missing.';
  end if;

  perform public.set_outing_member_consent(
    owner_user,
    second_outing,
    true
  );

  update public.outings
  set selected_member_id =
    second_member
  where id =
    second_outing;

  select public.prepare_outing_payment_intent(
    owner_user,
    second_outing,
    'card',
    second_idempotency
  )
  into result;

  if result->>'status'
      <> 'created'
  then
    raise exception
      'Second payment intent creation failed: %',
      result;
  end if;

  second_intent :=
    (
      result->>'intentId'
    )::uuid;

  select public.attach_outing_payment_checkout(
    owner_user,
    second_intent,
    'paystack',
    'access_reconcile_refund_001',
    second_reference,
    'https://checkout.paystack.com/reconcile-refund-001',
    now() +
      interval '10 minutes'
  )
  into result;

  if result->>'status'
      <> 'ready'
  then
    raise exception
      'Second checkout attachment failed: %',
      result;
  end if;

  update public.outing_payment_intents
  set status =
    'cancelled'
  where id =
    second_intent;

  select public.complete_outing_payment_from_provider(
    'paystack',
    'charge.success',
    second_reference,
    second_transaction,
    500000,
    'NGN',
    'card',
    now(),
    second_payload
  )
  into result;

  if result->>'status'
      <> 'reconciliation_required'
  then
    raise exception
      'Cancelled checkout success did not enter reconciliation: %',
      result;
  end if;

  select public.resolve_outing_payment_reconciliation(
    second_intent,
    'refunded',
    'Test refund confirmed against the Paystack transaction.'
  )
  into result;

  if result->>'status'
      <> 'resolved'
    or result->>'resolution'
      <> 'refunded'
  then
    raise exception
      'Refund reconciliation failed: %',
      result;
  end if;

  if not exists (
    select 1
    from public.outing_payment_intents
    where id =
      second_intent
      and status =
        'cancelled'
      and reconciliation_state =
        'resolved'
      and reconciliation_resolution =
        'refunded'
  )
  then
    raise exception
      'Refund reconciliation was not stored.';
  end if;

  raise notice
    'Refund reconciliation stored successfully.';

  --------------------------------------------------------------------
  -- REFUND RESOLUTION UNBLOCKS A NEW PAYMENT ATTEMPT
  --------------------------------------------------------------------

  select public.prepare_outing_payment_intent(
    owner_user,
    second_outing,
    'card',
    second_retry_idempotency
  )
  into result;

  if result->>'status'
      <> 'created'
  then
    raise exception
      'Resolved refund did not unblock payment: %',
      result;
  end if;

  second_retry_intent :=
    (
      result->>'intentId'
    )::uuid;

  if second_retry_intent is null
  then
    raise exception
      'Retry intent was not created after refund reconciliation.';
  end if;

  raise notice
    'Resolved refund allows a new payment attempt.';

  --------------------------------------------------------------------
  -- SCENARIO 3
  --
  -- A second provider payment arrives after the outing is already paid.
  --
  -- It must become reconciliation instead of causing a unique-index
  -- failure or silently creating a second completed payment.
  --------------------------------------------------------------------

  insert into public.outing_payment_intents (
    outing_id,
    selected_member_id,
    payer_user_id,
    amount_minor,
    currency,
    method_id,
    status,
    idempotency_key_hash,
    provider,
    provider_checkout_id,
    provider_reference,
    checkout_url,
    expires_at
  )
  values (
    first_outing,
    first_member,
    owner_user,
    750000,
    'NGN',
    'card',
    'checkout_ready',
    repeat(
      '3',
      64
    ),
    'paystack',
    'access_reconcile_double_001',
    third_reference,
    'https://checkout.paystack.com/reconcile-double-001',
    now() +
      interval '10 minutes'
  )
  returning id
  into third_intent;

  select public.complete_outing_payment_from_provider(
    'paystack',
    'charge.success',
    third_reference,
    third_transaction,
    750000,
    'NGN',
    'card',
    now(),
    third_payload
  )
  into result;

  if result->>'status'
      <> 'reconciliation_required'
    or result->>'reason'
      <> 'outing_already_paid'
  then
    raise exception
      'Second real payment was not routed to reconciliation: %',
      result;
  end if;

  if (
    select count(*)
    from public.outing_payment_intents
    where outing_id =
      first_outing
      and status =
        'completed'
  ) <> 1
  then
    raise exception
      'Outing does not have exactly one completed payment.';
  end if;

  raise notice
    'Second real payment is safely routed to reconciliation.';

  --------------------------------------------------------------------
  -- SECOND PAYMENT MUST BE REFUNDED, NOT ACCEPTED
  --------------------------------------------------------------------

  select public.resolve_outing_payment_reconciliation(
    third_intent,
    'accepted_payment',
    'Attempt to accept a duplicate payment.'
  )
  into result;

  if result->>'status'
      <> 'already_paid'
  then
    raise exception
      'Duplicate completed payment was incorrectly accepted: %',
      result;
  end if;

  select public.resolve_outing_payment_reconciliation(
    third_intent,
    'refunded',
    'Duplicate test payment refunded to the payer.'
  )
  into result;

  if result->>'status'
      <> 'resolved'
    or result->>'resolution'
      <> 'refunded'
  then
    raise exception
      'Duplicate payment refund resolution failed: %',
      result;
  end if;

  raise notice
    'Duplicate payment can only be resolved safely by refund.';

  --------------------------------------------------------------------
  -- SUCCESS
  --------------------------------------------------------------------

  raise notice
    '================================================';
  raise notice
    'ALL OUTING PAYMENT RECONCILIATION TESTS PASSED';
  raise notice
    '================================================';

end;
$$;

rollback;