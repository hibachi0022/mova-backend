begin;

----------------------------------------------------------------------
-- FRIEND TRANSFER REVERSAL SAFETY
--
-- Paystack may later reverse a transfer that had previously reached
-- success.
--
-- Valid lifecycle examples:
--
--   pending -> success
--   pending -> failed
--   pending -> reversed
--   success -> reversed
--
-- Invalid terminal mutations remain blocked:
--
--   failed   -> success
--   reversed -> success
--   reversed -> failed
--   failed   -> reversed
--
-- Provider identifiers, amount, currency and event/status agreement
-- must still match before any terminal state transition is accepted.
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

  --------------------------------------------------------------------
  -- INPUT VALIDATION
  --------------------------------------------------------------------

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

  --------------------------------------------------------------------
  -- WEBHOOK EVENT MUST AGREE WITH INDEPENDENT PROVIDER STATUS
  --------------------------------------------------------------------

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

  --------------------------------------------------------------------
  -- FIND AND LOCK MOVA PAYOUT
  --------------------------------------------------------------------

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

  --------------------------------------------------------------------
  -- AUDIT PROVIDER DELIVERY
  --------------------------------------------------------------------

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
  -- PROVIDER IDENTIFIERS MUST REMAIN STABLE
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
  -- FINANCIAL TERMS MUST MATCH MOVA'S TRUSTED PAYOUT
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

  if payout_row.status =
      cleaned_status
    and payout_row.status in (
      'success',
      'failed',
      'reversed'
    )
  then
    if (
      payout_row.provider_transfer_code
        is null
      or payout_row.provider_transfer_code =
        cleaned_transfer_code
    )
    and (
      payout_row.provider_transfer_id
        is null
      or payout_row.provider_transfer_id =
        cleaned_transfer_id
    )
    then
      update public.friend_transfer_payouts
      set
        provider_transfer_code =
          coalesce(
            provider_transfer_code,
            cleaned_transfer_code
          ),

        provider_transfer_id =
          coalesce(
            provider_transfer_id,
            cleaned_transfer_id
          ),

        provider_status =
          cleaned_status
      where id =
        payout_row.id;

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
  -- SUCCESS -> REVERSED
  --
  -- A provider reversal after an earlier successful transfer is valid.
  --
  -- Keep completed_at for audit history and additionally record
  -- reversed_at.
  --------------------------------------------------------------------

  if payout_row.status =
      'success'
    and cleaned_status =
      'reversed'
  then
    update public.friend_transfer_payouts
    set
      status =
        'reversed',

      provider_transfer_code =
        cleaned_transfer_code,

      provider_transfer_id =
        cleaned_transfer_id,

      provider_status =
        'reversed',

      reversed_at =
        coalesce(
          reversed_at,
          now()
        ),

      failure_reason =
        'provider_reversed'
    where id =
      payout_row.id;

    return jsonb_build_object(
      'status',
      'finalized',

      'payoutStatus',
      'reversed',

      'previousPayoutStatus',
      'success',

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
  end if;

  --------------------------------------------------------------------
  -- ALL OTHER TERMINAL-TO-DIFFERENT-TERMINAL CHANGES ARE CONFLICTS
  --------------------------------------------------------------------

  if payout_row.status in (
    'success',
    'failed',
    'reversed'
  )
  then
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
        then coalesce(
          completed_at,
          now()
        )

        else completed_at
      end,

    failed_at =
      case
        when cleaned_status =
          'failed'
        then coalesce(
          failed_at,
          now()
        )

        else failed_at
      end,

    reversed_at =
      case
        when cleaned_status =
          'reversed'
        then coalesce(
          reversed_at,
          now()
        )

        else reversed_at
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
-- BACKEND ONLY
----------------------------------------------------------------------

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