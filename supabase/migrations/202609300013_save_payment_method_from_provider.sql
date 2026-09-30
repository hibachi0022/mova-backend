begin;

----------------------------------------------------------------------
-- SAVE VERIFIED PROVIDER PAYMENT METHOD
--
-- Called only by the MOVA backend after:
--
--   1. Paystack webhook signature verification
--   2. Paystack Verify Transaction
--   3. MOVA payment settlement
--
-- The function independently enforces:
--
--   - payment belongs to a completed MOVA outing payment
--   - payment used the card channel
--   - payer explicitly consented to saving the card
--   - payer still exists
--   - reusable provider authorization details are valid
--
-- No client-supplied user ID is accepted.
----------------------------------------------------------------------

create or replace function
  public.save_outing_payment_method_from_provider(
    p_provider text,
    p_provider_reference text,
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
    p_paid_at timestamptz
  )
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  cleaned_provider text;
  cleaned_reference text;
  cleaned_customer_code text;
  cleaned_email text;
  cleaned_authorization_code text;
  cleaned_signature text;
  cleaned_network text;
  cleaned_last4 text;
  cleaned_bank text;
  cleaned_country_code text;

  intent_row
    public.outing_payment_intents%rowtype;

  existing_method
    public.payment_methods%rowtype;

  conflicting_method_id uuid;

  saved_method_id uuid;

  make_default boolean;
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

  --------------------------------------------------------------------
  -- PROVIDER DATA VALIDATION
  --------------------------------------------------------------------

  if cleaned_provider <>
      'paystack'
    or char_length(
      cleaned_reference
    ) not between 1 and 200
    or char_length(
      cleaned_customer_code
    ) not between 1 and 120
    or char_length(
      cleaned_email
    ) not between 3 and 320
    or cleaned_email !~
      '^[^[:space:]@]+@[^[:space:]@]+$'
    or char_length(
      cleaned_authorization_code
    ) not between 1 and 200
    or char_length(
      cleaned_signature
    ) not between 1 and 200
    or char_length(
      cleaned_network
    ) not between 1 and 40
    or cleaned_last4 !~
      '^[0-9]{4}$'
    or p_exp_month is null
    or p_exp_month not between
      1 and 12
    or p_exp_year is null
    or p_exp_year not between
      2020 and 2200
    or (
      cleaned_bank is not null
      and char_length(
        cleaned_bank
      ) not between 1 and 120
    )
    or (
      cleaned_country_code is not null
      and cleaned_country_code !~
        '^[A-Z]{2}$'
    )
    or p_paid_at is null
  then
    return jsonb_build_object(
      'status',
      'invalid'
    );
  end if;

  --------------------------------------------------------------------
  -- LOAD THE TRUSTED MOVA PAYMENT INTENT
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
  -- CARD SAVING IS ALLOWED ONLY FOR A COMPLETED CARD PAYMENT
  --------------------------------------------------------------------

  if intent_row.status <>
      'completed'
    or intent_row.reconciliation_state =
      'required'
    or intent_row.method_id <>
      'card'
    or intent_row.provider_channel <>
      'card'
    or intent_row.payer_user_id
      is null
  then
    return jsonb_build_object(
      'status',
      'not_eligible'
    );
  end if;

  --------------------------------------------------------------------
  -- EXPLICIT USER CONSENT IS REQUIRED
  --------------------------------------------------------------------

  if intent_row.save_payment_method
      is not true
  then
    return jsonb_build_object(
      'status',
      'not_requested'
    );
  end if;

  --------------------------------------------------------------------
  -- SERIALIZE SAVED-CARD CHANGES FOR THIS USER
  --
  -- This prevents two simultaneous successful payments from both
  -- attempting to become the first default card.
  --------------------------------------------------------------------

  perform 1
  from public.profiles
  where user_id =
    intent_row.payer_user_id
  for update;

  if not found
  then
    return jsonb_build_object(
      'status',
      'not_found'
    );
  end if;

  --------------------------------------------------------------------
  -- LOOK FOR THE SAME CARD BY PAYSTACK'S STABLE SIGNATURE
  --------------------------------------------------------------------

  select *
  into existing_method
  from public.payment_methods
  where user_id =
      intent_row.payer_user_id
    and provider =
      cleaned_provider
    and provider_signature =
      cleaned_signature
  for update;

  if found
  then
    ------------------------------------------------------------------
    -- The card already exists.
    --
    -- Paystack can issue a new authorization code for the same card,
    -- so refresh the provider authorization and masked metadata.
    ------------------------------------------------------------------

    select (
      existing_method.is_default
      or not exists (
        select 1
        from public.payment_methods
        where user_id =
            intent_row.payer_user_id
          and id <>
            existing_method.id
          and is_default =
            true
          and disabled_at
            is null
      )
    )
    into make_default;

    ------------------------------------------------------------------
    -- Do not allow an authorization code already belonging to another
    -- stored credential to be silently reassigned.
    ------------------------------------------------------------------

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
      return jsonb_build_object(
        'status',
        'conflict'
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

    return jsonb_build_object(
      'status',
      'updated',
      'methodId',
      saved_method_id
    );
  end if;

  --------------------------------------------------------------------
  -- DEFENSIVE AUTHORIZATION-CODE COLLISION CHECK
  --------------------------------------------------------------------

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
    return jsonb_build_object(
      'status',
      'conflict'
    );
  end if;

  --------------------------------------------------------------------
  -- FIRST ACTIVE SAVED CARD BECOMES DEFAULT
  --------------------------------------------------------------------

  select not exists (
    select 1
    from public.payment_methods
    where user_id =
        intent_row.payer_user_id
      and is_default =
        true
      and disabled_at
        is null
  )
  into make_default;

  --------------------------------------------------------------------
  -- SAVE REUSABLE PAYMENT METHOD
  --------------------------------------------------------------------

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
    intent_row.payer_user_id,
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

  return jsonb_build_object(
    'status',
    'saved',
    'methodId',
    saved_method_id
  );
end;
$$;

----------------------------------------------------------------------
-- BACKEND ONLY
----------------------------------------------------------------------

revoke all
on function
  public.save_outing_payment_method_from_provider(
    text,
    text,
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
    timestamptz
  )
from public, anon, authenticated;

grant execute
on function
  public.save_outing_payment_method_from_provider(
    text,
    text,
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
    timestamptz
  )
to service_role;

commit;