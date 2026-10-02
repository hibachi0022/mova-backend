begin;

----------------------------------------------------------------------
-- SAVED CARD OUTING CHARGES
--
-- A saved Paystack authorization can now be selected for a future
-- outing payment.
--
-- Security principles:
--
--   - the client supplies only the MOVA payment-method ID
--   - the client never receives the Paystack authorization code
--   - amount/currency/payer still come from trusted outing state
--   - the saved card must belong to the selected payer
--   - the saved card must be active and reusable
--   - idempotency remains enforced at the MOVA payment-intent layer
--   - provider reference is bound before Paystack is contacted
----------------------------------------------------------------------

----------------------------------------------------------------------
-- LINK AN OUTING PAYMENT INTENT TO A SAVED PAYMENT METHOD
----------------------------------------------------------------------

alter table public.outing_payment_intents
  add column payment_method_id uuid
    references public.payment_methods(id)
    on delete set null;

alter table public.outing_payment_intents
  add constraint outing_payment_intents_saved_method_check
    check (
      payment_method_id is null
      or method_id = 'card'
    );

create index
  outing_payment_intents_payment_method_idx
on public.outing_payment_intents (
  payment_method_id,
  created_at desc
)
where payment_method_id
  is not null;

----------------------------------------------------------------------
-- PREPARE SAVED-CARD PAYMENT INTENT
--
-- The caller supplies only:
--
--   - authenticated user ID
--   - outing ID
--   - MOVA saved payment-method ID
--   - SHA-256 idempotency-key hash
--
-- The function independently resolves:
--
--   - selected payer
--   - amount
--   - currency
--   - saved-card ownership
--
-- Provider secrets are never returned.
----------------------------------------------------------------------

create or replace function
  public.prepare_outing_saved_card_payment_intent(
    p_user_id uuid,
    p_outing_id uuid,
    p_payment_method_id uuid,
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

  payment_method_row
    public.payment_methods%rowtype;

  existing_intent
    public.outing_payment_intents%rowtype;

  active_intent_id uuid;

  new_intent_id uuid;
  new_expires_at timestamptz;
begin
  if p_user_id is null
    or p_outing_id is null
    or p_payment_method_id is null
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

  if not found
  then
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
    and removed_at
      is null
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
    and removed_at
      is null
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
  -- ONLY THE SELECTED PAYER MAY CHARGE THEIR SAVED CARD
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
  --
  -- Check this before checking current saved-card availability.
  --
  -- If the same payment attempt already progressed to the provider,
  -- it must remain recoverable even if the card is later disabled.
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

  if found
  then
    if existing_intent.method_id <>
        'card'
      or existing_intent.payment_method_id
        is distinct from
          p_payment_method_id
      or existing_intent.selected_member_id
        is distinct from
          outing_row.selected_member_id
      or existing_intent.amount_minor <>
        outing_row.amount_minor
      or existing_intent.currency <>
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

      'paymentMethodId',
      existing_intent.payment_method_id,

      'provider',
      existing_intent.provider,

      'providerReference',
      existing_intent.provider_reference,

      'expiresAt',
      existing_intent.expires_at
    );
  end if;

  --------------------------------------------------------------------
  -- OUTING CANNOT BE PAID TWICE
  --------------------------------------------------------------------

  if exists (
    select 1
    from public.outing_payment_intents
    where outing_id =
        p_outing_id
      and status =
        'completed'
  )
  then
    return jsonb_build_object(
      'status',
      'already_paid'
    );
  end if;

  --------------------------------------------------------------------
  -- PREVENT ANOTHER PAYMENT DURING OPEN RECONCILIATION
  --------------------------------------------------------------------

  if exists (
    select 1
    from public.outing_payment_intents
    where outing_id =
        p_outing_id
      and reconciliation_state =
        'required'
  )
  then
    return jsonb_build_object(
      'status',
      'reconciliation_required'
    );
  end if;

  --------------------------------------------------------------------
  -- VALIDATE THE SAVED PAYMENT METHOD
  --------------------------------------------------------------------

  select *
  into payment_method_row
  from public.payment_methods
  where id =
      p_payment_method_id
    and user_id =
      p_user_id
  for update;

  if not found
  then
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

  --------------------------------------------------------------------
  -- EXPIRED CARD CANNOT START A NEW CHARGE
  --
  -- Card expiry is interpreted as valid through the final day of the
  -- stored expiry month.
  --------------------------------------------------------------------

  if make_date(
      payment_method_row.exp_year,
      payment_method_row.exp_month,
      1
    ) +
      interval '1 month' <=
      current_date
  then
    return jsonb_build_object(
      'status',
      'payment_method_expired'
    );
  end if;

  --------------------------------------------------------------------
  -- PREVENT TWO LIVE PAYMENT FLOWS FOR THE SAME OUTING
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
    payment_method_id,
    status,
    idempotency_key_hash,
    save_payment_method,
    expires_at
  )
  values (
    p_outing_id,
    outing_row.selected_member_id,
    p_user_id,
    outing_row.amount_minor,
    outing_row.currency,
    'card',
    p_payment_method_id,
    'created',
    p_idempotency_key_hash,
    false,
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
    'card',

    'paymentMethodId',
    p_payment_method_id,

    'expiresAt',
    new_expires_at
  );
end;
$$;

----------------------------------------------------------------------
-- BIND SAVED-CARD INTENT TO PAYSTACK BEFORE CHARGING
--
-- The backend creates a deterministic provider reference from the
-- MOVA intent ID, then calls this function BEFORE sending the charge
-- request to Paystack.
--
-- This is important because a Paystack webhook may arrive before the
-- HTTP charge request returns.
----------------------------------------------------------------------

create or replace function
  public.begin_outing_saved_card_charge(
    p_user_id uuid,
    p_intent_id uuid,
    p_payment_method_id uuid,
    p_provider_reference text
  )
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  intent_row
    public.outing_payment_intents%rowtype;

  payment_method_row
    public.payment_methods%rowtype;

  cleaned_reference text;
begin
  cleaned_reference :=
    btrim(
      coalesce(
        p_provider_reference,
        ''
      )
    );

  if p_user_id is null
    or p_intent_id is null
    or p_payment_method_id
      is null
    or char_length(
      cleaned_reference
    ) not between 1 and 200
    or cleaned_reference !~
      '^[A-Za-z0-9.=_-]+$'
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

  if intent_row.payment_method_id
      is distinct from
        p_payment_method_id
    or intent_row.method_id <>
      'card'
  then
    return jsonb_build_object(
      'status',
      'conflict'
    );
  end if;

  --------------------------------------------------------------------
  -- IDEMPOTENT RETRY AFTER THE PROVIDER REFERENCE WAS BOUND
  --------------------------------------------------------------------

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

        'paymentStatus',
        intent_row.status,

        'amountMinor',
        intent_row.amount_minor,

        'currency',
        intent_row.currency,

        'paymentMethodId',
        intent_row.payment_method_id,

        'providerReference',
        intent_row.provider_reference
      );
    end if;

    return jsonb_build_object(
      'status',
      'conflict'
    );
  end if;

  if intent_row.status =
      'completed'
  then
    return jsonb_build_object(
      'status',
      'already_completed',

      'intentId',
      intent_row.id,

      'providerReference',
      intent_row.provider_reference
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
      intent_row.id;

    return jsonb_build_object(
      'status',
      'expired'
    );
  end if;

  --------------------------------------------------------------------
  -- RECHECK THE SAVED CARD IMMEDIATELY BEFORE PROVIDER CHARGE
  --------------------------------------------------------------------

  select *
  into payment_method_row
  from public.payment_methods
  where id =
      p_payment_method_id
    and user_id =
      p_user_id
  for update;

  if not found
  then
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

  if make_date(
      payment_method_row.exp_year,
      payment_method_row.exp_month,
      1
    ) +
      interval '1 month' <=
      current_date
  then
    return jsonb_build_object(
      'status',
      'payment_method_expired'
    );
  end if;

  --------------------------------------------------------------------
  -- BIND PROVIDER REFERENCE BEFORE PAYSTACK IS CONTACTED
  --------------------------------------------------------------------

  update public.outing_payment_intents
  set
    provider =
      'paystack',

    provider_reference =
      cleaned_reference,

    provider_requested_amount_minor =
      amount_minor,

    status =
      'processing'
  where id =
    intent_row.id;

  return jsonb_build_object(
    'status',
    'ready',

    'intentId',
    intent_row.id,

    'paymentStatus',
    'processing',

    'amountMinor',
    intent_row.amount_minor,

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
-- MARK A DEFINITIVELY DECLINED SAVED-CARD CHARGE AS FAILED
--
-- Use this only when Paystack explicitly returns a terminal failed
-- charge result.
--
-- Do NOT call this after a timeout or uncertain network error. In that
-- situation MOVA keeps the payment processing so the provider
-- reference can be verified safely instead of risking a double charge.
----------------------------------------------------------------------

create or replace function
  public.fail_outing_saved_card_charge(
    p_user_id uuid,
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
    public.outing_payment_intents%rowtype;

  cleaned_reference text;
begin
  cleaned_reference :=
    btrim(
      coalesce(
        p_provider_reference,
        ''
      )
    );

  if p_user_id is null
    or p_intent_id is null
    or char_length(
      cleaned_reference
    ) not between 1 and 200
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

  if intent_row.status =
      'completed'
  then
    return jsonb_build_object(
      'status',
      'already_completed'
    );
  end if;

  if intent_row.provider <>
      'paystack'
    or intent_row.provider_reference <>
      cleaned_reference
  then
    return jsonb_build_object(
      'status',
      'conflict'
    );
  end if;

  if intent_row.reconciliation_state =
      'required'
    or intent_row.provider_transaction_id
      is not null
  then
    return jsonb_build_object(
      'status',
      'not_available'
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
  then
    return jsonb_build_object(
      'status',
      'not_available'
    );
  end if;

  update public.outing_payment_intents
  set status =
    'failed'
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
-- BACKEND-ONLY ACCESS
----------------------------------------------------------------------

revoke all
on function
  public.prepare_outing_saved_card_payment_intent(
    uuid,
    uuid,
    uuid,
    text
  )
from public, anon, authenticated;

grant execute
on function
  public.prepare_outing_saved_card_payment_intent(
    uuid,
    uuid,
    uuid,
    text
  )
to service_role;

revoke all
on function
  public.begin_outing_saved_card_charge(
    uuid,
    uuid,
    uuid,
    text
  )
from public, anon, authenticated;

grant execute
on function
  public.begin_outing_saved_card_charge(
    uuid,
    uuid,
    uuid,
    text
  )
to service_role;

revoke all
on function
  public.fail_outing_saved_card_charge(
    uuid,
    uuid,
    text
  )
from public, anon, authenticated;

grant execute
on function
  public.fail_outing_saved_card_charge(
    uuid,
    uuid,
    text
  )
to service_role;

commit;