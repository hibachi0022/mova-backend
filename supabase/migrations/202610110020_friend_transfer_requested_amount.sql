begin;

----------------------------------------------------------------------
-- FRIEND TRANSFER PAYSTACK REQUESTED AMOUNT
--
-- Paystack exposes two different monetary values:
--
--   requested_amount
--     Amount MOVA originally asked Paystack to collect.
--
--   amount
--     Actual amount charged to the payer. Depending on provider fee
--     configuration, this may be greater than requested_amount.
--
-- Friend-transfer settlement must compare MOVA's trusted charge amount
-- against requested_amount, not blindly against the final amount
-- charged by Paystack.
----------------------------------------------------------------------

alter table
  public.friend_transfer_payment_intents
add column
  provider_requested_amount_minor bigint;

alter table
  public.friend_transfer_payment_intents
add constraint
  friend_transfer_payment_provider_requested_amount_check
check (
  provider_requested_amount_minor
    is null
  or (
    provider_requested_amount_minor >
      0
    and provider_requested_amount_minor <=
      9007199254740991
  )
);

----------------------------------------------------------------------
-- VERIFIED SENDER PAYMENT COMPLETION
--
-- New signature includes:
--
--   p_amount_minor
--     Actual amount charged by Paystack.
--
--   p_requested_amount_minor
--     Amount MOVA asked Paystack to collect.
--
-- Only requested_amount is compared with MOVA's trusted charge terms.
----------------------------------------------------------------------

create or replace function
  public.complete_friend_transfer_payment_from_provider(
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

  intent_row
    public.friend_transfer_payment_intents%rowtype;

  payout_id uuid;

  reconciliation_reason_value text;
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
    lower(
      btrim(
        coalesce(
          p_event_type,
          ''
        )
      )
    );

  cleaned_reference :=
    lower(
      btrim(
        coalesce(
          p_provider_reference,
          ''
        )
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
    or cleaned_reference !~
      '^mova-ft-[0-9a-f]{32}$'
    or char_length(
      cleaned_transaction_id
    ) not between 1 and 100
    or p_amount_minor
      is null
    or p_amount_minor <=
      0
    or p_amount_minor >
      9007199254740991
    or p_requested_amount_minor
      is null
    or p_requested_amount_minor <=
      0
    or p_requested_amount_minor >
      9007199254740991
    or cleaned_currency <>
      'NGN'
    or char_length(
      cleaned_channel
    ) not between 1 and 40
    or p_paid_at
      is null
    or p_payload_hash
      is null
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
  from public.friend_transfer_payment_intents
  where provider =
    cleaned_provider
    and provider_reference =
      cleaned_reference
  for update;

  if not found then
    return jsonb_build_object(
      'status',
      'not_found'
    );
  end if;

  --------------------------------------------------------------------
  -- AUDIT PROVIDER DELIVERY
  --------------------------------------------------------------------

  insert into public.friend_transfer_provider_events (
    payment_intent_id,
    provider,
    event_type,
    provider_reference,
    provider_object_id,
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
  -- IDEMPOTENT COMPLETED PAYMENT RETRY
  --------------------------------------------------------------------

  if intent_row.status =
      'completed'
  then
    if intent_row.provider_transaction_id =
        cleaned_transaction_id
      and intent_row.provider_reference =
        cleaned_reference
      and intent_row.charge_amount_minor =
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
      update public.friend_transfer_payment_intents
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

      select id
      into payout_id
      from public.friend_transfer_payouts
      where payment_intent_id =
        intent_row.id
      limit 1;

      ----------------------------------------------------------------
      -- Defensive repair:
      --
      -- A completed verified charge must have exactly one payout row.
      ----------------------------------------------------------------

      if payout_id
          is null
      then
        insert into public.friend_transfer_payouts (
          payment_intent_id,
          quote_id,
          sender_user_id,
          recipient_user_id,
          receiving_account_id,
          amount_minor,
          currency,
          status,
          provider
        )
        values (
          intent_row.id,
          intent_row.quote_id,
          intent_row.sender_user_id,
          intent_row.recipient_user_id,
          intent_row.receiving_account_id,
          intent_row.principal_amount_minor,
          intent_row.currency,
          'created',
          'paystack'
        )
        on conflict (
          payment_intent_id
        )
        do nothing
        returning id
        into payout_id;

        if payout_id
            is null
        then
          select id
          into payout_id
          from public.friend_transfer_payouts
          where payment_intent_id =
            intent_row.id
          limit 1;
        end if;
      end if;

      return jsonb_build_object(
        'status',
        'already_completed',

        'intentId',
        intent_row.id,

        'quoteId',
        intent_row.quote_id,

        'payoutId',
        payout_id
      );
    end if;

    return jsonb_build_object(
      'status',
      'conflict'
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
      update public.friend_transfer_payment_intents
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
        intent_row.id
      );
    end if;

    return jsonb_build_object(
      'status',
      'conflict'
    );
  end if;

  --------------------------------------------------------------------
  -- ONE PROVIDER TRANSACTION CANNOT FUND TWO MOVA TRANSFERS
  --------------------------------------------------------------------

  if exists (
    select 1
    from public.friend_transfer_payment_intents
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
      'conflict'
    );
  end if;

  if intent_row.provider_transaction_id
      is not null
    and intent_row.provider_transaction_id <>
      cleaned_transaction_id
  then
    return jsonb_build_object(
      'status',
      'conflict'
    );
  end if;

  --------------------------------------------------------------------
  -- TRUSTED AMOUNT / CURRENCY VALIDATION
  --
  -- IMPORTANT:
  --
  -- charge_amount_minor:
  --   MOVA's trusted charge amount.
  --
  -- p_requested_amount_minor:
  --   Amount MOVA asked Paystack to charge.
  --
  -- p_amount_minor:
  --   Actual amount charged and may include provider fees.
  --------------------------------------------------------------------

  if intent_row.charge_amount_minor <>
      p_requested_amount_minor
    or intent_row.currency <>
      cleaned_currency
  then
    update public.friend_transfer_payment_intents
    set
      provider_transaction_id =
        cleaned_transaction_id,

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
        now(),

      reconciliation_state =
        'required',

      reconciliation_reason =
        'amount_or_currency_mismatch',

      reconciliation_required_at =
        now()
    where id =
      intent_row.id;

    return jsonb_build_object(
      'status',
      'reconciliation_required',

      'reason',
      'amount_or_currency_mismatch',

      'intentId',
      intent_row.id
    );
  end if;

  --------------------------------------------------------------------
  -- LATE PROVIDER SUCCESS
  --
  -- Money exists at Paystack, but MOVA no longer considered this
  -- payment attempt safely payable.
  --------------------------------------------------------------------

  if intent_row.status <>
      'processing'
  then
    reconciliation_reason_value :=
      'late_success_' ||
      intent_row.status;

    update public.friend_transfer_payment_intents
    set
      provider_transaction_id =
        cleaned_transaction_id,

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
        now(),

      reconciliation_state =
        'required',

      reconciliation_reason =
        reconciliation_reason_value,

      reconciliation_required_at =
        now()
    where id =
      intent_row.id;

    return jsonb_build_object(
      'status',
      'reconciliation_required',

      'reason',
      reconciliation_reason_value,

      'intentId',
      intent_row.id
    );
  end if;

  --------------------------------------------------------------------
  -- ANOTHER PAYMENT MUST NOT ALREADY HAVE COMPLETED THIS QUOTE
  --------------------------------------------------------------------

  if exists (
    select 1
    from public.friend_transfer_payment_intents
    where quote_id =
      intent_row.quote_id
      and status =
        'completed'
      and id <>
        intent_row.id
  )
  then
    update public.friend_transfer_payment_intents
    set
      provider_transaction_id =
        cleaned_transaction_id,

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
        now(),

      reconciliation_state =
        'required',

      reconciliation_reason =
        'quote_already_paid',

      reconciliation_required_at =
        now()
    where id =
      intent_row.id;

    return jsonb_build_object(
      'status',
      'reconciliation_required',

      'reason',
      'quote_already_paid',

      'intentId',
      intent_row.id
    );
  end if;

  --------------------------------------------------------------------
  -- NORMAL VERIFIED COMPLETION
  --------------------------------------------------------------------

  update public.friend_transfer_payment_intents
  set
    status =
      'completed',

    provider_transaction_id =
      cleaned_transaction_id,

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
      now(),

    completed_at =
      p_paid_at,

    failure_reason =
      null
  where id =
    intent_row.id;

  update public.friend_transfer_quotes
  set
    status =
      'consumed',

    consumed_at =
      p_paid_at
  where id =
    intent_row.quote_id;

  --------------------------------------------------------------------
  -- CREATE EXACTLY ONE PAYOUT
  --
  -- At this point sender funds are independently verified.
  --
  -- This does NOT contact Paystack's Transfer API yet.
  --------------------------------------------------------------------

  insert into public.friend_transfer_payouts (
    payment_intent_id,
    quote_id,
    sender_user_id,
    recipient_user_id,
    receiving_account_id,
    amount_minor,
    currency,
    status,
    provider
  )
  values (
    intent_row.id,
    intent_row.quote_id,
    intent_row.sender_user_id,
    intent_row.recipient_user_id,
    intent_row.receiving_account_id,
    intent_row.principal_amount_minor,
    intent_row.currency,
    'created',
    'paystack'
  )
  on conflict (
    payment_intent_id
  )
  do nothing
  returning id
  into payout_id;

  if payout_id
      is null
  then
    select id
    into payout_id
    from public.friend_transfer_payouts
    where payment_intent_id =
      intent_row.id
    limit 1;
  end if;

  return jsonb_build_object(
    'status',
    'completed',

    'intentId',
    intent_row.id,

    'quoteId',
    intent_row.quote_id,

    'senderUserId',
    intent_row.sender_user_id,

    'recipientUserId',
    intent_row.recipient_user_id,

    'amountMinor',
    intent_row.principal_amount_minor,

    'chargedAmountMinor',
    p_amount_minor,

    'requestedAmountMinor',
    p_requested_amount_minor,

    'currency',
    intent_row.currency,

    'payoutId',
    payout_id
  );
end;
$$;

----------------------------------------------------------------------
-- COMPATIBILITY WRAPPER
--
-- Migration 019 introduced the nine-argument version.
--
-- Keep it temporarily so a backend deployed during migration rollout
-- cannot fail with a missing RPC.
--
-- Once our new webhook code is deployed, it will always call the
-- ten-argument version above.
----------------------------------------------------------------------

create or replace function
  public.complete_friend_transfer_payment_from_provider(
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
    public.complete_friend_transfer_payment_from_provider(
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
-- BACKEND-ONLY EXECUTION
----------------------------------------------------------------------

revoke all
  on function
    public.complete_friend_transfer_payment_from_provider(
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
    public.complete_friend_transfer_payment_from_provider(
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
    public.complete_friend_transfer_payment_from_provider(
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
    public.complete_friend_transfer_payment_from_provider(
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

commit;