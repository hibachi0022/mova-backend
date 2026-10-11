begin;

----------------------------------------------------------------------
-- FRIEND TRANSFERS / REIMBURSEMENTS FOUNDATION
--
-- Flow:
--
--   sender chooses an accepted friend
--   -> MOVA creates a short-lived trusted quote
--   -> quote binds the sender's saved payment method
--   -> quote binds the recipient's current default receiving account
--   -> sender payment is prepared idempotently
--   -> saved card is charged
--   -> provider payment is independently verified
--   -> only then is one payout created
--   -> payout uses the already-bound receiving account
--
-- Security principles:
--
--   - sender and recipient must be accepted friends
--   - either-direction blocking prevents a new quote/payment
--   - sender cannot send to self
--   - sender cannot supply a provider authorization code
--   - recipient cannot supply a provider recipient_code
--   - payment method must belong to the sender
--   - receiving account must belong to the recipient
--   - financial terms are copied into immutable payment/payout records
--   - provider charge settlement is independently verified
--   - payout begins only after verified payment settlement
--   - one completed payment exists per quote
--   - one payout exists per completed payment
--   - provider events are retained for audit/reconciliation
--
-- Initial pricing policy:
--
--   fee_minor = 0
--
-- Paystack transfer fees, if any, are therefore not passed through to
-- the MOVA user by this schema yet.
----------------------------------------------------------------------

----------------------------------------------------------------------
-- FRIEND TRANSFER QUOTES
----------------------------------------------------------------------

create table public.friend_transfer_quotes (
  id uuid primary key
    default gen_random_uuid(),

  sender_user_id uuid not null
    references public.profiles(user_id)
    on delete cascade,

  recipient_user_id uuid not null
    references public.profiles(user_id)
    on delete cascade,

  payment_method_id uuid not null
    references public.payment_methods(id)
    on delete cascade,

  receiving_account_id uuid not null
    references public.receiving_accounts(id)
    on delete cascade,

  amount_minor bigint not null,

  fee_minor bigint not null
    default 0,

  total_minor bigint not null,

  currency text not null
    default 'NGN',

  status text not null
    default 'active',

  expires_at timestamptz not null
    default (
      now() +
      interval '10 minutes'
    ),

  consumed_at timestamptz,

  created_at timestamptz not null
    default now(),

  updated_at timestamptz not null
    default now(),

  constraint friend_transfer_quotes_not_self_check
    check (
      sender_user_id <>
        recipient_user_id
    ),

  constraint friend_transfer_quotes_amount_check
    check (
      amount_minor > 0
      and amount_minor <=
        9007199254740991
    ),

  constraint friend_transfer_quotes_fee_check
    check (
      fee_minor >= 0
      and fee_minor <=
        9007199254740991
    ),

  constraint friend_transfer_quotes_total_check
    check (
      total_minor =
        amount_minor +
        fee_minor
      and total_minor > 0
      and total_minor <=
        9007199254740991
    ),

  constraint friend_transfer_quotes_currency_check
    check (
      currency =
        'NGN'
    ),

  constraint friend_transfer_quotes_status_check
    check (
      status in (
        'active',
        'consumed',
        'expired',
        'cancelled'
      )
    ),

  constraint friend_transfer_quotes_consumed_check
    check (
      (
        status =
          'consumed'
        and consumed_at
          is not null
      )
      or
      (
        status <>
          'consumed'
        and consumed_at
          is null
      )
    )
);

create index
  friend_transfer_quotes_sender_created_idx
on public.friend_transfer_quotes (
  sender_user_id,
  created_at desc
);

create index
  friend_transfer_quotes_recipient_created_idx
on public.friend_transfer_quotes (
  recipient_user_id,
  created_at desc
);

create index
  friend_transfer_quotes_expiry_idx
on public.friend_transfer_quotes (
  expires_at
)
where status =
  'active';

----------------------------------------------------------------------
-- FRIEND TRANSFER PAYMENT INTENTS
--
-- This represents the sender-side charge.
--
-- The sender is charged charge_amount_minor.
--
-- principal_amount_minor is the amount that should ultimately be paid
-- to the recipient.
----------------------------------------------------------------------

create table public.friend_transfer_payment_intents (
  id uuid primary key
    default gen_random_uuid(),

  quote_id uuid not null
    references public.friend_transfer_quotes(id)
    on delete cascade,

  sender_user_id uuid not null
    references public.profiles(user_id)
    on delete cascade,

  recipient_user_id uuid not null
    references public.profiles(user_id)
    on delete cascade,

  payment_method_id uuid not null
    references public.payment_methods(id)
    on delete cascade,

  receiving_account_id uuid not null
    references public.receiving_accounts(id)
    on delete cascade,

  principal_amount_minor bigint not null,

  fee_amount_minor bigint not null,

  charge_amount_minor bigint not null,

  currency text not null,

  status text not null
    default 'created',

  idempotency_key_hash text not null,

  provider text,

  provider_reference text,

  provider_transaction_id text,

  provider_amount_minor bigint,

  provider_currency text,

  provider_channel text,

  provider_paid_at timestamptz,

  provider_verified_at timestamptz,

  completed_at timestamptz,

  failure_reason text,

  reconciliation_state text not null
    default 'none',

  reconciliation_reason text,

  reconciliation_resolution text,

  reconciliation_required_at timestamptz,

  reconciliation_resolved_at timestamptz,

  reconciliation_note text,

  created_at timestamptz not null
    default now(),

  updated_at timestamptz not null
    default now(),

  constraint friend_transfer_payment_principal_check
    check (
      principal_amount_minor > 0
      and principal_amount_minor <=
        9007199254740991
    ),

  constraint friend_transfer_payment_fee_check
    check (
      fee_amount_minor >= 0
      and fee_amount_minor <=
        9007199254740991
    ),

  constraint friend_transfer_payment_charge_check
    check (
      charge_amount_minor =
        principal_amount_minor +
        fee_amount_minor
      and charge_amount_minor > 0
      and charge_amount_minor <=
        9007199254740991
    ),

  constraint friend_transfer_payment_currency_check
    check (
      currency =
        'NGN'
    ),

  constraint friend_transfer_payment_status_check
    check (
      status in (
        'created',
        'processing',
        'completed',
        'failed',
        'expired',
        'cancelled'
      )
    ),

  constraint friend_transfer_payment_idempotency_check
    check (
      idempotency_key_hash ~
        '^[0-9a-f]{64}$'
    ),

  constraint friend_transfer_payment_provider_check
    check (
      provider is null
      or provider =
        'paystack'
    ),

  constraint friend_transfer_payment_reference_check
    check (
      provider_reference is null
      or char_length(
        provider_reference
      ) between 8 and 200
    ),

  constraint friend_transfer_payment_transaction_check
    check (
      provider_transaction_id is null
      or char_length(
        provider_transaction_id
      ) between 1 and 100
    ),

  constraint friend_transfer_payment_provider_amount_check
    check (
      provider_amount_minor is null
      or (
        provider_amount_minor > 0
        and provider_amount_minor <=
          9007199254740991
      )
    ),

  constraint friend_transfer_payment_provider_currency_check
    check (
      provider_currency is null
      or provider_currency ~
        '^[A-Z]{3}$'
    ),

  constraint friend_transfer_payment_provider_channel_check
    check (
      provider_channel is null
      or char_length(
        provider_channel
      ) between 1 and 40
    ),

  constraint friend_transfer_payment_failure_reason_check
    check (
      failure_reason is null
      or char_length(
        failure_reason
      ) between 1 and 300
    ),

  constraint friend_transfer_payment_completed_check
    check (
      (
        status =
          'completed'
        and completed_at
          is not null
      )
      or
      (
        status <>
          'completed'
        and completed_at
          is null
      )
    ),

  constraint friend_transfer_payment_reconciliation_state_check
    check (
      reconciliation_state in (
        'none',
        'required',
        'resolved'
      )
    ),

  constraint friend_transfer_payment_reconciliation_check
    check (
      (
        reconciliation_state =
          'none'
        and reconciliation_reason
          is null
        and reconciliation_resolution
          is null
        and reconciliation_required_at
          is null
        and reconciliation_resolved_at
          is null
        and reconciliation_note
          is null
      )
      or
      (
        reconciliation_state =
          'required'
        and reconciliation_reason
          is not null
        and reconciliation_required_at
          is not null
        and reconciliation_resolution
          is null
        and reconciliation_resolved_at
          is null
        and reconciliation_note
          is null
      )
      or
      (
        reconciliation_state =
          'resolved'
        and reconciliation_reason
          is not null
        and reconciliation_resolution
          is not null
        and reconciliation_required_at
          is not null
        and reconciliation_resolved_at
          is not null
        and reconciliation_note
          is not null
      )
    )
);

----------------------------------------------------------------------
-- PAYMENT UNIQUENESS / IDEMPOTENCY
----------------------------------------------------------------------

create unique index
  friend_transfer_payment_idempotency_idx
on public.friend_transfer_payment_intents (
  sender_user_id,
  quote_id,
  idempotency_key_hash
);

create unique index
  friend_transfer_payment_provider_reference_idx
on public.friend_transfer_payment_intents (
  provider,
  provider_reference
)
where provider is not null
  and provider_reference
    is not null;

create unique index
  friend_transfer_payment_provider_transaction_idx
on public.friend_transfer_payment_intents (
  provider,
  provider_transaction_id
)
where provider is not null
  and provider_transaction_id
    is not null;

----------------------------------------------------------------------
-- ONE COMPLETED PAYMENT PER QUOTE
----------------------------------------------------------------------

create unique index
  friend_transfer_payment_completed_quote_idx
on public.friend_transfer_payment_intents (
  quote_id
)
where status =
  'completed';

----------------------------------------------------------------------
-- ONLY ONE LIVE PAYMENT ATTEMPT PER QUOTE
----------------------------------------------------------------------

create unique index
  friend_transfer_payment_active_quote_idx
on public.friend_transfer_payment_intents (
  quote_id
)
where status in (
  'created',
  'processing'
);

create index
  friend_transfer_payment_sender_created_idx
on public.friend_transfer_payment_intents (
  sender_user_id,
  created_at desc
);

create index
  friend_transfer_payment_recipient_created_idx
on public.friend_transfer_payment_intents (
  recipient_user_id,
  created_at desc
);

create index
  friend_transfer_payment_reconciliation_idx
on public.friend_transfer_payment_intents (
  reconciliation_required_at desc
)
where reconciliation_state =
  'required';

----------------------------------------------------------------------
-- FRIEND TRANSFER PAYOUTS
--
-- Created only after a sender charge has been independently verified.
--
-- The provider recipient code remains in receiving_accounts and is
-- exposed only to the backend when a payout begins.
----------------------------------------------------------------------

create table public.friend_transfer_payouts (
  id uuid primary key
    default gen_random_uuid(),

  payment_intent_id uuid not null
    references public.friend_transfer_payment_intents(id)
    on delete cascade,

  quote_id uuid not null
    references public.friend_transfer_quotes(id)
    on delete cascade,

  sender_user_id uuid not null
    references public.profiles(user_id)
    on delete cascade,

  recipient_user_id uuid not null
    references public.profiles(user_id)
    on delete cascade,

  receiving_account_id uuid not null
    references public.receiving_accounts(id)
    on delete cascade,

  amount_minor bigint not null,

  currency text not null,

  status text not null
    default 'created',

  provider text not null
    default 'paystack',

  provider_reference text,

  provider_transfer_code text,

  provider_transfer_id text,

  provider_status text,

  initiated_at timestamptz,

  completed_at timestamptz,

  failed_at timestamptz,

  reversed_at timestamptz,

  failure_reason text,

  created_at timestamptz not null
    default now(),

  updated_at timestamptz not null
    default now(),

  constraint friend_transfer_payout_amount_check
    check (
      amount_minor > 0
      and amount_minor <=
        9007199254740991
    ),

  constraint friend_transfer_payout_currency_check
    check (
      currency =
        'NGN'
    ),

  constraint friend_transfer_payout_status_check
    check (
      status in (
        'created',
        'initiating',
        'pending',
        'success',
        'failed',
        'reversed',
        'otp_required',
        'blocked',
        'abandoned',
        'rejected',
        'reconciliation_required'
      )
    ),

  constraint friend_transfer_payout_provider_check
    check (
      provider =
        'paystack'
    ),

  constraint friend_transfer_payout_reference_check
    check (
      provider_reference is null
      or (
        char_length(
          provider_reference
        ) between 16 and 50
        and provider_reference ~
          '^[a-z0-9_-]+$'
      )
    ),

  constraint friend_transfer_payout_transfer_code_check
    check (
      provider_transfer_code is null
      or char_length(
        provider_transfer_code
      ) between 3 and 100
    ),

  constraint friend_transfer_payout_transfer_id_check
    check (
      provider_transfer_id is null
      or char_length(
        provider_transfer_id
      ) between 1 and 100
    ),

  constraint friend_transfer_payout_provider_status_check
    check (
      provider_status is null
      or char_length(
        provider_status
      ) between 1 and 50
    ),

  constraint friend_transfer_payout_failure_reason_check
    check (
      failure_reason is null
      or char_length(
        failure_reason
      ) between 1 and 500
    )
);

----------------------------------------------------------------------
-- EXACTLY ONE PAYOUT PER SUCCESSFULLY FUNDED PAYMENT
----------------------------------------------------------------------

create unique index
  friend_transfer_payout_payment_idx
on public.friend_transfer_payouts (
  payment_intent_id
);

create unique index
  friend_transfer_payout_provider_reference_idx
on public.friend_transfer_payouts (
  provider,
  provider_reference
)
where provider_reference
  is not null;

create unique index
  friend_transfer_payout_provider_code_idx
on public.friend_transfer_payouts (
  provider,
  provider_transfer_code
)
where provider_transfer_code
  is not null;

create unique index
  friend_transfer_payout_provider_id_idx
on public.friend_transfer_payouts (
  provider,
  provider_transfer_id
)
where provider_transfer_id
  is not null;

create index
  friend_transfer_payout_recipient_created_idx
on public.friend_transfer_payouts (
  recipient_user_id,
  created_at desc
);

create index
  friend_transfer_payout_status_idx
on public.friend_transfer_payouts (
  status,
  created_at
);

----------------------------------------------------------------------
-- PROVIDER EVENT AUDIT
--
-- Financial details in webhook payloads are not trusted directly.
-- They are recorded only as hashes/identifiers here after signature
-- verification and provider-side verification by the backend.
----------------------------------------------------------------------

create table public.friend_transfer_provider_events (
  id uuid primary key
    default gen_random_uuid(),

  payment_intent_id uuid
    references public.friend_transfer_payment_intents(id)
    on delete cascade,

  payout_id uuid
    references public.friend_transfer_payouts(id)
    on delete cascade,

  provider text not null,

  event_type text not null,

  provider_reference text not null,

  provider_object_id text,

  payload_hash text not null,

  created_at timestamptz not null
    default now(),

  constraint friend_transfer_events_target_check
    check (
      (
        case
          when payment_intent_id
            is not null
          then 1
          else 0
        end
        +
        case
          when payout_id
            is not null
          then 1
          else 0
        end
      ) = 1
    ),

  constraint friend_transfer_events_provider_check
    check (
      provider =
        'paystack'
    ),

  constraint friend_transfer_events_type_check
    check (
      char_length(
        event_type
      ) between 3 and 100
    ),

  constraint friend_transfer_events_reference_check
    check (
      char_length(
        provider_reference
      ) between 8 and 200
    ),

  constraint friend_transfer_events_object_id_check
    check (
      provider_object_id is null
      or char_length(
        provider_object_id
      ) between 1 and 100
    ),

  constraint friend_transfer_events_payload_hash_check
    check (
      payload_hash ~
        '^[0-9a-f]{64}$'
    )
);

create unique index
  friend_transfer_events_payload_idx
on public.friend_transfer_provider_events (
  provider,
  payload_hash
);

create index
  friend_transfer_events_payment_idx
on public.friend_transfer_provider_events (
  payment_intent_id,
  created_at desc
)
where payment_intent_id
  is not null;

create index
  friend_transfer_events_payout_idx
on public.friend_transfer_provider_events (
  payout_id,
  created_at desc
)
where payout_id
  is not null;

----------------------------------------------------------------------
-- UPDATED_AT TRIGGERS
----------------------------------------------------------------------

create or replace function
  public.touch_friend_transfer_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at :=
    now();

  return new;
end;
$$;

revoke all
  on function
    public.touch_friend_transfer_updated_at()
  from public, anon, authenticated;

create trigger
  friend_transfer_quotes_updated_at
before update
on public.friend_transfer_quotes
for each row
execute function
  public.touch_friend_transfer_updated_at();

create trigger
  friend_transfer_payment_intents_updated_at
before update
on public.friend_transfer_payment_intents
for each row
execute function
  public.touch_friend_transfer_updated_at();

create trigger
  friend_transfer_payouts_updated_at
before update
on public.friend_transfer_payouts
for each row
execute function
  public.touch_friend_transfer_updated_at();

----------------------------------------------------------------------
-- PREPARE FRIEND TRANSFER QUOTE
--
-- The mobile client supplies:
--
--   recipient MOVA user ID
--   MOVA payment-method ID
--   desired amount
--   NGN
--
-- MOVA resolves the recipient's default receiving account itself.
--
-- fee_minor is intentionally zero in the first pricing policy.
----------------------------------------------------------------------

create or replace function
  public.prepare_friend_transfer_quote(
    p_sender_user_id uuid,
    p_recipient_user_id uuid,
    p_payment_method_id uuid,
    p_amount_minor bigint,
    p_currency text
  )
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  cleaned_currency text;

  payment_method_row
    public.payment_methods%rowtype;

  receiving_account_row
    public.receiving_accounts%rowtype;

  quote_id uuid;

  quote_expires_at
    timestamptz;

  fee_value bigint :=
    0;

  total_value bigint;
begin
  cleaned_currency :=
    upper(
      btrim(
        coalesce(
          p_currency,
          ''
        )
      )
    );

  if p_sender_user_id
      is null
    or p_recipient_user_id
      is null
    or p_payment_method_id
      is null
    or p_sender_user_id =
      p_recipient_user_id
    or p_amount_minor
      is null
    or p_amount_minor <=
      0
    or p_amount_minor >
      9007199254740991
    or cleaned_currency <>
      'NGN'
  then
    return jsonb_build_object(
      'status',
      'invalid'
    );
  end if;

  if not exists (
    select 1
    from public.profiles
    where user_id =
      p_sender_user_id
  )
  or not exists (
    select 1
    from public.profiles
    where user_id =
      p_recipient_user_id
  )
  then
    return jsonb_build_object(
      'status',
      'not_found'
    );
  end if;

  --------------------------------------------------------------------
  -- ACCEPTED FRIENDSHIP REQUIRED
  --------------------------------------------------------------------

  if not exists (
    select 1
    from public.friendships
    where user_a_id =
      least(
        p_sender_user_id,
        p_recipient_user_id
      )
      and user_b_id =
        greatest(
          p_sender_user_id,
          p_recipient_user_id
        )
  )
  then
    return jsonb_build_object(
      'status',
      'not_friends'
    );
  end if;

  --------------------------------------------------------------------
  -- EITHER BLOCK DIRECTION STOPS NEW MONEY ACTIVITY
  --------------------------------------------------------------------

  if exists (
    select 1
    from public.user_blocks
    where (
      blocker_id =
        p_sender_user_id
      and blocked_id =
        p_recipient_user_id
    )
    or (
      blocker_id =
        p_recipient_user_id
      and blocked_id =
        p_sender_user_id
    )
  )
  then
    return jsonb_build_object(
      'status',
      'blocked'
    );
  end if;

  --------------------------------------------------------------------
  -- PAYMENT METHOD MUST BELONG TO SENDER
  --------------------------------------------------------------------

  select *
  into payment_method_row
  from public.payment_methods
  where id =
    p_payment_method_id
    and user_id =
      p_sender_user_id
  limit 1;

  if not found then
    return jsonb_build_object(
      'status',
      'payment_method_not_found'
    );
  end if;

  if payment_method_row.disabled_at
      is not null
    or payment_method_row.reusable
      is not true
    or payment_method_row.provider <>
      'paystack'
  then
    return jsonb_build_object(
      'status',
      'payment_method_unavailable'
    );
  end if;

  if payment_method_row.exp_year <
      extract(
        year from now()
      )::integer
    or (
      payment_method_row.exp_year =
        extract(
          year from now()
        )::integer
      and payment_method_row.exp_month <
        extract(
          month from now()
        )::integer
    )
  then
    return jsonb_build_object(
      'status',
      'payment_method_expired'
    );
  end if;

  --------------------------------------------------------------------
  -- RECIPIENT MUST HAVE AN ACTIVE DEFAULT RECEIVING ACCOUNT
  --------------------------------------------------------------------

  select *
  into receiving_account_row
  from public.receiving_accounts
  where user_id =
    p_recipient_user_id
    and is_default
      is true
    and disabled_at
      is null
    and currency =
      cleaned_currency
  limit 1;

  if not found then
    return jsonb_build_object(
      'status',
      'recipient_no_receiving_account'
    );
  end if;

  fee_value :=
    0;

  total_value :=
    p_amount_minor +
    fee_value;

  quote_expires_at :=
    now() +
    interval '10 minutes';

  insert into public.friend_transfer_quotes (
    sender_user_id,
    recipient_user_id,
    payment_method_id,
    receiving_account_id,
    amount_minor,
    fee_minor,
    total_minor,
    currency,
    status,
    expires_at
  )
  values (
    p_sender_user_id,
    p_recipient_user_id,
    p_payment_method_id,
    receiving_account_row.id,
    p_amount_minor,
    fee_value,
    total_value,
    cleaned_currency,
    'active',
    quote_expires_at
  )
  returning id
  into quote_id;

  return jsonb_build_object(
    'status',
    'created',

    'quoteId',
    quote_id,

    'recipientId',
    p_recipient_user_id,

    'paymentMethodId',
    p_payment_method_id,

    'amountMinor',
    p_amount_minor,

    'feeMinor',
    fee_value,

    'totalMinor',
    total_value,

    'currency',
    cleaned_currency,

    'expiresAt',
    quote_expires_at
  );
end;
$$;

----------------------------------------------------------------------
-- PREPARE FRIEND TRANSFER PAYMENT
--
-- Re-check all relationship and financial dependencies immediately
-- before allowing a card charge.
----------------------------------------------------------------------

create or replace function
  public.prepare_friend_transfer_payment(
    p_sender_user_id uuid,
    p_quote_id uuid,
    p_idempotency_key_hash text
  )
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  quote_row
    public.friend_transfer_quotes%rowtype;

  payment_method_row
    public.payment_methods%rowtype;

  receiving_account_row
    public.receiving_accounts%rowtype;

  existing_intent
    public.friend_transfer_payment_intents%rowtype;

  active_intent_id uuid;

  intent_id uuid;
begin
  if p_sender_user_id
      is null
    or p_quote_id
      is null
    or p_idempotency_key_hash
      is null
    or p_idempotency_key_hash !~
      '^[0-9a-f]{64}$'
  then
    return jsonb_build_object(
      'status',
      'invalid'
    );
  end if;

  select *
  into quote_row
  from public.friend_transfer_quotes
  where id =
    p_quote_id
  for update;

  if not found
    or quote_row.sender_user_id <>
      p_sender_user_id
  then
    return jsonb_build_object(
      'status',
      'not_found'
    );
  end if;

  if quote_row.status =
      'consumed'
  then
    return jsonb_build_object(
      'status',
      'already_paid'
    );
  end if;

  if quote_row.status =
      'active'
    and quote_row.expires_at <=
      now()
  then
    update public.friend_transfer_quotes
    set status =
      'expired'
    where id =
      quote_row.id;

    update public.friend_transfer_payment_intents
    set status =
      'expired'
    where quote_id =
      quote_row.id
      and status =
        'created';

    return jsonb_build_object(
      'status',
      'expired'
    );
  end if;

  if quote_row.status <>
      'active'
  then
    return jsonb_build_object(
      'status',
      'not_available'
    );
  end if;

  --------------------------------------------------------------------
  -- FRIENDSHIP / BLOCK STATE MAY HAVE CHANGED AFTER QUOTE CREATION
  --------------------------------------------------------------------

  if not exists (
    select 1
    from public.friendships
    where user_a_id =
      least(
        quote_row.sender_user_id,
        quote_row.recipient_user_id
      )
      and user_b_id =
        greatest(
          quote_row.sender_user_id,
          quote_row.recipient_user_id
        )
  )
  then
    return jsonb_build_object(
      'status',
      'not_friends'
    );
  end if;

  if exists (
    select 1
    from public.user_blocks
    where (
      blocker_id =
        quote_row.sender_user_id
      and blocked_id =
        quote_row.recipient_user_id
    )
    or (
      blocker_id =
        quote_row.recipient_user_id
      and blocked_id =
        quote_row.sender_user_id
    )
  )
  then
    return jsonb_build_object(
      'status',
      'blocked'
    );
  end if;

  --------------------------------------------------------------------
  -- PAYMENT METHOD MUST STILL BE USABLE
  --------------------------------------------------------------------

  select *
  into payment_method_row
  from public.payment_methods
  where id =
    quote_row.payment_method_id
    and user_id =
      quote_row.sender_user_id
  limit 1;

  if not found then
    return jsonb_build_object(
      'status',
      'payment_method_not_found'
    );
  end if;

  if payment_method_row.disabled_at
      is not null
    or payment_method_row.reusable
      is not true
    or payment_method_row.provider <>
      'paystack'
  then
    return jsonb_build_object(
      'status',
      'payment_method_unavailable'
    );
  end if;

  if payment_method_row.exp_year <
      extract(
        year from now()
      )::integer
    or (
      payment_method_row.exp_year =
        extract(
          year from now()
        )::integer
      and payment_method_row.exp_month <
        extract(
          month from now()
        )::integer
    )
  then
    return jsonb_build_object(
      'status',
      'payment_method_expired'
    );
  end if;

  --------------------------------------------------------------------
  -- QUOTE-BOUND DESTINATION MUST STILL BE ACTIVE BEFORE CHARGING
  --------------------------------------------------------------------

  select *
  into receiving_account_row
  from public.receiving_accounts
  where id =
    quote_row.receiving_account_id
    and user_id =
      quote_row.recipient_user_id
  limit 1;

  if not found
    or receiving_account_row.disabled_at
      is not null
    or receiving_account_row.currency <>
      quote_row.currency
  then
    return jsonb_build_object(
      'status',
      'recipient_account_unavailable'
    );
  end if;

  --------------------------------------------------------------------
  -- IDEMPOTENT RETRY
  --------------------------------------------------------------------

  select *
  into existing_intent
  from public.friend_transfer_payment_intents
  where sender_user_id =
    p_sender_user_id
    and quote_id =
      p_quote_id
    and idempotency_key_hash =
      p_idempotency_key_hash
  limit 1;

  if found then
    if existing_intent.recipient_user_id <>
        quote_row.recipient_user_id
      or existing_intent.payment_method_id <>
        quote_row.payment_method_id
      or existing_intent.receiving_account_id <>
        quote_row.receiving_account_id
      or existing_intent.principal_amount_minor <>
        quote_row.amount_minor
      or existing_intent.fee_amount_minor <>
        quote_row.fee_minor
      or existing_intent.charge_amount_minor <>
        quote_row.total_minor
      or existing_intent.currency <>
        quote_row.currency
    then
      return jsonb_build_object(
        'status',
        'idempotency_conflict'
      );
    end if;

    return jsonb_build_object(
      'status',
      'existing',

      'intentId',
      existing_intent.id,

      'paymentStatus',
      existing_intent.status,

      'amountMinor',
      existing_intent.principal_amount_minor,

      'feeMinor',
      existing_intent.fee_amount_minor,

      'totalMinor',
      existing_intent.charge_amount_minor,

      'currency',
      existing_intent.currency,

      'paymentMethodId',
      existing_intent.payment_method_id
    );
  end if;

  if exists (
    select 1
    from public.friend_transfer_payment_intents
    where quote_id =
      p_quote_id
      and status =
        'completed'
  )
  then
    return jsonb_build_object(
      'status',
      'already_paid'
    );
  end if;

  if exists (
    select 1
    from public.friend_transfer_payment_intents
    where quote_id =
      p_quote_id
      and reconciliation_state =
        'required'
  )
  then
    return jsonb_build_object(
      'status',
      'reconciliation_required'
    );
  end if;

  select id
  into active_intent_id
  from public.friend_transfer_payment_intents
  where quote_id =
    p_quote_id
    and status in (
      'created',
      'processing'
    )
  order by created_at desc
  limit 1;

  if active_intent_id
      is not null
  then
    return jsonb_build_object(
      'status',
      'payment_in_progress',

      'intentId',
      active_intent_id
    );
  end if;

  insert into public.friend_transfer_payment_intents (
    quote_id,
    sender_user_id,
    recipient_user_id,
    payment_method_id,
    receiving_account_id,
    principal_amount_minor,
    fee_amount_minor,
    charge_amount_minor,
    currency,
    status,
    idempotency_key_hash
  )
  values (
    quote_row.id,
    quote_row.sender_user_id,
    quote_row.recipient_user_id,
    quote_row.payment_method_id,
    quote_row.receiving_account_id,
    quote_row.amount_minor,
    quote_row.fee_minor,
    quote_row.total_minor,
    quote_row.currency,
    'created',
    p_idempotency_key_hash
  )
  returning id
  into intent_id;

  return jsonb_build_object(
    'status',
    'created',

    'intentId',
    intent_id,

    'amountMinor',
    quote_row.amount_minor,

    'feeMinor',
    quote_row.fee_minor,

    'totalMinor',
    quote_row.total_minor,

    'currency',
    quote_row.currency,

    'paymentMethodId',
    quote_row.payment_method_id
  );
end;
$$;

----------------------------------------------------------------------
-- BEGIN SAVED-CARD CHARGE
--
-- Provider reference is persisted before Paystack is contacted.
----------------------------------------------------------------------

create or replace function
  public.begin_friend_transfer_saved_card_charge(
    p_sender_user_id uuid,
    p_intent_id uuid,
    p_provider_reference text
  )
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  intent_row
    public.friend_transfer_payment_intents%rowtype;

  quote_row
    public.friend_transfer_quotes%rowtype;

  payment_method_row
    public.payment_methods%rowtype;

  receiving_account_row
    public.receiving_accounts%rowtype;

  cleaned_reference text;
begin
  cleaned_reference :=
    lower(
      btrim(
        coalesce(
          p_provider_reference,
          ''
        )
      )
    );

  if p_sender_user_id
      is null
    or p_intent_id
      is null
    or cleaned_reference !~
      '^mova-ft-[0-9a-f]{32}$'
  then
    return jsonb_build_object(
      'status',
      'invalid'
    );
  end if;

  select *
  into intent_row
  from public.friend_transfer_payment_intents
  where id =
    p_intent_id
  for update;

  if not found
    or intent_row.sender_user_id <>
      p_sender_user_id
  then
    return jsonb_build_object(
      'status',
      'not_found'
    );
  end if;

  if intent_row.status =
      'completed'
  then
    return jsonb_build_object(
      'status',
      'already_completed',

      'intentId',
      intent_row.id
    );
  end if;

  if intent_row.status =
      'processing'
  then
    if intent_row.provider =
        'paystack'
      and intent_row.provider_reference =
        cleaned_reference
    then
      return jsonb_build_object(
        'status',
        'existing',

        'intentId',
        intent_row.id,

        'amountMinor',
        intent_row.principal_amount_minor,

        'feeMinor',
        intent_row.fee_amount_minor,

        'totalMinor',
        intent_row.charge_amount_minor,

        'currency',
        intent_row.currency,

        'paymentMethodId',
        intent_row.payment_method_id
      );
    end if;

    return jsonb_build_object(
      'status',
      'conflict'
    );
  end if;

  if intent_row.status <>
      'created'
    or intent_row.reconciliation_state <>
      'none'
  then
    return jsonb_build_object(
      'status',
      'not_available'
    );
  end if;

  select *
  into quote_row
  from public.friend_transfer_quotes
  where id =
    intent_row.quote_id
  for update;

  if not found then
    return jsonb_build_object(
      'status',
      'not_found'
    );
  end if;

  if quote_row.status <>
      'active'
    or quote_row.expires_at <=
      now()
  then
    if quote_row.status =
        'active'
      and quote_row.expires_at <=
        now()
    then
      update public.friend_transfer_quotes
      set status =
        'expired'
      where id =
        quote_row.id;
    end if;

    update public.friend_transfer_payment_intents
    set status =
      'expired'
    where id =
      intent_row.id;

    return jsonb_build_object(
      'status',
      'expired'
    );
  end if;

  select *
  into payment_method_row
  from public.payment_methods
  where id =
    intent_row.payment_method_id
    and user_id =
      intent_row.sender_user_id
  limit 1;

  if not found then
    return jsonb_build_object(
      'status',
      'payment_method_not_found'
    );
  end if;

  if payment_method_row.disabled_at
      is not null
    or payment_method_row.reusable
      is not true
    or payment_method_row.provider <>
      'paystack'
  then
    return jsonb_build_object(
      'status',
      'payment_method_unavailable'
    );
  end if;

  select *
  into receiving_account_row
  from public.receiving_accounts
  where id =
    intent_row.receiving_account_id
    and user_id =
      intent_row.recipient_user_id
  limit 1;

  if not found
    or receiving_account_row.disabled_at
      is not null
  then
    return jsonb_build_object(
      'status',
      'recipient_account_unavailable'
    );
  end if;

  update public.friend_transfer_payment_intents
  set
    status =
      'processing',

    provider =
      'paystack',

    provider_reference =
      cleaned_reference
  where id =
    intent_row.id;

  return jsonb_build_object(
    'status',
    'ready',

    'intentId',
    intent_row.id,

    'amountMinor',
    intent_row.principal_amount_minor,

    'feeMinor',
    intent_row.fee_amount_minor,

    'totalMinor',
    intent_row.charge_amount_minor,

    'currency',
    intent_row.currency,

    'paymentMethodId',
    intent_row.payment_method_id,

    'providerReference',
    cleaned_reference
  );
end;
$$;

----------------------------------------------------------------------
-- DEFINITE SAVED-CARD FAILURE
--
-- Do not call this for a network timeout or uncertain provider result.
-- Uncertain results remain processing until provider verification.
----------------------------------------------------------------------

create or replace function
  public.fail_friend_transfer_payment(
    p_sender_user_id uuid,
    p_intent_id uuid,
    p_provider_reference text,
    p_reason text
  )
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  intent_row
    public.friend_transfer_payment_intents%rowtype;

  cleaned_reference text;

  cleaned_reason text;
begin
  cleaned_reference :=
    lower(
      btrim(
        coalesce(
          p_provider_reference,
          ''
        )
      )
    );

  cleaned_reason :=
    btrim(
      coalesce(
        p_reason,
        ''
      )
    );

  if p_sender_user_id
      is null
    or p_intent_id
      is null
    or cleaned_reference !~
      '^mova-ft-[0-9a-f]{32}$'
    or char_length(
      cleaned_reason
    ) not between 1 and 300
  then
    return jsonb_build_object(
      'status',
      'invalid'
    );
  end if;

  select *
  into intent_row
  from public.friend_transfer_payment_intents
  where id =
    p_intent_id
  for update;

  if not found
    or intent_row.sender_user_id <>
      p_sender_user_id
  then
    return jsonb_build_object(
      'status',
      'not_found'
    );
  end if;

  if intent_row.status =
      'completed'
  then
    return jsonb_build_object(
      'status',
      'already_completed'
    );
  end if;

  if intent_row.status =
      'failed'
  then
    return jsonb_build_object(
      'status',
      'existing'
    );
  end if;

  if intent_row.status <>
      'processing'
    or intent_row.provider <>
      'paystack'
    or intent_row.provider_reference <>
      cleaned_reference
  then
    return jsonb_build_object(
      'status',
      'conflict'
    );
  end if;

  update public.friend_transfer_payment_intents
  set
    status =
      'failed',

    failure_reason =
      cleaned_reason
  where id =
    intent_row.id;

  return jsonb_build_object(
    'status',
    'failed',

    'intentId',
    intent_row.id
  );
end;
$$;

----------------------------------------------------------------------
-- VERIFIED SENDER PAYMENT COMPLETION
--
-- Called only after:
--
--   1. Paystack webhook signature has been verified
--   2. transaction has independently been fetched from Paystack
--   3. provider transaction status is confirmed successful
--
-- A successful settlement atomically creates exactly one payout.
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
    btrim(
      coalesce(
        p_event_type,
        ''
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
  -- IDEMPOTENT COMPLETED PAYMENT
  --------------------------------------------------------------------

  if intent_row.status =
      'completed'
  then
    if intent_row.provider_transaction_id =
        cleaned_transaction_id
      and intent_row.provider_amount_minor =
        p_amount_minor
      and intent_row.provider_currency =
        cleaned_currency
    then
      select id
      into payout_id
      from public.friend_transfer_payouts
      where payment_intent_id =
        intent_row.id
      limit 1;

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
  -- SAME PROVIDER TRANSACTION CANNOT FUND TWO MOVA TRANSFERS
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

  --------------------------------------------------------------------
  -- AMOUNT / CURRENCY MISMATCH
  --------------------------------------------------------------------

  if intent_row.charge_amount_minor <>
      p_amount_minor
    or intent_row.currency <>
      cleaned_currency
  then
    update public.friend_transfer_payment_intents
    set
      provider_transaction_id =
        cleaned_transaction_id,

      provider_amount_minor =
        p_amount_minor,

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
  -- NORMAL PAYMENT COMPLETION
  --------------------------------------------------------------------

  update public.friend_transfer_payment_intents
  set
    status =
      'completed',

    provider_transaction_id =
      cleaned_transaction_id,

    provider_amount_minor =
      p_amount_minor,

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

    'currency',
    intent_row.currency,

    'payoutId',
    payout_id
  );
end;
$$;

----------------------------------------------------------------------
-- BEGIN RECIPIENT PAYOUT
--
-- Important:
--
-- Once the sender has been successfully charged, the receiving-account
-- destination is treated as bound to that transfer.
--
-- A later soft-disable by the recipient must not silently redirect the
-- already-funded transfer to another bank account.
----------------------------------------------------------------------

create or replace function
  public.begin_friend_transfer_payout(
    p_payout_id uuid,
    p_provider_reference text
  )
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  payout_row
    public.friend_transfer_payouts%rowtype;

  receiving_account_row
    public.receiving_accounts%rowtype;

  cleaned_reference text;
begin
  cleaned_reference :=
    lower(
      btrim(
        coalesce(
          p_provider_reference,
          ''
        )
      )
    );

  if p_payout_id
      is null
    or cleaned_reference !~
      '^mova-po-[0-9a-f]{32}$'
  then
    return jsonb_build_object(
      'status',
      'invalid'
    );
  end if;

  select *
  into payout_row
  from public.friend_transfer_payouts
  where id =
    p_payout_id
  for update;

  if not found then
    return jsonb_build_object(
      'status',
      'not_found'
    );
  end if;

  if payout_row.status =
      'success'
  then
    return jsonb_build_object(
      'status',
      'already_completed',

      'payoutId',
      payout_row.id
    );
  end if;

  if payout_row.status in (
    'initiating',
    'pending',
    'otp_required'
  )
  then
    if payout_row.provider_reference =
        cleaned_reference
    then
      select *
      into receiving_account_row
      from public.receiving_accounts
      where id =
        payout_row.receiving_account_id
      limit 1;

      if not found then
        return jsonb_build_object(
          'status',
          'recipient_account_not_found'
        );
      end if;

      return jsonb_build_object(
        'status',
        'existing',

        'payoutId',
        payout_row.id,

        'amountMinor',
        payout_row.amount_minor,

        'currency',
        payout_row.currency,

        'providerReference',
        payout_row.provider_reference,

        'providerRecipientCode',
        receiving_account_row
          .provider_recipient_code
      );
    end if;

    return jsonb_build_object(
      'status',
      'conflict'
    );
  end if;

  if payout_row.status <>
      'created'
  then
    return jsonb_build_object(
      'status',
      'not_available'
    );
  end if;

  select *
  into receiving_account_row
  from public.receiving_accounts
  where id =
    payout_row.receiving_account_id
    and user_id =
      payout_row.recipient_user_id
  limit 1;

  if not found then
    return jsonb_build_object(
      'status',
      'recipient_account_not_found'
    );
  end if;

  if receiving_account_row.currency <>
      payout_row.currency
  then
    return jsonb_build_object(
      'status',
      'recipient_account_mismatch'
    );
  end if;

  update public.friend_transfer_payouts
  set
    status =
      'initiating',

    provider_reference =
      cleaned_reference,

    initiated_at =
      now()
  where id =
    payout_row.id;

  return jsonb_build_object(
    'status',
    'ready',

    'payoutId',
    payout_row.id,

    'amountMinor',
    payout_row.amount_minor,

    'currency',
    payout_row.currency,

    'providerReference',
    cleaned_reference,

    'providerRecipientCode',
    receiving_account_row
      .provider_recipient_code
  );
end;
$$;

----------------------------------------------------------------------
-- RECORD PAYSTACK TRANSFER INITIATION RESPONSE
--
-- Even if Paystack's immediate response says "success", MOVA does not
-- treat payout as final here.
--
-- The transfer is finalized only after independent provider verification.
----------------------------------------------------------------------

create or replace function
  public.record_friend_transfer_payout_initiation(
    p_payout_id uuid,
    p_provider_reference text,
    p_provider_transfer_code text,
    p_provider_transfer_id text,
    p_provider_status text
  )
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  payout_row
    public.friend_transfer_payouts%rowtype;

  cleaned_reference text;

  cleaned_transfer_code text;

  cleaned_transfer_id text;

  cleaned_status text;

  next_status text;
begin
  cleaned_reference :=
    lower(
      btrim(
        coalesce(
          p_provider_reference,
          ''
        )
      )
    );

  cleaned_transfer_code :=
    btrim(
      coalesce(
        p_provider_transfer_code,
        ''
      )
    );

  cleaned_transfer_id :=
    btrim(
      coalesce(
        p_provider_transfer_id,
        ''
      )
    );

  cleaned_status :=
    lower(
      btrim(
        coalesce(
          p_provider_status,
          ''
        )
      )
    );

  if p_payout_id
      is null
    or cleaned_reference !~
      '^mova-po-[0-9a-f]{32}$'
    or char_length(
      cleaned_transfer_code
    ) not between 3 and 100
    or char_length(
      cleaned_transfer_id
    ) not between 1 and 100
    or cleaned_status not in (
      'pending',
      'success',
      'failed',
      'reversed',
      'otp',
      'blocked',
      'abandoned',
      'rejected'
    )
  then
    return jsonb_build_object(
      'status',
      'invalid'
    );
  end if;

  select *
  into payout_row
  from public.friend_transfer_payouts
  where id =
    p_payout_id
  for update;

  if not found then
    return jsonb_build_object(
      'status',
      'not_found'
    );
  end if;

  if payout_row.provider_reference <>
      cleaned_reference
  then
    return jsonb_build_object(
      'status',
      'conflict'
    );
  end if;

  if payout_row.status =
      'success'
  then
    return jsonb_build_object(
      'status',
      'already_completed'
    );
  end if;

  if payout_row.status not in (
    'initiating',
    'pending',
    'otp_required'
  )
  then
    return jsonb_build_object(
      'status',
      'not_available'
    );
  end if;

  if payout_row.provider_transfer_code
      is not null
    and payout_row.provider_transfer_code <>
      cleaned_transfer_code
  then
    return jsonb_build_object(
      'status',
      'conflict'
    );
  end if;

  if payout_row.provider_transfer_id
      is not null
    and payout_row.provider_transfer_id <>
      cleaned_transfer_id
  then
    return jsonb_build_object(
      'status',
      'conflict'
    );
  end if;

  next_status :=
    case cleaned_status
      when 'otp'
        then 'otp_required'

      else 'pending'
    end;

  update public.friend_transfer_payouts
  set
    status =
      next_status,

    provider_transfer_code =
      cleaned_transfer_code,

    provider_transfer_id =
      cleaned_transfer_id,

    provider_status =
      cleaned_status
  where id =
    payout_row.id;

  return jsonb_build_object(
    'status',
    'recorded',

    'payoutId',
    payout_row.id,

    'payoutStatus',
    next_status,

    'providerStatus',
    cleaned_status
  );
end;
$$;

----------------------------------------------------------------------
-- VERIFIED PAYOUT COMPLETION
--
-- Called only after:
--
--   1. webhook signature verification
--   2. independent Paystack transfer verification
--
-- Supported conclusive provider states:
--
--   success
--   failed
--   reversed
----------------------------------------------------------------------

create or replace function
  public.complete_friend_transfer_payout_from_provider(
    p_provider text,
    p_event_type text,
    p_provider_reference text,
    p_provider_transfer_code text,
    p_provider_transfer_id text,
    p_amount_minor bigint,
    p_currency text,
    p_provider_status text,
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

  cleaned_transfer_code text;

  cleaned_transfer_id text;

  cleaned_currency text;

  cleaned_status text;

  payout_row
    public.friend_transfer_payouts%rowtype;
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

  cleaned_transfer_code :=
    btrim(
      coalesce(
        p_provider_transfer_code,
        ''
      )
    );

  cleaned_transfer_id :=
    btrim(
      coalesce(
        p_provider_transfer_id,
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

  cleaned_status :=
    lower(
      btrim(
        coalesce(
          p_provider_status,
          ''
        )
      )
    );

  if cleaned_provider <>
      'paystack'
    or cleaned_event_type not in (
      'transfer.success',
      'transfer.failed',
      'transfer.reversed'
    )
    or cleaned_reference !~
      '^mova-po-[0-9a-f]{32}$'
    or char_length(
      cleaned_transfer_code
    ) not between 3 and 100
    or char_length(
      cleaned_transfer_id
    ) not between 1 and 100
    or p_amount_minor
      is null
    or p_amount_minor <=
      0
    or p_amount_minor >
      9007199254740991
    or cleaned_currency <>
      'NGN'
    or cleaned_status not in (
      'success',
      'failed',
      'reversed'
    )
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

  if (
    cleaned_event_type =
      'transfer.success'
    and cleaned_status <>
      'success'
  )
  or (
    cleaned_event_type =
      'transfer.failed'
    and cleaned_status <>
      'failed'
  )
  or (
    cleaned_event_type =
      'transfer.reversed'
    and cleaned_status <>
      'reversed'
  )
  then
    return jsonb_build_object(
      'status',
      'invalid'
    );
  end if;

  select *
  into payout_row
  from public.friend_transfer_payouts
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

  insert into public.friend_transfer_provider_events (
    payout_id,
    provider,
    event_type,
    provider_reference,
    provider_object_id,
    payload_hash
  )
  values (
    payout_row.id,
    cleaned_provider,
    cleaned_event_type,
    cleaned_reference,
    cleaned_transfer_id,
    p_payload_hash
  )
  on conflict (
    provider,
    payload_hash
  )
  do nothing;

  --------------------------------------------------------------------
  -- IDENTIFIERS MUST BE STABLE
  --------------------------------------------------------------------

  if payout_row.provider_transfer_code
      is not null
    and payout_row.provider_transfer_code <>
      cleaned_transfer_code
  then
    return jsonb_build_object(
      'status',
      'conflict'
    );
  end if;

  if payout_row.provider_transfer_id
      is not null
    and payout_row.provider_transfer_id <>
      cleaned_transfer_id
  then
    return jsonb_build_object(
      'status',
      'conflict'
    );
  end if;

  --------------------------------------------------------------------
  -- FINANCIAL TERMS MUST MATCH MOVA'S PAYOUT
  --------------------------------------------------------------------

  if payout_row.amount_minor <>
      p_amount_minor
    or payout_row.currency <>
      cleaned_currency
  then
    update public.friend_transfer_payouts
    set
      status =
        'reconciliation_required',

      provider_transfer_code =
        cleaned_transfer_code,

      provider_transfer_id =
        cleaned_transfer_id,

      provider_status =
        cleaned_status,

      failure_reason =
        'amount_or_currency_mismatch'
    where id =
      payout_row.id;

    return jsonb_build_object(
      'status',
      'reconciliation_required',

      'reason',
      'amount_or_currency_mismatch',

      'payoutId',
      payout_row.id
    );
  end if;

  --------------------------------------------------------------------
  -- IDEMPOTENT TERMINAL RETRY
  --------------------------------------------------------------------

  if payout_row.status in (
    'success',
    'failed',
    'reversed'
  )
  then
    if payout_row.status =
        cleaned_status
      and payout_row.provider_transfer_code =
        cleaned_transfer_code
      and payout_row.provider_transfer_id =
        cleaned_transfer_id
    then
      return jsonb_build_object(
        'status',
        'already_finalized',

        'payoutStatus',
        payout_row.status,

        'payoutId',
        payout_row.id
      );
    end if;

    return jsonb_build_object(
      'status',
      'conflict'
    );
  end if;

  --------------------------------------------------------------------
  -- NORMAL TERMINAL SETTLEMENT
  --------------------------------------------------------------------

  update public.friend_transfer_payouts
  set
    status =
      cleaned_status,

    provider_transfer_code =
      cleaned_transfer_code,

    provider_transfer_id =
      cleaned_transfer_id,

    provider_status =
      cleaned_status,

    completed_at =
      case
        when cleaned_status =
          'success'
        then now()
        else null
      end,

    failed_at =
      case
        when cleaned_status =
          'failed'
        then now()
        else null
      end,

    reversed_at =
      case
        when cleaned_status =
          'reversed'
        then now()
        else null
      end,

    failure_reason =
      case
        when cleaned_status =
          'success'
        then null

        when cleaned_status =
          'failed'
        then 'provider_failed'

        when cleaned_status =
          'reversed'
        then 'provider_reversed'

        else failure_reason
      end
  where id =
    payout_row.id;

  return jsonb_build_object(
    'status',
    'finalized',

    'payoutStatus',
    cleaned_status,

    'payoutId',
    payout_row.id,

    'paymentIntentId',
    payout_row.payment_intent_id,

    'quoteId',
    payout_row.quote_id,

    'senderUserId',
    payout_row.sender_user_id,

    'recipientUserId',
    payout_row.recipient_user_id,

    'amountMinor',
    payout_row.amount_minor,

    'currency',
    payout_row.currency
  );
end;
$$;

----------------------------------------------------------------------
-- ROW LEVEL SECURITY
----------------------------------------------------------------------

alter table public.friend_transfer_quotes
  enable row level security;

alter table public.friend_transfer_quotes
  force row level security;

alter table public.friend_transfer_payment_intents
  enable row level security;

alter table public.friend_transfer_payment_intents
  force row level security;

alter table public.friend_transfer_payouts
  enable row level security;

alter table public.friend_transfer_payouts
  force row level security;

alter table public.friend_transfer_provider_events
  enable row level security;

alter table public.friend_transfer_provider_events
  force row level security;

revoke all
  on table public.friend_transfer_quotes
  from public, anon, authenticated;

revoke all
  on table public.friend_transfer_payment_intents
  from public, anon, authenticated;

revoke all
  on table public.friend_transfer_payouts
  from public, anon, authenticated;

revoke all
  on table public.friend_transfer_provider_events
  from public, anon, authenticated;

grant
  select,
  insert,
  update
on table public.friend_transfer_quotes
to service_role;

grant
  select,
  insert,
  update
on table public.friend_transfer_payment_intents
to service_role;

grant
  select,
  insert,
  update
on table public.friend_transfer_payouts
to service_role;

grant
  select,
  insert
on table public.friend_transfer_provider_events
to service_role;

----------------------------------------------------------------------
-- RPC PERMISSIONS
----------------------------------------------------------------------

revoke all
  on function
    public.prepare_friend_transfer_quote(
      uuid,
      uuid,
      uuid,
      bigint,
      text
    )
  from public, anon, authenticated;

revoke all
  on function
    public.prepare_friend_transfer_payment(
      uuid,
      uuid,
      text
    )
  from public, anon, authenticated;

revoke all
  on function
    public.begin_friend_transfer_saved_card_charge(
      uuid,
      uuid,
      text
    )
  from public, anon, authenticated;

revoke all
  on function
    public.fail_friend_transfer_payment(
      uuid,
      uuid,
      text,
      text
    )
  from public, anon, authenticated;

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

revoke all
  on function
    public.begin_friend_transfer_payout(
      uuid,
      text
    )
  from public, anon, authenticated;

revoke all
  on function
    public.record_friend_transfer_payout_initiation(
      uuid,
      text,
      text,
      text,
      text
    )
  from public, anon, authenticated;

revoke all
  on function
    public.complete_friend_transfer_payout_from_provider(
      text,
      text,
      text,
      text,
      text,
      bigint,
      text,
      text,
      text
    )
  from public, anon, authenticated;

grant execute
  on function
    public.prepare_friend_transfer_quote(
      uuid,
      uuid,
      uuid,
      bigint,
      text
    )
  to service_role;

grant execute
  on function
    public.prepare_friend_transfer_payment(
      uuid,
      uuid,
      text
    )
  to service_role;

grant execute
  on function
    public.begin_friend_transfer_saved_card_charge(
      uuid,
      uuid,
      text
    )
  to service_role;

grant execute
  on function
    public.fail_friend_transfer_payment(
      uuid,
      uuid,
      text,
      text
    )
  to service_role;

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

grant execute
  on function
    public.begin_friend_transfer_payout(
      uuid,
      text
    )
  to service_role;

grant execute
  on function
    public.record_friend_transfer_payout_initiation(
      uuid,
      text,
      text,
      text,
      text
    )
  to service_role;

grant execute
  on function
    public.complete_friend_transfer_payout_from_provider(
      text,
      text,
      text,
      text,
      text,
      bigint,
      text,
      text,
      text
    )
  to service_role;

commit;