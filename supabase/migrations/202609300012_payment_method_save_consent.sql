begin;

----------------------------------------------------------------------
-- PAYMENT METHOD SAVE CONSENT
--
-- A successful card payment must NOT automatically become a saved
-- payment method.
--
-- The selected payer must explicitly choose to save the card before
-- secure checkout begins.
--
-- Default FALSE preserves all existing payment behaviour.
----------------------------------------------------------------------

alter table public.outing_payment_intents
  add column save_payment_method boolean
  not null
  default false;

----------------------------------------------------------------------
-- CONSENT UPDATE FUNCTION
--
-- This is called only by the authenticated backend after the normal
-- prepare_outing_payment_intent function has returned the payment
-- intent belonging to the selected payer.
--
-- Consent may only be changed while the intent is still in the
-- pre-payment "created" state.
----------------------------------------------------------------------

create or replace function
  public.set_outing_payment_method_save_consent(
    p_user_id uuid,
    p_intent_id uuid,
    p_save_payment_method boolean
  )
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  intent_row
    public.outing_payment_intents%rowtype;
begin
  if p_user_id is null
    or p_intent_id is null
    or p_save_payment_method is null
  then
    return jsonb_build_object(
      'status',
      'invalid'
    );
  end if;

  --------------------------------------------------------------------
  -- LOCK THE PAYMENT INTENT
  --------------------------------------------------------------------

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
  -- CONSENT CAN ONLY CHANGE BEFORE PROVIDER CHECKOUT IS ATTACHED
  --
  -- Once checkout has started, we freeze the user's choice.
  --------------------------------------------------------------------

  if intent_row.status <>
      'created'
  then
    if intent_row.save_payment_method =
        p_save_payment_method
    then
      return jsonb_build_object(
        'status',
        'existing',
        'intentId',
        intent_row.id,
        'savePaymentMethod',
        intent_row.save_payment_method
      );
    end if;

    return jsonb_build_object(
      'status',
      'locked',
      'intentId',
      intent_row.id,
      'savePaymentMethod',
      intent_row.save_payment_method
    );
  end if;

  --------------------------------------------------------------------
  -- STORE EXPLICIT USER CHOICE
  --------------------------------------------------------------------

  update public.outing_payment_intents
  set save_payment_method =
    p_save_payment_method
  where id =
    p_intent_id;

  return jsonb_build_object(
    'status',
    'updated',
    'intentId',
    p_intent_id,
    'savePaymentMethod',
    p_save_payment_method
  );
end;
$$;

----------------------------------------------------------------------
-- BACKEND-ONLY
----------------------------------------------------------------------

revoke all
on function
  public.set_outing_payment_method_save_consent(
    uuid,
    uuid,
    boolean
  )
from public, anon, authenticated;

grant execute
on function
  public.set_outing_payment_method_save_consent(
    uuid,
    uuid,
    boolean
  )
to service_role;

commit;