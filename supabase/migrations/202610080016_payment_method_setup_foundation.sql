begin;

----------------------------------------------------------------------
-- STANDALONE PAYMENT METHOD SETUP
--
-- Paystack requires a successful authenticated card transaction before
-- a reusable card authorization can be created.
--
-- MOVA uses a small NGN 50.00 verification transaction:
--
--   5000 kobo
--
-- After Paystack verifies the payment and MOVA safely stores the
-- reusable authorization, MOVA will request a full refund.
--
-- This table NEVER stores:
--
--   - full card number
--   - CVV
--   - PIN
--
-- Provider authorization tokens continue to live only in the existing
-- backend-only payment_methods table.
----------------------------------------------------------------------

create table
  public.payment_method_setups (
    id uuid primary key
      default gen_random_uuid(),

    user_id uuid not null
      references public.profiles(user_id)
      on delete cascade,

    email text not null,

    amount_minor integer not null
      default 5000,

    currency text not null
      default 'NGN',

    provider text not null
      default 'paystack',

    provider_reference text,

    provider_checkout_id text,

    provider_checkout_url text,

    provider_transaction_id text,

    provider_amount_minor integer,

    payment_method_id uuid
      references public.payment_methods(id)
      on delete set null,

    status text not null
      default 'created',

    refund_status text not null
      default 'not_requested',

    provider_refund_id text,

    idempotency_key_hash text not null,

    expires_at timestamptz not null
      default (
        now() +
        interval '15 minutes'
      ),

    completed_at timestamptz,

    refund_requested_at timestamptz,

    refunded_at timestamptz,

    created_at timestamptz not null
      default now(),

    updated_at timestamptz not null
      default now(),

    constraint
      payment_method_setups_email_check
      check (
        char_length(
          email
        ) between 3 and 320
      ),

    constraint
      payment_method_setups_amount_check
      check (
        amount_minor =
          5000
      ),

    constraint
      payment_method_setups_currency_check
      check (
        currency =
          'NGN'
      ),

    constraint
      payment_method_setups_provider_check
      check (
        provider =
          'paystack'
      ),

    constraint
      payment_method_setups_reference_check
      check (
        provider_reference is null
        or (
          char_length(
            provider_reference
          ) between 1 and 200
          and provider_reference ~
            '^[A-Za-z0-9.=_-]+$'
        )
      ),

    constraint
      payment_method_setups_checkout_id_check
      check (
        provider_checkout_id is null
        or char_length(
          provider_checkout_id
        ) between 1 and 300
      ),

    constraint
      payment_method_setups_checkout_url_check
      check (
        provider_checkout_url is null
        or (
          char_length(
            provider_checkout_url
          ) between 1 and 2000
          and provider_checkout_url ~
            '^https://'
        )
      ),

    constraint
      payment_method_setups_transaction_id_check
      check (
        provider_transaction_id is null
        or char_length(
          provider_transaction_id
        ) between 1 and 200
      ),

    constraint
      payment_method_setups_provider_amount_check
      check (
        provider_amount_minor is null
        or provider_amount_minor >
          0
      ),

    constraint
      payment_method_setups_status_check
      check (
        status in (
          'created',
          'checkout_ready',
          'completed',
          'failed',
          'expired'
        )
      ),

    constraint
      payment_method_setups_refund_status_check
      check (
        refund_status in (
          'not_requested',
          'pending',
          'processing',
          'needs_attention',
          'processed',
          'failed'
        )
      ),

    constraint
      payment_method_setups_refund_id_check
      check (
        provider_refund_id is null
        or char_length(
          provider_refund_id
        ) between 1 and 200
      ),

    constraint
      payment_method_setups_idempotency_check
      check (
        idempotency_key_hash ~
          '^[0-9a-f]{64}$'
      ),

    constraint
      payment_method_setups_expiry_check
      check (
        expires_at >
          created_at
      )
  );

----------------------------------------------------------------------
-- IDEMPOTENCY
----------------------------------------------------------------------

create unique index
  payment_method_setups_user_idempotency_idx
on public.payment_method_setups (
  user_id,
  idempotency_key_hash
);

----------------------------------------------------------------------
-- PROVIDER IDENTIFIERS
----------------------------------------------------------------------

create unique index
  payment_method_setups_provider_reference_idx
on public.payment_method_setups (
  provider,
  provider_reference
)
where provider_reference
  is not null;

create unique index
  payment_method_setups_provider_transaction_idx
on public.payment_method_setups (
  provider,
  provider_transaction_id
)
where provider_transaction_id
  is not null;

----------------------------------------------------------------------
-- ONLY ONE OPEN CARD-SETUP SESSION PER USER
----------------------------------------------------------------------

create unique index
  payment_method_setups_active_user_idx
on public.payment_method_setups (
  user_id
)
where status in (
  'created',
  'checkout_ready'
);

----------------------------------------------------------------------
-- FAST LOOKUPS
----------------------------------------------------------------------

create index
  payment_method_setups_user_created_idx
on public.payment_method_setups (
  user_id,
  created_at desc
);

----------------------------------------------------------------------
-- UPDATED_AT
----------------------------------------------------------------------

create or replace function
  public.touch_payment_method_setup_updated_at()
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
  public.touch_payment_method_setup_updated_at()
from public, anon, authenticated;

create trigger
  payment_method_setups_updated_at
before update
on public.payment_method_setups
for each row
execute function
  public.touch_payment_method_setup_updated_at();

----------------------------------------------------------------------
-- PREPARE STANDALONE CARD SETUP
--
-- Inputs:
--
--   authenticated user ID
--   trusted authenticated email
--   SHA-256 hash of the client idempotency key
--
-- Amount and currency are never accepted from the mobile client.
----------------------------------------------------------------------

create or replace function
  public.prepare_payment_method_setup(
    p_user_id uuid,
    p_email text,
    p_idempotency_key_hash text
  )
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  cleaned_email text;

  existing_setup
    public.payment_method_setups%rowtype;

  active_setup
    public.payment_method_setups%rowtype;

  new_setup_id uuid;

  new_expires_at timestamptz;
begin
  cleaned_email :=
    lower(
      btrim(
        coalesce(
          p_email,
          ''
        )
      )
    );

  if p_user_id is null
    or char_length(
      cleaned_email
    ) not between 3 and 320
    or cleaned_email !~
      '^[^[:space:]@]+@[^[:space:]@]+$'
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
  -- SERIALIZE SETUP CHANGES FOR THE USER
  --------------------------------------------------------------------

  perform 1
  from public.profiles
  where user_id =
    p_user_id
  for update;

  if not found
  then
    return jsonb_build_object(
      'status',
      'not_found'
    );
  end if;

  --------------------------------------------------------------------
  -- EXPIRE ABANDONED SETUPS
  --------------------------------------------------------------------

  update public.payment_method_setups
  set status =
    'expired'
  where user_id =
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
  into existing_setup
  from public.payment_method_setups
  where user_id =
      p_user_id
    and idempotency_key_hash =
      p_idempotency_key_hash
  limit 1;

  if found
  then
    return jsonb_build_object(
      'status',
      'existing',

      'setupId',
      existing_setup.id,

      'setupStatus',
      existing_setup.status,

      'amountMinor',
      existing_setup.amount_minor,

      'currency',
      existing_setup.currency,

      'providerReference',
      existing_setup.provider_reference,

      'checkoutUrl',
      existing_setup.provider_checkout_url,

      'expiresAt',
      existing_setup.expires_at
    );
  end if;

  --------------------------------------------------------------------
  -- DO NOT CREATE MULTIPLE OPEN CARD SETUPS
  --------------------------------------------------------------------

  select *
  into active_setup
  from public.payment_method_setups
  where user_id =
      p_user_id
    and status in (
      'created',
      'checkout_ready'
    )
  order by created_at desc
  limit 1
  for update;

  if found
  then
    return jsonb_build_object(
      'status',
      'setup_in_progress',

      'setupId',
      active_setup.id,

      'setupStatus',
      active_setup.status,

      'amountMinor',
      active_setup.amount_minor,

      'currency',
      active_setup.currency,

      'providerReference',
      active_setup.provider_reference,

      'checkoutUrl',
      active_setup.provider_checkout_url,

      'expiresAt',
      active_setup.expires_at
    );
  end if;

  --------------------------------------------------------------------
  -- CREATE TRUSTED SETUP SESSION
  --------------------------------------------------------------------

  new_expires_at :=
    now() +
    interval '15 minutes';

  insert into public.payment_method_setups (
    user_id,
    email,
    amount_minor,
    currency,
    provider,
    status,
    refund_status,
    idempotency_key_hash,
    expires_at
  )
  values (
    p_user_id,
    cleaned_email,
    5000,
    'NGN',
    'paystack',
    'created',
    'not_requested',
    p_idempotency_key_hash,
    new_expires_at
  )
  returning id
  into new_setup_id;

  return jsonb_build_object(
    'status',
    'created',

    'setupId',
    new_setup_id,

    'setupStatus',
    'created',

    'amountMinor',
    5000,

    'currency',
    'NGN',

    'expiresAt',
    new_expires_at
  );
end;
$$;

----------------------------------------------------------------------
-- BIND PAYSTACK CHECKOUT
--
-- The backend calls Paystack first using a deterministic reference.
--
-- Once Paystack returns the checkout URL/access code, this function
-- binds them to the trusted setup record before they are returned to
-- the mobile app.
----------------------------------------------------------------------

create or replace function
  public.bind_payment_method_setup_checkout(
    p_user_id uuid,
    p_setup_id uuid,
    p_provider_reference text,
    p_provider_checkout_id text,
    p_provider_checkout_url text
  )
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  setup_row
    public.payment_method_setups%rowtype;

  cleaned_reference text;

  cleaned_checkout_id text;

  cleaned_checkout_url text;
begin
  cleaned_reference :=
    btrim(
      coalesce(
        p_provider_reference,
        ''
      )
    );

  cleaned_checkout_id :=
    btrim(
      coalesce(
        p_provider_checkout_id,
        ''
      )
    );

  cleaned_checkout_url :=
    btrim(
      coalesce(
        p_provider_checkout_url,
        ''
      )
    );

  if p_user_id is null
    or p_setup_id is null
    or char_length(
      cleaned_reference
    ) not between 1 and 200
    or cleaned_reference !~
      '^[A-Za-z0-9.=_-]+$'
    or char_length(
      cleaned_checkout_id
    ) not between 1 and 300
    or char_length(
      cleaned_checkout_url
    ) not between 1 and 2000
    or cleaned_checkout_url !~
      '^https://'
  then
    return jsonb_build_object(
      'status',
      'invalid'
    );
  end if;

  select *
  into setup_row
  from public.payment_method_setups
  where id =
      p_setup_id
    and user_id =
      p_user_id
  for update;

  if not found
  then
    return jsonb_build_object(
      'status',
      'not_found'
    );
  end if;

  --------------------------------------------------------------------
  -- IDEMPOTENT BIND
  --------------------------------------------------------------------

  if setup_row.status =
      'checkout_ready'
  then
    if setup_row.provider_reference =
        cleaned_reference
      and setup_row.provider_checkout_id =
        cleaned_checkout_id
      and setup_row.provider_checkout_url =
        cleaned_checkout_url
    then
      return jsonb_build_object(
        'status',
        'existing',

        'setupId',
        setup_row.id,

        'checkoutUrl',
        setup_row.provider_checkout_url,

        'providerReference',
        setup_row.provider_reference,

        'expiresAt',
        setup_row.expires_at
      );
    end if;

    return jsonb_build_object(
      'status',
      'conflict'
    );
  end if;

  if setup_row.status <>
      'created'
  then
    return jsonb_build_object(
      'status',
      'not_available',

      'setupStatus',
      setup_row.status
    );
  end if;

  if setup_row.expires_at <=
      now()
  then
    update public.payment_method_setups
    set status =
      'expired'
    where id =
      setup_row.id;

    return jsonb_build_object(
      'status',
      'expired'
    );
  end if;

  --------------------------------------------------------------------
  -- DEFENSIVE PROVIDER REFERENCE COLLISION CHECK
  --------------------------------------------------------------------

  if exists (
    select 1
    from public.payment_method_setups
    where provider =
        'paystack'
      and provider_reference =
        cleaned_reference
      and id <>
        setup_row.id
  )
  then
    return jsonb_build_object(
      'status',
      'conflict'
    );
  end if;

  update public.payment_method_setups
  set
    provider_reference =
      cleaned_reference,

    provider_checkout_id =
      cleaned_checkout_id,

    provider_checkout_url =
      cleaned_checkout_url,

    status =
      'checkout_ready'
  where id =
    setup_row.id;

  return jsonb_build_object(
    'status',
    'ready',

    'setupId',
    setup_row.id,

    'checkoutUrl',
    cleaned_checkout_url,

    'providerReference',
    cleaned_reference,

    'expiresAt',
    setup_row.expires_at
  );
end;
$$;

----------------------------------------------------------------------
-- FAIL SETUP INITIALIZATION
--
-- Safe only before a checkout URL has been returned to the client.
--
-- Once status is checkout_ready, the transaction may still be paid and
-- must therefore remain available for webhook verification.
----------------------------------------------------------------------

create or replace function
  public.fail_payment_method_setup(
    p_user_id uuid,
    p_setup_id uuid
  )
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  setup_row
    public.payment_method_setups%rowtype;
begin
  if p_user_id is null
    or p_setup_id is null
  then
    return jsonb_build_object(
      'status',
      'invalid'
    );
  end if;

  select *
  into setup_row
  from public.payment_method_setups
  where id =
      p_setup_id
    and user_id =
      p_user_id
  for update;

  if not found
  then
    return jsonb_build_object(
      'status',
      'not_found'
    );
  end if;

  if setup_row.status =
      'failed'
  then
    return jsonb_build_object(
      'status',
      'existing'
    );
  end if;

  if setup_row.status <>
      'created'
  then
    return jsonb_build_object(
      'status',
      'not_available',

      'setupStatus',
      setup_row.status
    );
  end if;

  update public.payment_method_setups
  set status =
    'failed'
  where id =
    setup_row.id;

  return jsonb_build_object(
    'status',
    'failed',

    'setupId',
    setup_row.id
  );
end;
$$;

----------------------------------------------------------------------
-- BACKEND-ONLY ACCESS
----------------------------------------------------------------------

alter table
  public.payment_method_setups
enable row level security;

alter table
  public.payment_method_setups
force row level security;

revoke all
on table
  public.payment_method_setups
from anon, authenticated;

grant
  select,
  insert,
  update,
  delete
on table
  public.payment_method_setups
to service_role;

revoke all
on function
  public.prepare_payment_method_setup(
    uuid,
    text,
    text
  )
from public, anon, authenticated;

grant execute
on function
  public.prepare_payment_method_setup(
    uuid,
    text,
    text
  )
to service_role;

revoke all
on function
  public.bind_payment_method_setup_checkout(
    uuid,
    uuid,
    text,
    text,
    text
  )
from public, anon, authenticated;

grant execute
on function
  public.bind_payment_method_setup_checkout(
    uuid,
    uuid,
    text,
    text,
    text
  )
to service_role;

revoke all
on function
  public.fail_payment_method_setup(
    uuid,
    uuid
  )
from public, anon, authenticated;

grant execute
on function
  public.fail_payment_method_setup(
    uuid,
    uuid
  )
to service_role;

commit;