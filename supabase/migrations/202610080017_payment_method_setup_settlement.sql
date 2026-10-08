begin;

----------------------------------------------------------------------
-- PAYMENT METHOD SETUP SETTLEMENT + REFUND FOUNDATION
--
-- A standalone saved-card setup performs a small Paystack card charge.
--
-- Once Paystack verifies the charge:
--
--   1. MOVA records the trusted provider transaction
--   2. MOVA stores only a reusable Paystack authorization
--   3. MOVA marks the setup completed
--   4. MOVA begins a full refund workflow
--
-- The refund itself is asynchronous and is tracked independently.
----------------------------------------------------------------------

----------------------------------------------------------------------
-- ADD VERIFIED PROVIDER FIELDS
----------------------------------------------------------------------

alter table public.payment_method_setups
  add column provider_requested_amount_minor integer;

alter table public.payment_method_setups
  add column provider_paid_at timestamptz;

alter table public.payment_method_setups
  add column failure_reason text;

alter table public.payment_method_setups
  add constraint
    payment_method_setups_requested_amount_check
    check (
      provider_requested_amount_minor is null
      or provider_requested_amount_minor > 0
    );

alter table public.payment_method_setups
  add constraint
    payment_method_setups_failure_reason_check
    check (
      failure_reason is null
      or char_length(
        failure_reason
      ) between 1 and 120
    );

----------------------------------------------------------------------
-- REFUND INITIALIZATION STATE
--
-- "initiating" means MOVA has claimed responsibility for starting the
-- refund but has not yet safely bound a Paystack refund record.
--
-- If the HTTP request becomes uncertain, webhook/retry logic can first
-- query Paystack for an existing refund before attempting another one.
----------------------------------------------------------------------

alter table public.payment_method_setups
  drop constraint
    payment_method_setups_refund_status_check;

alter table public.payment_method_setups
  add constraint
    payment_method_setups_refund_status_check
    check (
      refund_status in (
        'not_requested',
        'initiating',
        'pending',
        'processing',
        'needs_attention',
        'processed',
        'failed'
      )
    );

----------------------------------------------------------------------
-- ONE PAYSTACK REFUND ID MAY BELONG TO ONLY ONE SETUP
----------------------------------------------------------------------

create unique index
  payment_method_setups_provider_refund_idx
on public.payment_method_setups (
  provider,
  provider_refund_id
)
where provider_refund_id
  is not null;

----------------------------------------------------------------------
-- COMPLETE VERIFIED STANDALONE CARD SETUP
--
-- This function receives data only after the backend:
--
--   - verified Paystack webhook HMAC
--   - independently called Verify Transaction
--
-- Trusted setup amount:
--
--   requested_amount = 5000 kobo
--
-- Actual provider amount may be greater if provider fees were passed
-- to the payer, therefore actual amount must be >= requested amount.
--
-- A successful provider charge is recorded even if the returned card
-- authorization is not reusable. That allows MOVA to refund the charge
-- instead of losing track of money that was actually collected.
----------------------------------------------------------------------

create or replace function
  public.complete_payment_method_setup_from_provider(
    p_provider text,
    p_provider_reference text,
    p_provider_transaction_id text,
    p_amount_minor integer,
    p_requested_amount_minor integer,
    p_currency text,
    p_channel text,
    p_paid_at timestamptz,
    p_provider_customer_code text,
    p_provider_email text,
    p_provider_authorization_code text,
    p_provider_signature text,
    p_network text,
    p_last4 text,
    p_exp_month smallint,
    p_exp_year smallint,
    p_bank text,
    p_country_code text,
    p_reusable boolean
  )
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  cleaned_provider text;
  cleaned_reference text;
  cleaned_transaction_id text;
  cleaned_currency text;
  cleaned_channel text;

  cleaned_customer_code text;
  cleaned_email text;
  cleaned_authorization_code text;
  cleaned_signature text;
  cleaned_network text;
  cleaned_last4 text;
  cleaned_bank text;
  cleaned_country_code text;

  setup_row
    public.payment_method_setups%rowtype;

  existing_method
    public.payment_methods%rowtype;

  saved_method_id uuid;
  conflicting_method_id uuid;

  make_default boolean;
  card_is_usable boolean;
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
  -- VERIFY BASIC PROVIDER SETTLEMENT DATA
  --------------------------------------------------------------------

  if cleaned_provider <>
      'paystack'
    or char_length(
      cleaned_reference
    ) not between 1 and 200
    or cleaned_reference !~
      '^[A-Za-z0-9.=_-]+$'
    or char_length(
      cleaned_transaction_id
    ) not between 1 and 200
    or p_amount_minor is null
    or p_amount_minor <=
      0
    or p_requested_amount_minor
      is null
    or p_requested_amount_minor <=
      0
    or cleaned_currency !~
      '^[A-Z]{3}$'
    or char_length(
      cleaned_channel
    ) not between 1 and 40
    or p_paid_at is null
  then
    return jsonb_build_object(
      'status',
      'invalid'
    );
  end if;

  --------------------------------------------------------------------
  -- LOAD TRUSTED SETUP BY PROVIDER REFERENCE
  --------------------------------------------------------------------

  select *
  into setup_row
  from public.payment_method_setups
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
  -- IDEMPOTENT PROVIDER RETRY
  --------------------------------------------------------------------

  if setup_row.provider_transaction_id
      is not null
  then
    if setup_row.provider_transaction_id <>
        cleaned_transaction_id
      or setup_row.provider_amount_minor
        is distinct from
          p_amount_minor
      or setup_row.provider_requested_amount_minor
        is distinct from
          p_requested_amount_minor
    then
      return jsonb_build_object(
        'status',
        'conflict'
      );
    end if;

    return jsonb_build_object(
      'status',
      'existing',

      'setupId',
      setup_row.id,

      'setupStatus',
      setup_row.status,

      'paymentMethodId',
      setup_row.payment_method_id,

      'providerTransactionId',
      setup_row.provider_transaction_id,

      'refundStatus',
      setup_row.refund_status,

      'providerRefundId',
      setup_row.provider_refund_id
    );
  end if;

  --------------------------------------------------------------------
  -- PROVIDER TRANSACTION CANNOT BELONG TO ANOTHER SETUP
  --------------------------------------------------------------------

  if exists (
    select 1
    from public.payment_method_setups
    where provider =
        cleaned_provider
      and provider_transaction_id =
        cleaned_transaction_id
      and id <>
        setup_row.id
  )
  then
    return jsonb_build_object(
      'status',
      'conflict'
    );
  end if;

  --------------------------------------------------------------------
  -- RECORD THE VERIFIED CHARGE FIRST
  --
  -- Even if later card validation fails, the transaction must remain
  -- recorded so MOVA can refund the money.
  --------------------------------------------------------------------

  update public.payment_method_setups
  set
    provider_transaction_id =
      cleaned_transaction_id,

    provider_amount_minor =
      p_amount_minor,

    provider_requested_amount_minor =
      p_requested_amount_minor,

    provider_paid_at =
      p_paid_at
  where id =
    setup_row.id;

  --------------------------------------------------------------------
  -- TRUSTED FINANCIAL CHECK
  --------------------------------------------------------------------

  if p_requested_amount_minor <>
      setup_row.amount_minor
    or cleaned_currency <>
      setup_row.currency
    or cleaned_channel <>
      'card'
    or p_amount_minor <
      p_requested_amount_minor
  then
    update public.payment_method_setups
    set
      status =
        'failed',

      failure_reason =
        'provider_payment_mismatch'
    where id =
      setup_row.id;

    return jsonb_build_object(
      'status',
      'mismatch',

      'setupId',
      setup_row.id,

      'providerTransactionId',
      cleaned_transaction_id,

      'refundStatus',
      setup_row.refund_status
    );
  end if;

  --------------------------------------------------------------------
  -- CLEAN REUSABLE CARD DATA
  --------------------------------------------------------------------

  cleaned_customer_code :=
    btrim(
      coalesce(
        p_provider_customer_code,
        ''
      )
    );

  cleaned_email :=
    lower(
      btrim(
        coalesce(
          p_provider_email,
          ''
        )
      )
    );

  cleaned_authorization_code :=
    btrim(
      coalesce(
        p_provider_authorization_code,
        ''
      )
    );

  cleaned_signature :=
    btrim(
      coalesce(
        p_provider_signature,
        ''
      )
    );

  cleaned_network :=
    lower(
      btrim(
        coalesce(
          p_network,
          ''
        )
      )
    );

  cleaned_last4 :=
    btrim(
      coalesce(
        p_last4,
        ''
      )
    );

  cleaned_bank :=
    nullif(
      btrim(
        coalesce(
          p_bank,
          ''
        )
      ),
      ''
    );

  cleaned_country_code :=
    nullif(
      upper(
        btrim(
          coalesce(
            p_country_code,
            ''
          )
        )
      ),
      ''
    );

  card_is_usable :=
    p_reusable is true
    and char_length(
      cleaned_customer_code
    ) between 1 and 120
    and char_length(
      cleaned_email
    ) between 3 and 320
    and cleaned_email ~
      '^[^[:space:]@]+@[^[:space:]@]+$'
    and cleaned_email =
      lower(
        setup_row.email
      )
    and char_length(
      cleaned_authorization_code
    ) between 1 and 200
    and char_length(
      cleaned_signature
    ) between 1 and 200
    and char_length(
      cleaned_network
    ) between 1 and 40
    and cleaned_last4 ~
      '^[0-9]{4}$'
    and p_exp_month is not null
    and p_exp_month between
      1 and 12
    and p_exp_year is not null
    and p_exp_year between
      2020 and 2200
    and (
      cleaned_bank is null
      or char_length(
        cleaned_bank
      ) between 1 and 120
    )
    and (
      cleaned_country_code is null
      or cleaned_country_code ~
        '^[A-Z]{2}$'
    );

  --------------------------------------------------------------------
  -- A SUCCESSFUL CHARGE WITHOUT A REUSABLE CARD MUST STILL BE REFUNDED
  --------------------------------------------------------------------

  if card_is_usable is not true
  then
    update public.payment_method_setups
    set
      status =
        'failed',

      failure_reason =
        'card_authorization_unavailable'
    where id =
      setup_row.id;

    return jsonb_build_object(
      'status',
      'card_unavailable',

      'setupId',
      setup_row.id,

      'providerTransactionId',
      cleaned_transaction_id,

      'refundStatus',
      setup_row.refund_status
    );
  end if;

  --------------------------------------------------------------------
  -- SERIALIZE SAVED-CARD CHANGES FOR THIS USER
  --------------------------------------------------------------------

  perform 1
  from public.profiles
  where user_id =
    setup_row.user_id
  for update;

  if not found
  then
    update public.payment_method_setups
    set
      status =
        'failed',

      failure_reason =
        'account_unavailable'
    where id =
      setup_row.id;

    return jsonb_build_object(
      'status',
      'account_unavailable',

      'setupId',
      setup_row.id,

      'providerTransactionId',
      cleaned_transaction_id,

      'refundStatus',
      setup_row.refund_status
    );
  end if;

  --------------------------------------------------------------------
  -- SAME CARD FOR THIS USER
  --------------------------------------------------------------------

  select *
  into existing_method
  from public.payment_methods
  where user_id =
      setup_row.user_id
    and provider =
      cleaned_provider
    and provider_signature =
      cleaned_signature
  for update;

  if found
  then
    select (
      existing_method.is_default
      or not exists (
        select 1
        from public.payment_methods
        where user_id =
            setup_row.user_id
          and id <>
            existing_method.id
          and is_default =
            true
          and disabled_at
            is null
      )
    )
    into make_default;

    select id
    into conflicting_method_id
    from public.payment_methods
    where provider =
        cleaned_provider
      and provider_authorization_code =
        cleaned_authorization_code
      and id <>
        existing_method.id
    limit 1;

    if conflicting_method_id
        is not null
    then
      update public.payment_method_setups
      set
        status =
          'failed',

        failure_reason =
          'authorization_conflict'
      where id =
        setup_row.id;

      return jsonb_build_object(
        'status',
        'card_conflict',

        'setupId',
        setup_row.id,

        'providerTransactionId',
        cleaned_transaction_id,

        'refundStatus',
        setup_row.refund_status
      );
    end if;

    update public.payment_methods
    set
      provider_customer_code =
        cleaned_customer_code,

      provider_email =
        cleaned_email,

      provider_authorization_code =
        cleaned_authorization_code,

      provider_signature =
        cleaned_signature,

      network =
        cleaned_network,

      last4 =
        cleaned_last4,

      exp_month =
        p_exp_month,

      exp_year =
        p_exp_year,

      bank =
        cleaned_bank,

      country_code =
        cleaned_country_code,

      reusable =
        true,

      is_default =
        make_default,

      last_used_at =
        p_paid_at,

      disabled_at =
        null
    where id =
      existing_method.id
    returning id
    into saved_method_id;
  else

    ------------------------------------------------------------------
    -- DEFENSIVE AUTHORIZATION COLLISION CHECK
    ------------------------------------------------------------------

    select id
    into conflicting_method_id
    from public.payment_methods
    where provider =
        cleaned_provider
      and provider_authorization_code =
        cleaned_authorization_code
    limit 1;

    if conflicting_method_id
        is not null
    then
      update public.payment_method_setups
      set
        status =
          'failed',

        failure_reason =
          'authorization_conflict'
      where id =
        setup_row.id;

      return jsonb_build_object(
        'status',
        'card_conflict',

        'setupId',
        setup_row.id,

        'providerTransactionId',
        cleaned_transaction_id,

        'refundStatus',
        setup_row.refund_status
      );
    end if;

    select not exists (
      select 1
      from public.payment_methods
      where user_id =
          setup_row.user_id
        and is_default =
          true
        and disabled_at
          is null
    )
    into make_default;

    insert into public.payment_methods (
      user_id,
      provider,
      provider_customer_code,
      provider_email,
      provider_authorization_code,
      provider_signature,
      network,
      last4,
      exp_month,
      exp_year,
      bank,
      country_code,
      reusable,
      is_default,
      last_used_at
    )
    values (
      setup_row.user_id,
      cleaned_provider,
      cleaned_customer_code,
      cleaned_email,
      cleaned_authorization_code,
      cleaned_signature,
      cleaned_network,
      cleaned_last4,
      p_exp_month,
      p_exp_year,
      cleaned_bank,
      cleaned_country_code,
      true,
      make_default,
      p_paid_at
    )
    returning id
    into saved_method_id;
  end if;

  --------------------------------------------------------------------
  -- COMPLETE SETUP
  --------------------------------------------------------------------

  update public.payment_method_setups
  set
    payment_method_id =
      saved_method_id,

    status =
      'completed',

    failure_reason =
      null,

    completed_at =
      now()
  where id =
    setup_row.id;

  return jsonb_build_object(
    'status',
    'completed',

    'setupId',
    setup_row.id,

    'paymentMethodId',
    saved_method_id,

    'providerTransactionId',
    cleaned_transaction_id,

    'refundStatus',
    setup_row.refund_status
  );
end;
$$;

----------------------------------------------------------------------
-- CLAIM REFUND INITIALIZATION
--
-- This transition happens BEFORE MOVA asks Paystack to create a refund.
--
-- If the HTTP request becomes uncertain, status remains "initiating".
-- A retry must reconcile against Paystack before creating another
-- refund.
----------------------------------------------------------------------

create or replace function
  public.begin_payment_method_setup_refund(
    p_provider_reference text
  )
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  cleaned_reference text;

  setup_row
    public.payment_method_setups%rowtype;
begin
  cleaned_reference :=
    btrim(
      coalesce(
        p_provider_reference,
        ''
      )
    );

  if char_length(
      cleaned_reference
    ) not between 1 and 200
  then
    return jsonb_build_object(
      'status',
      'invalid'
    );
  end if;

  select *
  into setup_row
  from public.payment_method_setups
  where provider =
      'paystack'
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

  if setup_row.provider_transaction_id
      is null
  then
    return jsonb_build_object(
      'status',
      'not_available'
    );
  end if;

  if setup_row.refund_status <>
      'not_requested'
  then
    return jsonb_build_object(
      'status',
      'existing',

      'setupId',
      setup_row.id,

      'refundStatus',
      setup_row.refund_status,

      'providerTransactionId',
      setup_row.provider_transaction_id,

      'providerRefundId',
      setup_row.provider_refund_id
    );
  end if;

  update public.payment_method_setups
  set
    refund_status =
      'initiating',

    refund_requested_at =
      now()
  where id =
    setup_row.id;

  return jsonb_build_object(
    'status',
    'ready',

    'setupId',
    setup_row.id,

    'refundStatus',
    'initiating',

    'providerTransactionId',
    setup_row.provider_transaction_id
  );
end;
$$;

----------------------------------------------------------------------
-- RECORD REFUND STATE
--
-- Used both after Create Refund and after verified Paystack refund
-- webhook events.
--
-- "processed" and "failed" are terminal in MOVA's automatic flow.
----------------------------------------------------------------------

create or replace function
  public.record_payment_method_setup_refund(
    p_provider_reference text,
    p_provider_refund_id text,
    p_refund_status text,
    p_refunded_at timestamptz
  )
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  cleaned_reference text;
  cleaned_refund_id text;
  cleaned_status text;

  setup_row
    public.payment_method_setups%rowtype;

  final_refund_id text;
begin
  cleaned_reference :=
    btrim(
      coalesce(
        p_provider_reference,
        ''
      )
    );

  cleaned_refund_id :=
    nullif(
      btrim(
        coalesce(
          p_provider_refund_id,
          ''
        )
      ),
      ''
    );

  cleaned_status :=
    lower(
      btrim(
        coalesce(
          p_refund_status,
          ''
        )
      )
    );

  if char_length(
      cleaned_reference
    ) not between 1 and 200
    or cleaned_status not in (
      'pending',
      'processing',
      'needs_attention',
      'processed',
      'failed'
    )
    or (
      cleaned_refund_id is not null
      and char_length(
        cleaned_refund_id
      ) not between 1 and 200
    )
  then
    return jsonb_build_object(
      'status',
      'invalid'
    );
  end if;

  select *
  into setup_row
  from public.payment_method_setups
  where provider =
      'paystack'
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

  if setup_row.provider_transaction_id
      is null
  then
    return jsonb_build_object(
      'status',
      'not_available'
    );
  end if;

  --------------------------------------------------------------------
  -- DO NOT SILENTLY CHANGE AN ALREADY BOUND REFUND ID
  --------------------------------------------------------------------

  if setup_row.provider_refund_id
      is not null
    and cleaned_refund_id
      is not null
    and setup_row.provider_refund_id <>
      cleaned_refund_id
  then
    return jsonb_build_object(
      'status',
      'conflict'
    );
  end if;

  final_refund_id :=
    coalesce(
      setup_row.provider_refund_id,
      cleaned_refund_id
    );

  --------------------------------------------------------------------
  -- TERMINAL STATES ARE IDEMPOTENT
  --------------------------------------------------------------------

  if setup_row.refund_status =
      'processed'
    and cleaned_status <>
      'processed'
  then
    return jsonb_build_object(
      'status',
      'existing',

      'setupId',
      setup_row.id,

      'refundStatus',
      setup_row.refund_status,

      'providerRefundId',
      setup_row.provider_refund_id
    );
  end if;

  if setup_row.refund_status =
      'failed'
    and cleaned_status <>
      'failed'
  then
    return jsonb_build_object(
      'status',
      'existing',

      'setupId',
      setup_row.id,

      'refundStatus',
      setup_row.refund_status,

      'providerRefundId',
      setup_row.provider_refund_id
    );
  end if;

  update public.payment_method_setups
  set
    provider_refund_id =
      final_refund_id,

    refund_status =
      cleaned_status,

    refunded_at =
      case
        when cleaned_status =
          'processed'
        then coalesce(
          p_refunded_at,
          now()
        )
        else refunded_at
      end
  where id =
    setup_row.id;

  return jsonb_build_object(
    'status',
    'updated',

    'setupId',
    setup_row.id,

    'refundStatus',
    cleaned_status,

    'providerRefundId',
    final_refund_id
  );
end;
$$;

----------------------------------------------------------------------
-- BACKEND-ONLY ACCESS
----------------------------------------------------------------------

revoke all
on function
  public.complete_payment_method_setup_from_provider(
    text,
    text,
    text,
    integer,
    integer,
    text,
    text,
    timestamptz,
    text,
    text,
    text,
    text,
    text,
    text,
    smallint,
    smallint,
    text,
    text,
    boolean
  )
from public, anon, authenticated;

grant execute
on function
  public.complete_payment_method_setup_from_provider(
    text,
    text,
    text,
    integer,
    integer,
    text,
    text,
    timestamptz,
    text,
    text,
    text,
    text,
    text,
    text,
    smallint,
    smallint,
    text,
    text,
    boolean
  )
to service_role;

revoke all
on function
  public.begin_payment_method_setup_refund(
    text
  )
from public, anon, authenticated;

grant execute
on function
  public.begin_payment_method_setup_refund(
    text
  )
to service_role;

revoke all
on function
  public.record_payment_method_setup_refund(
    text,
    text,
    text,
    timestamptz
  )
from public, anon, authenticated;

grant execute
on function
  public.record_payment_method_setup_refund(
    text,
    text,
    text,
    timestamptz
  )
to service_role;

commit;