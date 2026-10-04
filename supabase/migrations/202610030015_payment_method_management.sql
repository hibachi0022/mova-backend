begin;

----------------------------------------------------------------------
-- PAYMENT METHOD MANAGEMENT
--
-- Allows the authenticated MOVA backend to:
--
--   1. make one active saved card the user's default
--   2. disable/remove a saved card without deleting historical records
--
-- Provider authorization data remains backend-only.
----------------------------------------------------------------------

----------------------------------------------------------------------
-- SET DEFAULT PAYMENT METHOD
----------------------------------------------------------------------

create or replace function
  public.set_default_payment_method(
    p_user_id uuid,
    p_payment_method_id uuid
  )
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  method_row
    public.payment_methods%rowtype;
begin
  if p_user_id is null
    or p_payment_method_id
      is null
  then
    return jsonb_build_object(
      'status',
      'invalid'
    );
  end if;

  --------------------------------------------------------------------
  -- SERIALIZE PAYMENT-METHOD MANAGEMENT FOR THIS USER
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
  -- LOAD AND LOCK TARGET CARD
  --------------------------------------------------------------------

  select *
  into method_row
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
      'not_found'
    );
  end if;

  if method_row.disabled_at
      is not null
    or method_row.reusable
      is not true
  then
    return jsonb_build_object(
      'status',
      'unavailable'
    );
  end if;

  if method_row.is_default
      is true
  then
    return jsonb_build_object(
      'status',
      'existing',

      'paymentMethodId',
      method_row.id
    );
  end if;

  --------------------------------------------------------------------
  -- CLEAR OLD DEFAULT FIRST
  --
  -- The partial unique index guarantees only one active default.
  --------------------------------------------------------------------

  update public.payment_methods
  set is_default =
    false
  where user_id =
      p_user_id
    and disabled_at
      is null
    and is_default
      is true;

  --------------------------------------------------------------------
  -- SET NEW DEFAULT
  --------------------------------------------------------------------

  update public.payment_methods
  set is_default =
    true
  where id =
      p_payment_method_id
    and user_id =
      p_user_id
    and disabled_at
      is null;

  return jsonb_build_object(
    'status',
    'updated',

    'paymentMethodId',
    p_payment_method_id
  );
end;
$$;

----------------------------------------------------------------------
-- DISABLE / REMOVE PAYMENT METHOD
--
-- We do not delete the database row because completed payments and
-- historical audit trails may reference the saved payment-method ID.
--
-- If the removed card was the default, the most recently used active
-- card becomes the replacement default. If no other card exists, the
-- user simply has no default card.
----------------------------------------------------------------------

create or replace function
  public.disable_payment_method(
    p_user_id uuid,
    p_payment_method_id uuid
  )
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  method_row
    public.payment_methods%rowtype;

  replacement_id uuid;
begin
  if p_user_id is null
    or p_payment_method_id
      is null
  then
    return jsonb_build_object(
      'status',
      'invalid'
    );
  end if;

  --------------------------------------------------------------------
  -- SERIALIZE PAYMENT-METHOD MANAGEMENT FOR THIS USER
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
  -- LOAD AND LOCK TARGET CARD
  --------------------------------------------------------------------

  select *
  into method_row
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
      'not_found'
    );
  end if;

  --------------------------------------------------------------------
  -- IDEMPOTENT REMOVE
  --------------------------------------------------------------------

  if method_row.disabled_at
      is not null
  then
    return jsonb_build_object(
      'status',
      'existing',

      'paymentMethodId',
      method_row.id
    );
  end if;

  --------------------------------------------------------------------
  -- DISABLE WITHOUT DELETING HISTORY
  --------------------------------------------------------------------

  update public.payment_methods
  set
    disabled_at =
      now(),

    is_default =
      false
  where id =
    method_row.id;

  --------------------------------------------------------------------
  -- IF THIS WAS THE DEFAULT CARD, PROMOTE ANOTHER ACTIVE CARD
  --------------------------------------------------------------------

  if method_row.is_default
      is true
  then
    select id
    into replacement_id
    from public.payment_methods
    where user_id =
        p_user_id
      and disabled_at
        is null
      and id <>
        method_row.id
    order by
      last_used_at desc
        nulls last,
      created_at desc
    limit 1
    for update;

    if replacement_id
        is not null
    then
      update public.payment_methods
      set is_default =
        true
      where id =
        replacement_id;
    end if;
  end if;

  return jsonb_build_object(
    'status',
    'disabled',

    'paymentMethodId',
    method_row.id,

    'replacementDefaultId',
    replacement_id
  );
end;
$$;

----------------------------------------------------------------------
-- BACKEND-ONLY ACCESS
----------------------------------------------------------------------

revoke all
on function
  public.set_default_payment_method(
    uuid,
    uuid
  )
from public, anon, authenticated;

grant execute
on function
  public.set_default_payment_method(
    uuid,
    uuid
  )
to service_role;

revoke all
on function
  public.disable_payment_method(
    uuid,
    uuid
  )
from public, anon, authenticated;

grant execute
on function
  public.disable_payment_method(
    uuid,
    uuid
  )
to service_role;

commit;