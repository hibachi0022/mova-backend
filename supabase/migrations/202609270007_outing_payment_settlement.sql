begin;

----------------------------------------------------------------------
-- OUTING PAYMENT SETTLEMENT
--
-- This migration adds the database-side settlement layer for provider
-- payments.
--
-- A checkout opening successfully does NOT mean an outing has been
-- paid.
--
-- The backend must first:
--
--   1. Receive a Paystack webhook.
--   2. Verify the webhook signature.
--   3. Verify the transaction directly with Paystack.
--   4. Confirm reference, amount, currency and status.
--   5. Call complete_outing_payment_from_provider().
--
-- Only then can MOVA mark the payment intent as completed.
----------------------------------------------------------------------

----------------------------------------------------------------------
-- PROVIDER SETTLEMENT INFORMATION
----------------------------------------------------------------------

alter table public.outing_payment_intents
  add column provider_transaction_id text,
  add column provider_channel text,
  add column provider_paid_at timestamptz,
  add column provider_verified_at timestamptz;

alter table public.outing_payment_intents
  add constraint outing_payment_intents_provider_transaction_id_check
    check (
      provider_transaction_id is null
      or char_length(
        provider_transaction_id
      ) between 1 and 100
    ),

  add constraint outing_payment_intents_provider_channel_check
    check (
      provider_channel is null
      or char_length(
        provider_channel
      ) between 1 and 40
    );

----------------------------------------------------------------------
-- A PROVIDER TRANSACTION MAY ONLY SETTLE ONE MOVA PAYMENT INTENT
----------------------------------------------------------------------

create unique index
  outing_payment_intents_provider_transaction_idx
on public.outing_payment_intents (
  provider,
  provider_transaction_id
)
where provider is not null
  and provider_transaction_id is not null;

----------------------------------------------------------------------
-- PROVIDER EVENT AUDIT
--
-- We deliberately do not store the complete webhook payload.
--
-- The full Paystack webhook may contain provider/customer information
-- that MOVA does not need to retain.
--
-- Instead we store:
--
--   - provider
--   - event type
--   - provider reference
--   - provider transaction ID
--   - SHA-256 hash of the received webhook body
--
-- This gives us an audit trail and lets webhook retries be processed
-- idempotently.
----------------------------------------------------------------------

create table public.outing_payment_provider_events (
  id uuid primary key
    default gen_random_uuid(),

  payment_intent_id uuid not null
    references public.outing_payment_intents(id)
    on delete cascade,

  provider text not null,

  event_type text not null,

  provider_reference text not null,

  provider_transaction_id text,

  payload_hash text not null,

  received_at timestamptz not null
    default now(),

  constraint outing_payment_provider_events_provider_check
    check (
      char_length(
        provider
      ) between 2 and 40
    ),

  constraint outing_payment_provider_events_event_type_check
    check (
      char_length(
        event_type
      ) between 2 and 80
    ),

  constraint outing_payment_provider_events_reference_check
    check (
      char_length(
        provider_reference
      ) between 1 and 200
    ),

  constraint outing_payment_provider_events_transaction_check
    check (
      provider_transaction_id is null
      or char_length(
        provider_transaction_id
      ) between 1 and 100
    ),

  constraint outing_payment_provider_events_payload_hash_check
    check (
      payload_hash ~
        '^[0-9a-f]{64}$'
    ),

  constraint outing_payment_provider_events_dedupe
    unique (
      provider,
      payload_hash
    )
);

create index
  outing_payment_provider_events_intent_idx
on public.outing_payment_provider_events (
  payment_intent_id,
  received_at desc
);

----------------------------------------------------------------------
-- COMPLETE PAYMENT FROM VERIFIED PROVIDER TRANSACTION
--
-- IMPORTANT:
--
-- This function does NOT verify Paystack itself.
--
-- The Nest backend must verify the webhook and transaction with
-- Paystack before calling this function.
--
-- This function then provides a second trust boundary inside the
-- database:
--
--   - provider must be Paystack
--   - event must be charge.success
--   - MOVA reference must already exist
--   - verified amount must exactly match
--   - verified currency must exactly match
--   - provider transaction ID cannot settle another intent
--   - only an active checkout can complete automatically
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

  if not found then
    return jsonb_build_object(
      'status',
      'not_found'
    );
  end if;

  --------------------------------------------------------------------
  -- RECORD PROVIDER EVENT
  --
  -- Repeated delivery of the exact same webhook body will have the same
  -- payload hash.
  --
  -- ON CONFLICT therefore makes webhook retries idempotent.
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
  -- VERIFIED AMOUNT AND CURRENCY MUST MATCH MOVA
  --------------------------------------------------------------------

  if intent_row.amount_minor <>
      p_amount_minor
    or intent_row.currency <>
      cleaned_currency
  then
    return jsonb_build_object(
      'status',
      'mismatch',
      'intentId',
      intent_row.id
    );
  end if;

  --------------------------------------------------------------------
  -- COMPLETED PAYMENT RETRY
  --
  -- Paystack can retry webhooks.
  --
  -- If this exact provider transaction already completed the payment,
  -- return success-like state without changing anything again.
  --------------------------------------------------------------------

  if intent_row.status =
      'completed'
  then
    if intent_row.provider_transaction_id =
        cleaned_transaction_id
      and intent_row.provider_reference =
        cleaned_reference
    then
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
  -- ONE PROVIDER TRANSACTION CANNOT SETTLE TWO MOVA INTENTS
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
  ) then
    return jsonb_build_object(
      'status',
      'conflict',
      'intentId',
      intent_row.id
    );
  end if;

  --------------------------------------------------------------------
  -- ONLY A LIVE MOVA CHECKOUT MAY AUTOMATICALLY SETTLE
  --
  -- If Paystack reports payment for a cancelled, expired or failed
  -- intent, MOVA must not silently turn it into a successful payment.
  --
  -- That case will later enter reconciliation handling.
  --------------------------------------------------------------------

  if intent_row.status not in (
    'checkout_ready',
    'processing'
  )
  then
    return jsonb_build_object(
      'status',
      'reconciliation_required',
      'intentId',
      intent_row.id,
      'paymentStatus',
      intent_row.status
    );
  end if;

  --------------------------------------------------------------------
  -- COMPLETE PAYMENT
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
    'currency',
    intent_row.currency
  );
end;
$$;

----------------------------------------------------------------------
-- BACKEND-ONLY ACCESS
----------------------------------------------------------------------

alter table public.outing_payment_provider_events
  enable row level security;

revoke all
  on table public.outing_payment_provider_events
  from public, anon, authenticated;

grant select, insert
  on table public.outing_payment_provider_events
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

commit;