begin;

----------------------------------------------------------------------
-- PAYSTACK REQUESTED AMOUNT
--
-- Paystack may charge the payer more than MOVA requested when the
-- merchant account is configured to pass transaction fees to the
-- customer.
--
-- Example:
--
--   MOVA requested amount:       100000 kobo
--   Paystack actual charge:      101523 kobo
--   Paystack requested_amount:   100000 kobo
--
-- Financial validation must therefore compare MOVA's trusted amount
-- with Paystack's requested_amount, not with Paystack's final amount.
----------------------------------------------------------------------

alter table public.outing_payment_intents
  add column provider_requested_amount_minor bigint;

alter table public.outing_payment_intents
  add constraint outing_payment_intents_provider_requested_amount_check
    check (
      provider_requested_amount_minor is null
      or (
        provider_requested_amount_minor > 0
        and provider_requested_amount_minor <=
          9007199254740991
      )
    );

----------------------------------------------------------------------
-- NEW PROVIDER COMPLETION FUNCTION
----------------------------------------------------------------------

create or replace function
  public.complete_outing_payment_from_provider(
    p_provider text,
    p_event_type text,
    p_provider_reference text,
    p_provider_transaction_id text,
    p_amount_minor bigint,
    p_requested_amount_minor bigint,
    p_currency text,
    p_channel text,
    p_paid_at timestamptz,
    p_payload_hash text
  )
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  cleaned_provider text;
  cleaned_event_type text;
  cleaned_reference text;
  cleaned_transaction_id text;
  cleaned_currency text;
  cleaned_channel text;

  reconciliation_reason_value text;

  intent_row
    public.outing_payment_intents%rowtype;
begin
  cleaned_provider :=
    lower(
      btrim(
        coalesce(
          p_provider,
          ''
        )
      )
    );

  cleaned_event_type :=
    btrim(
      coalesce(
        p_event_type,
        ''
      )
    );

  cleaned_reference :=
    btrim(
      coalesce(
        p_provider_reference,
        ''
      )
    );

  cleaned_transaction_id :=
    btrim(
      coalesce(
        p_provider_transaction_id,
        ''
      )
    );

  cleaned_currency :=
    upper(
      btrim(
        coalesce(
          p_currency,
          ''
        )
      )
    );

  cleaned_channel :=
    lower(
      btrim(
        coalesce(
          p_channel,
          ''
        )
      )
    );

  --------------------------------------------------------------------
  -- INPUT VALIDATION
  --------------------------------------------------------------------

  if cleaned_provider <>
      'paystack'
    or cleaned_event_type <>
      'charge.success'
    or char_length(
      cleaned_reference
    ) not between 1 and 200
    or char_length(
      cleaned_transaction_id
    ) not between 1 and 100
    or p_amount_minor is null
    or p_amount_minor <=
      0
    or p_amount_minor >
      9007199254740991
    or p_requested_amount_minor is null
    or p_requested_amount_minor <=
      0
    or p_requested_amount_minor >
      9007199254740991
    or cleaned_currency !~
      '^[A-Z]{3}$'
    or char_length(
      cleaned_channel
    ) not between 1 and 40
    or p_paid_at is null
    or p_payload_hash is null
    or p_payload_hash !~
      '^[0-9a-f]{64}$'
  then
    return jsonb_build_object(
      'status',
      'invalid'
    );
  end if;

  --------------------------------------------------------------------
  -- FIND AND LOCK MOVA PAYMENT INTENT
  --------------------------------------------------------------------

  select *
  into intent_row
  from public.outing_payment_intents
  where provider =
    cleaned_provider
    and provider_reference =
      cleaned_reference
  for update;

  if not found
  then
    return jsonb_build_object(
      'status',
      'not_found'
    );
  end if;

  --------------------------------------------------------------------
  -- AUDIT PROVIDER DELIVERY
  --------------------------------------------------------------------

  insert into public.outing_payment_provider_events (
    payment_intent_id,
    provider,
    event_type,
    provider_reference,
    provider_transaction_id,
    payload_hash
  )
  values (
    intent_row.id,
    cleaned_provider,
    cleaned_event_type,
    cleaned_reference,
    cleaned_transaction_id,
    p_payload_hash
  )
  on conflict (
    provider,
    payload_hash
  )
  do nothing;

  --------------------------------------------------------------------
  -- COMPLETED PAYMENT RETRY
  --------------------------------------------------------------------

  if intent_row.status =
      'completed'
  then
    if intent_row.provider_transaction_id =
        cleaned_transaction_id
      and intent_row.provider_reference =
        cleaned_reference
      and intent_row.amount_minor =
        p_requested_amount_minor
      and intent_row.currency =
        cleaned_currency
      and (
        intent_row.provider_amount_minor
          is null
        or intent_row.provider_amount_minor =
          p_amount_minor
      )
      and (
        intent_row.provider_requested_amount_minor
          is null
        or intent_row.provider_requested_amount_minor =
          p_requested_amount_minor
      )
    then
      update public.outing_payment_intents
      set
        provider_amount_minor =
          coalesce(
            provider_amount_minor,
            p_amount_minor
          ),

        provider_requested_amount_minor =
          coalesce(
            provider_requested_amount_minor,
            p_requested_amount_minor
          ),

        provider_currency =
          coalesce(
            provider_currency,
            cleaned_currency
          )
      where id =
        intent_row.id;

      return jsonb_build_object(
        'status',
        'already_completed',

        'intentId',
        intent_row.id,

        'outingId',
        intent_row.outing_id
      );
    end if;

    return jsonb_build_object(
      'status',
      'conflict',

      'intentId',
      intent_row.id
    );
  end if;

  --------------------------------------------------------------------
  -- RESOLVED REFUND MUST NOT BE REOPENED
  --------------------------------------------------------------------

  if intent_row.reconciliation_state =
      'resolved'
    and intent_row.reconciliation_resolution =
      'refunded'
    and intent_row.provider_transaction_id =
      cleaned_transaction_id
  then
    return jsonb_build_object(
      'status',
      'reconciliation_resolved',

      'resolution',
      'refunded',

      'intentId',
      intent_row.id,

      'outingId',
      intent_row.outing_id
    );
  end if;

  --------------------------------------------------------------------
  -- EXISTING OPEN RECONCILIATION
  --------------------------------------------------------------------

  if intent_row.reconciliation_state =
      'required'
  then
    if intent_row.provider_transaction_id =
        cleaned_transaction_id
    then
      update public.outing_payment_intents
      set
        provider_amount_minor =
          p_amount_minor,

        provider_requested_amount_minor =
          p_requested_amount_minor,

        provider_currency =
          cleaned_currency,

        provider_channel =
          cleaned_channel,

        provider_paid_at =
          p_paid_at,

        provider_verified_at =
          now()
      where id =
        intent_row.id;

      return jsonb_build_object(
        'status',
        'reconciliation_required',

        'reason',
        intent_row.reconciliation_reason,

        'intentId',
        intent_row.id,

        'outingId',
        intent_row.outing_id,

        'paymentStatus',
        intent_row.status
      );
    end if;

    return jsonb_build_object(
      'status',
      'conflict',

      'intentId',
      intent_row.id
    );
  end if;

  --------------------------------------------------------------------
  -- PROVIDER TRANSACTION UNIQUENESS
  --------------------------------------------------------------------

  if exists (
    select 1
    from public.outing_payment_intents
    where provider =
      cleaned_provider
      and provider_transaction_id =
        cleaned_transaction_id
      and id <>
        intent_row.id
  )
  then
    return jsonb_build_object(
      'status',
      'conflict',

      'intentId',
      intent_row.id
    );
  end if;

  if intent_row.provider_transaction_id
      is not null
    and intent_row.provider_transaction_id <>
      cleaned_transaction_id
  then
    return jsonb_build_object(
      'status',
      'conflict',

      'intentId',
      intent_row.id
    );
  end if;

  --------------------------------------------------------------------
  -- TRUSTED AMOUNT / CURRENCY VALIDATION
  --
  -- IMPORTANT:
  --
  -- p_requested_amount_minor is what MOVA asked Paystack to collect.
  --
  -- p_amount_minor is what Paystack actually charged the payer and may
  -- include fees passed to the customer.
  --------------------------------------------------------------------

  if intent_row.amount_minor <>
      p_requested_amount_minor
    or intent_row.currency <>
      cleaned_currency
  then
    update public.outing_payment_intents
    set
      provider_transaction_id =
        cleaned_transaction_id,

      provider_channel =
        cleaned_channel,

      provider_paid_at =
        p_paid_at,

      provider_verified_at =
        now(),

      provider_amount_minor =
        p_amount_minor,

      provider_requested_amount_minor =
        p_requested_amount_minor,

      provider_currency =
        cleaned_currency,

      reconciliation_state =
        'required',

      reconciliation_reason =
        'amount_or_currency_mismatch',

      reconciliation_required_at =
        now(),

      reconciliation_resolution =
        null,

      reconciliation_resolved_at =
        null,

      reconciliation_note =
        null
    where id =
      intent_row.id;

    return jsonb_build_object(
      'status',
      'reconciliation_required',

      'reason',
      'amount_or_currency_mismatch',

      'intentId',
      intent_row.id,

      'outingId',
      intent_row.outing_id,

      'paymentStatus',
      intent_row.status
    );
  end if;

  --------------------------------------------------------------------
  -- OUTING ALREADY HAS ANOTHER COMPLETED PAYMENT
  --------------------------------------------------------------------

  if exists (
    select 1
    from public.outing_payment_intents
    where outing_id =
      intent_row.outing_id
      and status =
        'completed'
      and id <>
        intent_row.id
  )
  then
    update public.outing_payment_intents
    set
      provider_transaction_id =
        cleaned_transaction_id,

      provider_channel =
        cleaned_channel,

      provider_paid_at =
        p_paid_at,

      provider_verified_at =
        now(),

      provider_amount_minor =
        p_amount_minor,

      provider_requested_amount_minor =
        p_requested_amount_minor,

      provider_currency =
        cleaned_currency,

      reconciliation_state =
        'required',

      reconciliation_reason =
        'outing_already_paid',

      reconciliation_required_at =
        now(),

      reconciliation_resolution =
        null,

      reconciliation_resolved_at =
        null,

      reconciliation_note =
        null
    where id =
      intent_row.id;

    return jsonb_build_object(
      'status',
      'reconciliation_required',

      'reason',
      'outing_already_paid',

      'intentId',
      intent_row.id,

      'outingId',
      intent_row.outing_id,

      'paymentStatus',
      intent_row.status
    );
  end if;

  --------------------------------------------------------------------
  -- LATE PROVIDER SUCCESS
  --------------------------------------------------------------------

  if intent_row.status not in (
    'checkout_ready',
    'processing'
  )
  then
    reconciliation_reason_value :=
      'late_success_' ||
      intent_row.status;

    update public.outing_payment_intents
    set
      provider_transaction_id =
        cleaned_transaction_id,

      provider_channel =
        cleaned_channel,

      provider_paid_at =
        p_paid_at,

      provider_verified_at =
        now(),

      provider_amount_minor =
        p_amount_minor,

      provider_requested_amount_minor =
        p_requested_amount_minor,

      provider_currency =
        cleaned_currency,

      reconciliation_state =
        'required',

      reconciliation_reason =
        reconciliation_reason_value,

      reconciliation_required_at =
        now(),

      reconciliation_resolution =
        null,

      reconciliation_resolved_at =
        null,

      reconciliation_note =
        null
    where id =
      intent_row.id;

    return jsonb_build_object(
      'status',
      'reconciliation_required',

      'reason',
      reconciliation_reason_value,

      'intentId',
      intent_row.id,

      'outingId',
      intent_row.outing_id,

      'paymentStatus',
      intent_row.status
    );
  end if;

  --------------------------------------------------------------------
  -- NORMAL VERIFIED COMPLETION
  --------------------------------------------------------------------

  update public.outing_payment_intents
  set
    status =
      'completed',

    provider_transaction_id =
      cleaned_transaction_id,

    provider_channel =
      cleaned_channel,

    provider_paid_at =
      p_paid_at,

    provider_verified_at =
      now(),

    provider_amount_minor =
      p_amount_minor,

    provider_requested_amount_minor =
      p_requested_amount_minor,

    provider_currency =
      cleaned_currency,

    completed_at =
      p_paid_at
  where id =
    intent_row.id;

  return jsonb_build_object(
    'status',
    'completed',

    'intentId',
    intent_row.id,

    'outingId',
    intent_row.outing_id,

    'payerUserId',
    intent_row.payer_user_id,

    'amountMinor',
    intent_row.amount_minor,

    'chargedAmountMinor',
    p_amount_minor,

    'currency',
    intent_row.currency
  );
end;
$$;

----------------------------------------------------------------------
-- COMPATIBILITY WRAPPER
--
-- The currently deployed backend may briefly continue calling the
-- migration-008 function signature while Railway is being redeployed.
--
-- Keep that signature available so the transition fails safely rather
-- than producing a missing-RPC error.
--
-- Once the Nest backend is upgraded, all new webhooks use the function
-- above with Paystack requested_amount.
----------------------------------------------------------------------

create or replace function
  public.complete_outing_payment_from_provider(
    p_provider text,
    p_event_type text,
    p_provider_reference text,
    p_provider_transaction_id text,
    p_amount_minor bigint,
    p_currency text,
    p_channel text,
    p_paid_at timestamptz,
    p_payload_hash text
  )
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select
    public.complete_outing_payment_from_provider(
      p_provider,
      p_event_type,
      p_provider_reference,
      p_provider_transaction_id,
      p_amount_minor,
      p_amount_minor,
      p_currency,
      p_channel,
      p_paid_at,
      p_payload_hash
    );
$$;

----------------------------------------------------------------------
-- UPDATE MANUAL RECONCILIATION
--
-- A reconciliation may now safely accept a verified provider payment
-- whose actual charge includes Paystack fees, provided that Paystack's
-- requested_amount exactly matches MOVA's trusted amount.
----------------------------------------------------------------------

create or replace function
  public.resolve_outing_payment_reconciliation(
    p_intent_id uuid,
    p_resolution text,
    p_note text
  )
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  intent_row
    public.outing_payment_intents%rowtype;

  cleaned_resolution text;
  cleaned_note text;
begin
  cleaned_resolution :=
    lower(
      btrim(
        coalesce(
          p_resolution,
          ''
        )
      )
    );

  cleaned_note :=
    btrim(
      coalesce(
        p_note,
        ''
      )
    );

  if p_intent_id is null
    or cleaned_resolution not in (
      'accepted_payment',
      'refunded'
    )
    or char_length(
      cleaned_note
    ) not between 3 and 1000
  then
    return jsonb_build_object(
      'status',
      'invalid'
    );
  end if;

  select *
  into intent_row
  from public.outing_payment_intents
  where id =
    p_intent_id
  for update;

  if not found
  then
    return jsonb_build_object(
      'status',
      'not_found'
    );
  end if;

  if intent_row.reconciliation_state =
      'resolved'
  then
    return jsonb_build_object(
      'status',
      'already_resolved',

      'resolution',
      intent_row.reconciliation_resolution,

      'intentId',
      intent_row.id,

      'outingId',
      intent_row.outing_id
    );
  end if;

  if intent_row.reconciliation_state <>
      'required'
  then
    return jsonb_build_object(
      'status',
      'not_available'
    );
  end if;

  if intent_row.provider_transaction_id
      is null
    or intent_row.provider_paid_at
      is null
    or intent_row.provider_verified_at
      is null
    or intent_row.provider_amount_minor
      is null
    or intent_row.provider_requested_amount_minor
      is null
    or intent_row.provider_currency
      is null
  then
    return jsonb_build_object(
      'status',
      'invalid'
    );
  end if;

  --------------------------------------------------------------------
  -- ACCEPT VERIFIED PAYMENT
  --------------------------------------------------------------------

  if cleaned_resolution =
      'accepted_payment'
  then
    if intent_row.provider_requested_amount_minor <>
        intent_row.amount_minor
      or intent_row.provider_currency <>
        intent_row.currency
    then
      return jsonb_build_object(
        'status',
        'cannot_accept_mismatch',

        'intentId',
        intent_row.id,

        'outingId',
        intent_row.outing_id
      );
    end if;

    if exists (
      select 1
      from public.outing_payment_intents
      where outing_id =
        intent_row.outing_id
        and status =
          'completed'
        and id <>
          intent_row.id
    )
    then
      return jsonb_build_object(
        'status',
        'already_paid',

        'intentId',
        intent_row.id,

        'outingId',
        intent_row.outing_id
      );
    end if;

    update public.outing_payment_intents
    set status =
      'cancelled'
    where outing_id =
      intent_row.outing_id
      and id <>
        intent_row.id
      and status in (
        'created',
        'checkout_ready',
        'processing'
      );

    update public.outing_payment_intents
    set
      status =
        'completed',

      completed_at =
        provider_paid_at,

      reconciliation_state =
        'resolved',

      reconciliation_resolution =
        'accepted_payment',

      reconciliation_resolved_at =
        now(),

      reconciliation_note =
        cleaned_note
    where id =
      intent_row.id;

    return jsonb_build_object(
      'status',
      'resolved',

      'resolution',
      'accepted_payment',

      'intentId',
      intent_row.id,

      'outingId',
      intent_row.outing_id
    );
  end if;

  --------------------------------------------------------------------
  -- REFUND RESOLUTION
  --------------------------------------------------------------------

  update public.outing_payment_intents
  set
    status =
      case
        when status in (
          'created',
          'checkout_ready',
          'processing'
        )
        then 'cancelled'
        else status
      end,

    reconciliation_state =
      'resolved',

    reconciliation_resolution =
      'refunded',

    reconciliation_resolved_at =
      now(),

    reconciliation_note =
      cleaned_note
  where id =
    intent_row.id;

  return jsonb_build_object(
    'status',
    'resolved',

    'resolution',
    'refunded',

    'intentId',
    intent_row.id,

    'outingId',
    intent_row.outing_id
  );
end;
$$;

----------------------------------------------------------------------
-- ACCESS
----------------------------------------------------------------------

revoke all
  on function
    public.complete_outing_payment_from_provider(
      text,
      text,
      text,
      text,
      bigint,
      bigint,
      text,
      text,
      timestamptz,
      text
    )
  from public, anon, authenticated;

grant execute
  on function
    public.complete_outing_payment_from_provider(
      text,
      text,
      text,
      text,
      bigint,
      bigint,
      text,
      text,
      timestamptz,
      text
    )
  to service_role;

revoke all
  on function
    public.complete_outing_payment_from_provider(
      text,
      text,
      text,
      text,
      bigint,
      text,
      text,
      timestamptz,
      text
    )
  from public, anon, authenticated;

grant execute
  on function
    public.complete_outing_payment_from_provider(
      text,
      text,
      text,
      text,
      bigint,
      text,
      text,
      timestamptz,
      text
    )
  to service_role;

revoke all
  on function
    public.resolve_outing_payment_reconciliation(
      uuid,
      text,
      text
    )
  from public, anon, authenticated;

grant execute
  on function
    public.resolve_outing_payment_reconciliation(
      uuid,
      text,
      text
    )
  to service_role;

commit;