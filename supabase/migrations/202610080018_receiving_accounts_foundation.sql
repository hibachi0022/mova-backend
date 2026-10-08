begin;

----------------------------------------------------------------------
-- RECEIVING ACCOUNTS FOUNDATION
--
-- Receiving accounts are destinations for reimbursements and payouts.
--
-- Security principles:
--
--   - MOVA does not persist the customer's full bank account number.
--   - The backend resolves the account with Paystack first.
--   - The backend creates a Paystack transfer recipient.
--   - MOVA stores only the provider recipient code and masked details.
--   - Provider recipient codes are never exposed to the mobile app.
--   - All table/RPC access is service-role only.
--   - Nigeria / NGN is the first supported receiving-account market.
----------------------------------------------------------------------

----------------------------------------------------------------------
-- TEMPORARY ACCOUNT VERIFICATIONS
----------------------------------------------------------------------

create table public.receiving_account_verifications (
  id uuid primary key
    default gen_random_uuid(),

  user_id uuid not null
    references public.profiles(user_id)
    on delete cascade,

  provider text not null
    default 'paystack',

  provider_recipient_code text not null,

  bank_code text not null,

  bank_name text not null,

  account_name text not null,

  last4 text not null,

  country text not null
    default 'NG',

  currency text not null
    default 'NGN',

  status text not null
    default 'pending',

  expires_at timestamptz not null
    default (
      now() +
      interval '15 minutes'
    ),

  consumed_at timestamptz,

  consumed_idempotency_key_hash text,

  receiving_account_id uuid,

  created_at timestamptz not null
    default now(),

  constraint receiving_account_verifications_provider_check
    check (
      provider =
        'paystack'
    ),

  constraint receiving_account_verifications_recipient_check
    check (
      char_length(
        provider_recipient_code
      ) between 3 and 200
    ),

  constraint receiving_account_verifications_bank_code_check
    check (
      char_length(
        bank_code
      ) between 1 and 40
    ),

  constraint receiving_account_verifications_bank_name_check
    check (
      char_length(
        bank_name
      ) between 1 and 160
    ),

  constraint receiving_account_verifications_account_name_check
    check (
      char_length(
        account_name
      ) between 1 and 200
    ),

  constraint receiving_account_verifications_last4_check
    check (
      last4 ~
        '^[0-9]{4}$'
    ),

  constraint receiving_account_verifications_country_check
    check (
      country =
        'NG'
    ),

  constraint receiving_account_verifications_currency_check
    check (
      currency =
        'NGN'
    ),

  constraint receiving_account_verifications_status_check
    check (
      status in (
        'pending',
        'consumed',
        'expired'
      )
    ),

  constraint receiving_account_verifications_consumed_hash_check
    check (
      consumed_idempotency_key_hash
        is null
      or
      consumed_idempotency_key_hash ~
        '^[0-9a-f]{64}$'
    ),

  constraint receiving_account_verifications_consumed_state_check
    check (
      (
        status =
          'consumed'
        and consumed_at
          is not null
        and consumed_idempotency_key_hash
          is not null
        and receiving_account_id
          is not null
      )
      or
      (
        status <>
          'consumed'
        and consumed_at
          is null
        and consumed_idempotency_key_hash
          is null
        and receiving_account_id
          is null
      )
    )
);

create index
  receiving_account_verifications_user_created_idx
on public.receiving_account_verifications (
  user_id,
  created_at desc
);

create index
  receiving_account_verifications_expiry_idx
on public.receiving_account_verifications (
  expires_at
)
where status =
  'pending';

----------------------------------------------------------------------
-- SAVED RECEIVING ACCOUNTS
----------------------------------------------------------------------

create table public.receiving_accounts (
  id uuid primary key
    default gen_random_uuid(),

  user_id uuid not null
    references public.profiles(user_id)
    on delete cascade,

  provider text not null
    default 'paystack',

  provider_recipient_code text not null,

  bank_code text not null,

  bank_name text not null,

  account_name text not null,

  last4 text not null,

  country text not null
    default 'NG',

  currency text not null
    default 'NGN',

  initials text,

  is_default boolean not null
    default false,

  disabled_at timestamptz,

  created_at timestamptz not null
    default now(),

  updated_at timestamptz not null
    default now(),

  constraint receiving_accounts_provider_check
    check (
      provider =
        'paystack'
    ),

  constraint receiving_accounts_recipient_check
    check (
      char_length(
        provider_recipient_code
      ) between 3 and 200
    ),

  constraint receiving_accounts_bank_code_check
    check (
      char_length(
        bank_code
      ) between 1 and 40
    ),

  constraint receiving_accounts_bank_name_check
    check (
      char_length(
        bank_name
      ) between 1 and 160
    ),

  constraint receiving_accounts_account_name_check
    check (
      char_length(
        account_name
      ) between 1 and 200
    ),

  constraint receiving_accounts_last4_check
    check (
      last4 ~
        '^[0-9]{4}$'
    ),

  constraint receiving_accounts_country_check
    check (
      country =
        'NG'
    ),

  constraint receiving_accounts_currency_check
    check (
      currency =
        'NGN'
    ),

  constraint receiving_accounts_initials_check
    check (
      initials is null
      or (
        char_length(
          initials
        ) between 1 and 6
        and initials ~
          '^[[:alpha:]]+$'
      )
    ),

  constraint receiving_accounts_default_active_check
    check (
      is_default is false
      or disabled_at
        is null
    )
);

----------------------------------------------------------------------
-- SAME PROVIDER ACCOUNT IS ONE MOVA ACCOUNT PER USER
--
-- Paystack may return the same recipient code for the same bank account.
-- Another MOVA user may legitimately use that same bank account, so the
-- uniqueness is scoped to user_id.
----------------------------------------------------------------------

create unique index
  receiving_accounts_user_provider_recipient_idx
on public.receiving_accounts (
  user_id,
  provider,
  provider_recipient_code
);

----------------------------------------------------------------------
-- ONLY ONE ACTIVE DEFAULT RECEIVING ACCOUNT PER USER
----------------------------------------------------------------------

create unique index
  receiving_accounts_one_default_idx
on public.receiving_accounts (
  user_id
)
where is_default is true
  and disabled_at is null;

create index
  receiving_accounts_user_active_idx
on public.receiving_accounts (
  user_id,
  created_at desc
)
where disabled_at is null;

----------------------------------------------------------------------
-- FOREIGN KEY FROM VERIFICATION TO SAVED ACCOUNT
----------------------------------------------------------------------

alter table
  public.receiving_account_verifications
add constraint
  receiving_account_verifications_account_fk
foreign key (
  receiving_account_id
)
references public.receiving_accounts(id)
on delete set null;

----------------------------------------------------------------------
-- UPDATED_AT
----------------------------------------------------------------------

create or replace function
  public.touch_receiving_account_updated_at()
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
    public.touch_receiving_account_updated_at()
  from public, anon, authenticated;

create trigger
  receiving_accounts_updated_at
before update
on public.receiving_accounts
for each row
execute function
  public.touch_receiving_account_updated_at();

----------------------------------------------------------------------
-- RECORD A PROVIDER-VERIFIED ACCOUNT
--
-- Called only after the backend has:
--
--   1. resolved the account through Paystack
--   2. obtained the account-holder name
--   3. created/retrieved a Paystack transfer recipient
--
-- No full account number is passed into or stored by this function.
----------------------------------------------------------------------

create or replace function
  public.record_receiving_account_verification(
    p_user_id uuid,
    p_provider_recipient_code text,
    p_bank_code text,
    p_bank_name text,
    p_account_name text,
    p_last4 text
  )
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  verification_id uuid;

  verification_expires_at
    timestamptz;

  cleaned_recipient text;

  cleaned_bank_code text;

  cleaned_bank_name text;

  cleaned_account_name text;
begin
  cleaned_recipient :=
    btrim(
      coalesce(
        p_provider_recipient_code,
        ''
      )
    );

  cleaned_bank_code :=
    btrim(
      coalesce(
        p_bank_code,
        ''
      )
    );

  cleaned_bank_name :=
    btrim(
      coalesce(
        p_bank_name,
        ''
      )
    );

  cleaned_account_name :=
    btrim(
      coalesce(
        p_account_name,
        ''
      )
    );

  if p_user_id is null
    or char_length(
      cleaned_recipient
    ) not between 3 and 200
    or char_length(
      cleaned_bank_code
    ) not between 1 and 40
    or char_length(
      cleaned_bank_name
    ) not between 1 and 160
    or char_length(
      cleaned_account_name
    ) not between 1 and 200
    or p_last4 is null
    or p_last4 !~
      '^[0-9]{4}$'
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
      p_user_id
  ) then
    return jsonb_build_object(
      'status',
      'not_found'
    );
  end if;

  --------------------------------------------------------------------
  -- EXPIRE OLD UNUSED VERIFICATIONS FOR THIS USER
  --------------------------------------------------------------------

  update public.receiving_account_verifications
  set status =
    'expired'
  where user_id =
    p_user_id
    and status =
      'pending'
    and expires_at <=
      now();

  verification_expires_at :=
    now() +
    interval '15 minutes';

  insert into
    public.receiving_account_verifications (
      user_id,
      provider,
      provider_recipient_code,
      bank_code,
      bank_name,
      account_name,
      last4,
      country,
      currency,
      status,
      expires_at
    )
  values (
    p_user_id,
    'paystack',
    cleaned_recipient,
    cleaned_bank_code,
    cleaned_bank_name,
    cleaned_account_name,
    p_last4,
    'NG',
    'NGN',
    'pending',
    verification_expires_at
  )
  returning id
  into verification_id;

  return jsonb_build_object(
    'status',
    'created',

    'verificationId',
    verification_id,

    'accountName',
    cleaned_account_name,

    'bankName',
    cleaned_bank_name,

    'last4',
    p_last4,

    'country',
    'NG',

    'currency',
    'NGN',

    'expiresAt',
    verification_expires_at
  );
end;
$$;

----------------------------------------------------------------------
-- SAVE VERIFIED RECEIVING ACCOUNT
----------------------------------------------------------------------

create or replace function
  public.save_receiving_account(
    p_user_id uuid,
    p_verification_id uuid,
    p_idempotency_key_hash text,
    p_initials text
  )
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  verification_row
    public.receiving_account_verifications%rowtype;

  existing_account
    public.receiving_accounts%rowtype;

  account_id uuid;

  account_is_default boolean;

  cleaned_initials text;
begin
  cleaned_initials :=
    nullif(
      upper(
        btrim(
          coalesce(
            p_initials,
            ''
          )
        )
      ),
      ''
    );

  if p_user_id is null
    or p_verification_id
      is null
    or p_idempotency_key_hash
      is null
    or p_idempotency_key_hash !~
      '^[0-9a-f]{64}$'
    or (
      cleaned_initials is not null
      and (
        char_length(
          cleaned_initials
        ) not between 1 and 6
        or cleaned_initials !~
          '^[[:alpha:]]+$'
      )
    )
  then
    return jsonb_build_object(
      'status',
      'invalid'
    );
  end if;

  select *
  into verification_row
  from public.receiving_account_verifications
  where id =
    p_verification_id
  for update;

  if not found
    or verification_row.user_id <>
      p_user_id
  then
    return jsonb_build_object(
      'status',
      'not_found'
    );
  end if;

  --------------------------------------------------------------------
  -- IDEMPOTENT RETRY AFTER SUCCESSFUL SAVE
  --------------------------------------------------------------------

  if verification_row.status =
      'consumed'
  then
    if verification_row
        .consumed_idempotency_key_hash =
        p_idempotency_key_hash
      and verification_row
        .receiving_account_id
        is not null
    then
      select *
      into existing_account
      from public.receiving_accounts
      where id =
        verification_row
          .receiving_account_id
        and user_id =
          p_user_id;

      if not found then
        return jsonb_build_object(
          'status',
          'not_found'
        );
      end if;

      return jsonb_build_object(
        'status',
        'existing',

        'accountId',
        existing_account.id,

        'bankName',
        existing_account.bank_name,

        'accountName',
        existing_account.account_name,

        'last4',
        existing_account.last4,

        'country',
        existing_account.country,

        'currency',
        existing_account.currency,

        'initials',
        existing_account.initials,

        'isDefault',
        existing_account.is_default
      );
    end if;

    return jsonb_build_object(
      'status',
      'idempotency_conflict'
    );
  end if;

  if verification_row.status =
      'expired'
    or verification_row.expires_at <=
      now()
  then
    if verification_row.status =
        'pending'
    then
      update public.receiving_account_verifications
      set status =
        'expired'
      where id =
        p_verification_id;
    end if;

    return jsonb_build_object(
      'status',
      'expired'
    );
  end if;

  if verification_row.status <>
      'pending'
  then
    return jsonb_build_object(
      'status',
      'not_available'
    );
  end if;

  --------------------------------------------------------------------
  -- REUSE / REACTIVATE AN EXISTING SAVED DESTINATION
  --------------------------------------------------------------------

  select *
  into existing_account
  from public.receiving_accounts
  where user_id =
    p_user_id
    and provider =
      verification_row.provider
    and provider_recipient_code =
      verification_row
        .provider_recipient_code
  for update;

  if found then
    account_is_default :=
      existing_account
        .is_default;

    if existing_account
        .disabled_at
        is not null
    then
      account_is_default :=
        not exists (
          select 1
          from public.receiving_accounts
          where user_id =
            p_user_id
            and disabled_at
              is null
        );
    end if;

    update public.receiving_accounts
    set
      bank_code =
        verification_row.bank_code,

      bank_name =
        verification_row.bank_name,

      account_name =
        verification_row.account_name,

      last4 =
        verification_row.last4,

      country =
        verification_row.country,

      currency =
        verification_row.currency,

      initials =
        cleaned_initials,

      disabled_at =
        null,

      is_default =
        account_is_default
    where id =
      existing_account.id
    returning id
    into account_id;
  else
    account_is_default :=
      not exists (
        select 1
        from public.receiving_accounts
        where user_id =
          p_user_id
          and disabled_at
            is null
      );

    insert into
      public.receiving_accounts (
        user_id,
        provider,
        provider_recipient_code,
        bank_code,
        bank_name,
        account_name,
        last4,
        country,
        currency,
        initials,
        is_default
      )
    values (
      p_user_id,
      verification_row.provider,
      verification_row
        .provider_recipient_code,
      verification_row.bank_code,
      verification_row.bank_name,
      verification_row.account_name,
      verification_row.last4,
      verification_row.country,
      verification_row.currency,
      cleaned_initials,
      account_is_default
    )
    returning id
    into account_id;
  end if;

  update public.receiving_account_verifications
  set
    status =
      'consumed',

    consumed_at =
      now(),

    consumed_idempotency_key_hash =
      p_idempotency_key_hash,

    receiving_account_id =
      account_id
  where id =
    p_verification_id;

  return jsonb_build_object(
    'status',
    'saved',

    'accountId',
    account_id,

    'bankName',
    verification_row.bank_name,

    'accountName',
    verification_row.account_name,

    'last4',
    verification_row.last4,

    'country',
    verification_row.country,

    'currency',
    verification_row.currency,

    'initials',
    cleaned_initials,

    'isDefault',
    account_is_default
  );
end;
$$;

----------------------------------------------------------------------
-- SET DEFAULT RECEIVING ACCOUNT
----------------------------------------------------------------------

create or replace function
  public.set_default_receiving_account(
    p_user_id uuid,
    p_receiving_account_id uuid
  )
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  account_row
    public.receiving_accounts%rowtype;
begin
  if p_user_id is null
    or p_receiving_account_id
      is null
  then
    return jsonb_build_object(
      'status',
      'invalid'
    );
  end if;

  select *
  into account_row
  from public.receiving_accounts
  where id =
    p_receiving_account_id
    and user_id =
      p_user_id
  for update;

  if not found then
    return jsonb_build_object(
      'status',
      'not_found'
    );
  end if;

  if account_row.disabled_at
      is not null
  then
    return jsonb_build_object(
      'status',
      'unavailable'
    );
  end if;

  if account_row.is_default
      is true
  then
    return jsonb_build_object(
      'status',
      'existing',

      'accountId',
      account_row.id
    );
  end if;

  update public.receiving_accounts
  set is_default =
    false
  where user_id =
    p_user_id
    and disabled_at
      is null
    and is_default
      is true;

  update public.receiving_accounts
  set is_default =
    true
  where id =
    account_row.id;

  return jsonb_build_object(
    'status',
    'updated',

    'accountId',
    account_row.id
  );
end;
$$;

----------------------------------------------------------------------
-- REMOVE RECEIVING ACCOUNT
--
-- Soft delete so historical money records can continue referencing it.
-- If the default is removed, promote the most recently updated active
-- account.
----------------------------------------------------------------------

create or replace function
  public.disable_receiving_account(
    p_user_id uuid,
    p_receiving_account_id uuid
  )
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  account_row
    public.receiving_accounts%rowtype;

  replacement_id uuid;
begin
  if p_user_id is null
    or p_receiving_account_id
      is null
  then
    return jsonb_build_object(
      'status',
      'invalid'
    );
  end if;

  select *
  into account_row
  from public.receiving_accounts
  where id =
    p_receiving_account_id
    and user_id =
      p_user_id
  for update;

  if not found then
    return jsonb_build_object(
      'status',
      'not_found'
    );
  end if;

  if account_row.disabled_at
      is not null
  then
    return jsonb_build_object(
      'status',
      'existing',

      'accountId',
      account_row.id
    );
  end if;

  update public.receiving_accounts
  set
    disabled_at =
      now(),

    is_default =
      false
  where id =
    account_row.id;

  if account_row.is_default
      is true
  then
    select id
    into replacement_id
    from public.receiving_accounts
    where user_id =
      p_user_id
      and disabled_at
        is null
    order by
      updated_at desc,
      created_at desc
    limit 1
    for update;

    if replacement_id
        is not null
    then
      update public.receiving_accounts
      set is_default =
        true
      where id =
        replacement_id;
    end if;
  end if;

  return jsonb_build_object(
    'status',
    'disabled',

    'accountId',
    account_row.id,

    'replacementDefaultId',
    replacement_id
  );
end;
$$;

----------------------------------------------------------------------
-- ROW LEVEL SECURITY
----------------------------------------------------------------------

alter table
  public.receiving_account_verifications
enable row level security;

alter table
  public.receiving_accounts
enable row level security;

alter table
  public.receiving_account_verifications
force row level security;

alter table
  public.receiving_accounts
force row level security;

revoke all
  on table
    public.receiving_account_verifications
  from public, anon, authenticated;

revoke all
  on table
    public.receiving_accounts
  from public, anon, authenticated;

grant
  select,
  insert,
  update
on table
  public.receiving_account_verifications
to service_role;

grant
  select,
  insert,
  update
on table
  public.receiving_accounts
to service_role;

----------------------------------------------------------------------
-- RPC PERMISSIONS
----------------------------------------------------------------------

revoke all
  on function
    public.record_receiving_account_verification(
      uuid,
      text,
      text,
      text,
      text,
      text
    )
  from public, anon, authenticated;

revoke all
  on function
    public.save_receiving_account(
      uuid,
      uuid,
      text,
      text
    )
  from public, anon, authenticated;

revoke all
  on function
    public.set_default_receiving_account(
      uuid,
      uuid
    )
  from public, anon, authenticated;

revoke all
  on function
    public.disable_receiving_account(
      uuid,
      uuid
    )
  from public, anon, authenticated;

grant execute
  on function
    public.record_receiving_account_verification(
      uuid,
      text,
      text,
      text,
      text,
      text
    )
  to service_role;

grant execute
  on function
    public.save_receiving_account(
      uuid,
      uuid,
      text,
      text
    )
  to service_role;

grant execute
  on function
    public.set_default_receiving_account(
      uuid,
      uuid
    )
  to service_role;

grant execute
  on function
    public.disable_receiving_account(
      uuid,
      uuid
    )
  to service_role;

commit;