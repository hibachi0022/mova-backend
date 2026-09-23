begin;

----------------------------------------------------------------------
-- OUTING PAYMENT INTENTS
--
-- This table represents a server-authorised payment attempt for one
-- outing.
--
-- Important:
--   - The client never supplies the amount or payer.
--   - Amount/currency are copied from the outing.
--   - Payer is copied from outings.selected_member_id.
--   - Provider checkout is attached only after an intent is created.
--   - Idempotency prevents retries creating duplicate attempts.
----------------------------------------------------------------------

create table public.outing_payment_intents (
  id uuid primary key
    default gen_random_uuid(),

  outing_id uuid not null
    references public.outings(id)
    on delete cascade,

  selected_member_id uuid
    references public.outing_members(id)
    on delete set null,

  payer_user_id uuid
    references public.profiles(user_id)
    on delete set null,

  amount_minor bigint not null,

  currency text not null,

  method_id text not null,

  status text not null
    default 'created',

  idempotency_key_hash text not null,

  provider text,

  provider_checkout_id text,

  provider_reference text,

  checkout_url text,

  expires_at timestamptz not null
    default (
      now() +
      interval '15 minutes'
    ),

  completed_at timestamptz,

  created_at timestamptz not null
    default now(),

  updated_at timestamptz not null
    default now(),

  constraint outing_payment_intents_amount_check
    check (
      amount_minor > 0
      and amount_minor <=
        9007199254740991
    ),

  constraint outing_payment_intents_currency_check
    check (
      currency ~
        '^[A-Z]{3}$'
    ),

  constraint outing_payment_intents_method_check
    check (
      method_id in (
        'nfc',
        'apple_pay',
        'google_pay',
        'paypal',
        'bank_transfer',
        'card'
      )
    ),

  constraint outing_payment_intents_status_check
    check (
      status in (
        'created',
        'checkout_ready',
        'processing',
        'completed',
        'failed',
        'cancelled',
        'expired'
      )
    ),

  constraint outing_payment_intents_idempotency_hash_check
    check (
      idempotency_key_hash ~
        '^[0-9a-f]{64}$'
    ),

  constraint outing_payment_intents_provider_check
    check (
      provider is null
      or char_length(
        provider
      ) between 2 and 40
    ),

  constraint outing_payment_intents_provider_checkout_id_check
    check (
      provider_checkout_id is null
      or char_length(
        provider_checkout_id
      ) between 1 and 200
    ),

  constraint outing_payment_intents_provider_reference_check
    check (
      provider_reference is null
      or char_length(
        provider_reference
      ) between 1 and 200
    ),

  constraint outing_payment_intents_checkout_url_check
    check (
      checkout_url is null
      or checkout_url ~
        '^https://[^[:space:]]+$'
    ),

  constraint outing_payment_intents_completed_at_check
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
    )
);

----------------------------------------------------------------------
-- INDEXES / UNIQUENESS
----------------------------------------------------------------------

create unique index
  outing_payment_intents_idempotency_idx
on public.outing_payment_intents (
  payer_user_id,
  outing_id,
  idempotency_key_hash
);

create unique index
  outing_payment_intents_provider_reference_idx
on public.outing_payment_intents (
  provider,
  provider_reference
)
where provider is not null
  and provider_reference
    is not null;

create unique index
  outing_payment_intents_provider_checkout_idx
on public.outing_payment_intents (
  provider,
  provider_checkout_id
)
where provider is not null
  and provider_checkout_id
    is not null;

----------------------------------------------------------------------
-- AN OUTING MAY ONLY HAVE ONE COMPLETED PAYMENT
----------------------------------------------------------------------

create unique index
  outing_payment_intents_completed_outing_idx
on public.outing_payment_intents (
  outing_id
)
where status =
  'completed';

create index
  outing_payment_intents_outing_created_idx
on public.outing_payment_intents (
  outing_id,
  created_at desc
);

----------------------------------------------------------------------
-- UPDATED_AT
----------------------------------------------------------------------

create or replace function
  public.touch_outing_payment_intent_updated_at()
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
    public.touch_outing_payment_intent_updated_at()
  from public, anon, authenticated;

create trigger
  outing_payment_intents_updated_at
before update
on public.outing_payment_intents
for each row
execute function
  public.touch_outing_payment_intent_updated_at();

----------------------------------------------------------------------
-- CANCEL UNUSED CHECKOUT WHEN SELECTED PAYER CHANGES
--
-- A prepared checkout is bound to the winner who existed when it was
-- created.
--
-- If that winner changes before payment processing starts, the old
-- checkout must no longer be considered valid by MOVA.
----------------------------------------------------------------------

create or replace function
  public.cancel_outing_payment_intents_on_selection_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.selected_member_id
      is distinct from
        old.selected_member_id
  then
    update public.outing_payment_intents
    set status =
      'cancelled'
    where outing_id =
      new.id
      and status in (
        'created',
        'checkout_ready'
      );
  end if;

  return new;
end;
$$;

revoke all
  on function
    public.cancel_outing_payment_intents_on_selection_change()
  from public, anon, authenticated;

create trigger
  outings_cancel_payment_on_selection_change
after update of selected_member_id
on public.outings
for each row
execute function
  public.cancel_outing_payment_intents_on_selection_change();

----------------------------------------------------------------------
-- PREPARE PAYMENT INTENT
--
-- The authenticated user supplies:
--   user ID
--   outing ID
--   chosen method
--   SHA-256 hash of the client's Idempotency-Key
--
-- They DO NOT supply:
--   amount
--   currency
--   selected payer
--
-- All financial terms come from trusted database state.
----------------------------------------------------------------------

create or replace function
  public.prepare_outing_payment_intent(
    p_user_id uuid,
    p_outing_id uuid,
    p_method_id text,
    p_idempotency_key_hash text
  )
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  outing_row
    public.outings%rowtype;

  actor_member_id uuid;

  selected_user_id uuid;
  selected_is_opted_in boolean;

  cleaned_method text;

  existing_intent
    public.outing_payment_intents%rowtype;

  active_intent_id uuid;

  new_intent_id uuid;
  new_expires_at timestamptz;
begin
  cleaned_method :=
    lower(
      btrim(
        coalesce(
          p_method_id,
          ''
        )
      )
    );

  if p_user_id is null
    or p_outing_id is null
    or cleaned_method not in (
      'nfc',
      'apple_pay',
      'google_pay',
      'paypal',
      'bank_transfer',
      'card'
    )
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

  --------------------------------------------------------------------
  -- LOCK OUTING SO PAYMENT PREPARATION CANNOT RACE PAYER CHANGES
  --------------------------------------------------------------------

  select *
  into outing_row
  from public.outings
  where id =
    p_outing_id
  for update;

  if not found then
    return jsonb_build_object(
      'status',
      'not_found'
    );
  end if;

  --------------------------------------------------------------------
  -- CALLER MUST BE A CURRENT REGISTERED MEMBER
  --------------------------------------------------------------------

  select id
  into actor_member_id
  from public.outing_members
  where outing_id =
    p_outing_id
    and user_id =
      p_user_id
    and removed_at is null
  limit 1;

  if actor_member_id
      is null
  then
    return jsonb_build_object(
      'status',
      'not_found'
    );
  end if;

  if outing_row.status <>
      'active'
  then
    return jsonb_build_object(
      'status',
      'inactive'
    );
  end if;

  --------------------------------------------------------------------
  -- A ROULETTE WINNER MUST EXIST
  --------------------------------------------------------------------

  if outing_row.selected_member_id
      is null
  then
    return jsonb_build_object(
      'status',
      'no_selection'
    );
  end if;

  --------------------------------------------------------------------
  -- WINNER MUST STILL BE ACTIVE, REGISTERED AND OPTED IN
  --------------------------------------------------------------------

  select
    user_id,
    opted_in
  into
    selected_user_id,
    selected_is_opted_in
  from public.outing_members
  where id =
    outing_row.selected_member_id
    and outing_id =
      p_outing_id
    and removed_at is null
  limit 1;

  if not found
    or selected_user_id
      is null
    or selected_is_opted_in
      is not true
  then
    return jsonb_build_object(
      'status',
      'selection_unavailable'
    );
  end if;

  --------------------------------------------------------------------
  -- ONLY THE SELECTED PAYER MAY START CHECKOUT
  --------------------------------------------------------------------

  if selected_user_id <>
      p_user_id
  then
    return jsonb_build_object(
      'status',
      'not_selected_payer'
    );
  end if;

  --------------------------------------------------------------------
  -- THERE MUST BE SOMETHING TO PAY
  --------------------------------------------------------------------

  if outing_row.amount_minor <=
      0
  then
    return jsonb_build_object(
      'status',
      'no_amount'
    );
  end if;

  --------------------------------------------------------------------
  -- EXPIRE ABANDONED PRE-PAYMENT ATTEMPTS
  --
  -- Processing payments are deliberately not expired here.
  --------------------------------------------------------------------

  update public.outing_payment_intents
  set status =
    'expired'
  where outing_id =
    p_outing_id
    and payer_user_id =
      p_user_id
    and status in (
      'created',
      'checkout_ready'
    )
    and expires_at <=
      now();

  --------------------------------------------------------------------
  -- IDEMPOTENT RETRY
  --------------------------------------------------------------------

  select *
  into existing_intent
  from public.outing_payment_intents
  where payer_user_id =
    p_user_id
    and outing_id =
      p_outing_id
    and idempotency_key_hash =
      p_idempotency_key_hash
  limit 1;

  if found then
    if existing_intent.method_id <>
        cleaned_method
      or
      existing_intent.selected_member_id
        is distinct from
          outing_row.selected_member_id
      or
      existing_intent.amount_minor <>
        outing_row.amount_minor
      or
      existing_intent.currency <>
        outing_row.currency
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
      'selectedMemberId',
      existing_intent.selected_member_id,
      'amountMinor',
      existing_intent.amount_minor,
      'currency',
      existing_intent.currency,
      'methodId',
      existing_intent.method_id,
      'expiresAt',
      existing_intent.expires_at
    );
  end if;

  --------------------------------------------------------------------
  -- COMPLETED OUTING PAYMENT CANNOT BE STARTED AGAIN
  --------------------------------------------------------------------

  if exists (
    select 1
    from public.outing_payment_intents
    where outing_id =
      p_outing_id
      and status =
        'completed'
  ) then
    return jsonb_build_object(
      'status',
      'already_paid'
    );
  end if;

  --------------------------------------------------------------------
  -- PREVENT TWO LIVE CHECKOUT FLOWS FOR THE SAME OUTING
  --------------------------------------------------------------------

  select id
  into active_intent_id
  from public.outing_payment_intents
  where outing_id =
    p_outing_id
    and (
      status =
        'processing'
      or (
        status in (
          'created',
          'checkout_ready'
        )
        and expires_at >
          now()
      )
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

  --------------------------------------------------------------------
  -- CREATE TRUSTED PAYMENT INTENT
  --------------------------------------------------------------------

  new_expires_at :=
    now() +
    interval '15 minutes';

  insert into public.outing_payment_intents (
    outing_id,
    selected_member_id,
    payer_user_id,
    amount_minor,
    currency,
    method_id,
    status,
    idempotency_key_hash,
    expires_at
  )
  values (
    p_outing_id,
    outing_row.selected_member_id,
    p_user_id,
    outing_row.amount_minor,
    outing_row.currency,
    cleaned_method,
    'created',
    p_idempotency_key_hash,
    new_expires_at
  )
  returning id
  into new_intent_id;

  return jsonb_build_object(
    'status',
    'created',
    'intentId',
    new_intent_id,
    'selectedMemberId',
    outing_row.selected_member_id,
    'amountMinor',
    outing_row.amount_minor,
    'currency',
    outing_row.currency,
    'methodId',
    cleaned_method,
    'expiresAt',
    new_expires_at
  );
end;
$$;

----------------------------------------------------------------------
-- ATTACH PROVIDER CHECKOUT
--
-- Called only after the backend obtains a provider-hosted HTTPS
-- checkout session.
----------------------------------------------------------------------

create or replace function
  public.attach_outing_payment_checkout(
    p_user_id uuid,
    p_intent_id uuid,
    p_provider text,
    p_provider_checkout_id text,
    p_provider_reference text,
    p_checkout_url text,
    p_expires_at timestamptz
  )
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  intent_row
    public.outing_payment_intents%rowtype;

  cleaned_provider text;
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

  if p_user_id is null
    or p_intent_id is null
    or char_length(
      cleaned_provider
    ) not between 2 and 40
    or p_provider_checkout_id
      is null
    or char_length(
      p_provider_checkout_id
    ) not between 1 and 200
    or p_provider_reference
      is null
    or char_length(
      p_provider_reference
    ) not between 1 and 200
    or p_checkout_url
      is null
    or p_checkout_url !~
      '^https://[^[:space:]]+$'
    or p_expires_at
      is null
    or p_expires_at <=
      now()
    or p_expires_at >
      now() +
      interval '1 day'
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
    or intent_row.payer_user_id
      is distinct from
        p_user_id
  then
    return jsonb_build_object(
      'status',
      'not_found'
    );
  end if;

  --------------------------------------------------------------------
  -- SAFE IDEMPOTENT RETRY AFTER PROVIDER INITIALISATION
  --------------------------------------------------------------------

  if intent_row.status =
      'checkout_ready'
  then
    if intent_row.provider =
        cleaned_provider
      and intent_row.provider_checkout_id =
        p_provider_checkout_id
      and intent_row.provider_reference =
        p_provider_reference
      and intent_row.checkout_url =
        p_checkout_url
    then
      return jsonb_build_object(
        'status',
        'existing',
        'intentId',
        intent_row.id,
        'checkoutUrl',
        intent_row.checkout_url,
        'expiresAt',
        intent_row.expires_at
      );
    end if;

    return jsonb_build_object(
      'status',
      'conflict'
    );
  end if;

  if intent_row.status <>
      'created'
  then
    return jsonb_build_object(
      'status',
      'not_available',
      'paymentStatus',
      intent_row.status
    );
  end if;

  if intent_row.expires_at <=
      now()
  then
    update public.outing_payment_intents
    set status =
      'expired'
    where id =
      p_intent_id;

    return jsonb_build_object(
      'status',
      'expired'
    );
  end if;

  update public.outing_payment_intents
  set
    provider =
      cleaned_provider,

    provider_checkout_id =
      p_provider_checkout_id,

    provider_reference =
      p_provider_reference,

    checkout_url =
      p_checkout_url,

    expires_at =
      p_expires_at,

    status =
      'checkout_ready'
  where id =
    p_intent_id;

  return jsonb_build_object(
    'status',
    'ready',
    'intentId',
    p_intent_id,
    'checkoutUrl',
    p_checkout_url,
    'expiresAt',
    p_expires_at
  );
end;
$$;

----------------------------------------------------------------------
-- BACKEND-ONLY ACCESS
----------------------------------------------------------------------

alter table public.outing_payment_intents
  enable row level security;

revoke all
  on table public.outing_payment_intents
  from public, anon, authenticated;

grant select, insert, update
  on table public.outing_payment_intents
  to service_role;

revoke all
  on function
    public.prepare_outing_payment_intent(
      uuid,
      uuid,
      text,
      text
    )
  from public, anon, authenticated;

revoke all
  on function
    public.attach_outing_payment_checkout(
      uuid,
      uuid,
      text,
      text,
      text,
      text,
      timestamptz
    )
  from public, anon, authenticated;

grant execute
  on function
    public.prepare_outing_payment_intent(
      uuid,
      uuid,
      text,
      text
    )
  to service_role;

grant execute
  on function
    public.attach_outing_payment_checkout(
      uuid,
      uuid,
      text,
      text,
      text,
      text,
      timestamptz
    )
  to service_role;

commit;