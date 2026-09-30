begin;

----------------------------------------------------------------------
-- SAVED PAYMENT METHODS
--
-- MOVA never stores:
--   - full card numbers
--   - CVV
--   - PIN
--
-- Paystack tokenises a successfully authorised reusable card.
-- MOVA stores only:
--   - Paystack customer reference
--   - Paystack reusable authorization token
--   - masked card metadata
--
-- This table is backend-only. Mobile clients never read provider
-- authorization tokens directly.
----------------------------------------------------------------------

create table public.payment_methods (
  id uuid primary key
    default gen_random_uuid(),

  user_id uuid not null
    references public.profiles(user_id)
    on delete cascade,

  provider text not null
    default 'paystack',

  provider_customer_code text not null,

  provider_authorization_code text not null,

  provider_signature text,

  network text not null,

  last4 text not null,

  exp_month smallint not null,

  exp_year smallint not null,

  bank text,

  country_code text,

  reusable boolean not null
    default true,

  is_default boolean not null
    default false,

  last_used_at timestamptz,

  disabled_at timestamptz,

  created_at timestamptz not null
    default now(),

  updated_at timestamptz not null
    default now(),

  constraint payment_methods_provider_check
    check (
      provider =
        'paystack'
    ),

  constraint payment_methods_customer_code_check
    check (
      char_length(
        provider_customer_code
      ) between 1 and 120
    ),

  constraint payment_methods_authorization_code_check
    check (
      char_length(
        provider_authorization_code
      ) between 1 and 200
    ),

  constraint payment_methods_signature_check
    check (
      provider_signature is null
      or char_length(
        provider_signature
      ) between 1 and 200
    ),

  constraint payment_methods_network_check
    check (
      char_length(
        network
      ) between 1 and 40
    ),

  constraint payment_methods_last4_check
    check (
      last4 ~
        '^[0-9]{4}$'
    ),

  constraint payment_methods_exp_month_check
    check (
      exp_month between
        1 and 12
    ),

  constraint payment_methods_exp_year_check
    check (
      exp_year between
        2020 and 2200
    ),

  constraint payment_methods_bank_check
    check (
      bank is null
      or char_length(
        bank
      ) between 1 and 120
    ),

  constraint payment_methods_country_code_check
    check (
      country_code is null
      or country_code ~
        '^[A-Z]{2}$'
    ),

  constraint payment_methods_reusable_check
    check (
      reusable =
        true
    ),

  constraint payment_methods_disabled_at_check
    check (
      disabled_at is null
      or disabled_at >=
        created_at
    )
);

----------------------------------------------------------------------
-- PROVIDER AUTHORIZATION UNIQUENESS
--
-- A Paystack reusable authorization represents one provider-side
-- payment credential and must never be duplicated in MOVA.
----------------------------------------------------------------------

create unique index
  payment_methods_provider_authorization_idx
on public.payment_methods (
  provider,
  provider_authorization_code
);

----------------------------------------------------------------------
-- ONE ACTIVE DEFAULT METHOD PER USER
----------------------------------------------------------------------

create unique index
  payment_methods_active_default_idx
on public.payment_methods (
  user_id
)
where
  is_default =
    true
  and disabled_at
    is null;

----------------------------------------------------------------------
-- FAST ACCOUNT LOOKUP
----------------------------------------------------------------------

create index
  payment_methods_user_active_idx
on public.payment_methods (
  user_id,
  created_at desc
)
where disabled_at
  is null;

----------------------------------------------------------------------
-- UPDATED_AT
----------------------------------------------------------------------

create or replace function
  public.touch_payment_method_updated_at()
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
  public.touch_payment_method_updated_at()
from public, anon, authenticated;

create trigger
  payment_methods_updated_at
before update
on public.payment_methods
for each row
execute function
  public.touch_payment_method_updated_at();

----------------------------------------------------------------------
-- BACKEND-ONLY ACCESS
--
-- No mobile/browser Supabase client should ever receive the provider
-- authorization code.
--
-- Nest uses the Supabase secret/service role and is responsible for
-- returning only masked safe fields to the app.
----------------------------------------------------------------------

alter table
  public.payment_methods
enable row level security;

alter table
  public.payment_methods
force row level security;

revoke all
on table
  public.payment_methods
from anon, authenticated;

grant
  select,
  insert,
  update,
  delete
on table
  public.payment_methods
to service_role;

commit;