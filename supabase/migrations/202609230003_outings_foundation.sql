begin;

----------------------------------------------------------------------
-- OUTINGS
----------------------------------------------------------------------

create table public.outings (
  id uuid primary key
    default gen_random_uuid(),

  created_by_user_id uuid
    references public.profiles(user_id)
    on delete set null,

  title text not null,

  location text not null,

  starts_at timestamptz not null,

  currency text not null,

  amount_minor bigint not null
    default 0,

  status text not null
    default 'active',

  created_at timestamptz not null
    default now(),

  updated_at timestamptz not null
    default now(),

  constraint outings_title_check
    check (
      char_length(
        btrim(title)
      ) between 1 and 80
    ),

  constraint outings_location_check
    check (
      char_length(
        btrim(location)
      ) between 1 and 160
    ),

  constraint outings_currency_check
    check (
      currency =
        upper(currency)
      and currency ~
        '^[A-Z]{3}$'
    ),

  constraint outings_amount_minor_check
    check (
      amount_minor >= 0
      and amount_minor <=
        9007199254740991
    ),

  constraint outings_status_check
    check (
      status in (
        'draft',
        'active',
        'completed',
        'cancelled'
      )
    )
);

create index outings_creator_idx
  on public.outings (
    created_by_user_id,
    created_at desc
  );

create index outings_status_starts_at_idx
  on public.outings (
    status,
    starts_at
  );

----------------------------------------------------------------------
-- OUTING MEMBERS
--
-- A member can be:
--
--   1. A registered MOVA user
--   2. A guest added by name
--
-- Never both at the same time.
----------------------------------------------------------------------

create table public.outing_members (
  id uuid primary key
    default gen_random_uuid(),

  outing_id uuid not null
    references public.outings(id)
    on delete cascade,

  user_id uuid
    references public.profiles(user_id)
    on delete cascade,

  guest_display_name text,

  role text not null
    default 'member',

  opted_in boolean not null
    default false,

  opted_in_at timestamptz,

  added_by_user_id uuid
    references public.profiles(user_id)
    on delete set null,

  joined_at timestamptz not null
    default now(),

  removed_at timestamptz,

  constraint outing_members_identity_check
    check (
      (
        user_id is not null
        and
        guest_display_name is null
      )
      or
      (
        user_id is null
        and
        guest_display_name is not null
      )
    ),

  constraint outing_members_guest_name_check
    check (
      guest_display_name is null
      or
      char_length(
        btrim(
          guest_display_name
        )
      ) between 2 and 50
    ),

  constraint outing_members_role_check
    check (
      role in (
        'owner',
        'admin',
        'member'
      )
    ),

  constraint outing_members_owner_user_check
    check (
      role <> 'owner'
      or
      user_id is not null
    ),

  constraint outing_members_opt_in_check
    check (
      (
        opted_in = false
        and
        opted_in_at is null
      )
      or
      (
        opted_in = true
        and
        opted_in_at is not null
      )
    )
);

----------------------------------------------------------------------
-- A registered user can only have one active membership per outing.
----------------------------------------------------------------------

create unique index outing_members_active_user_unique_idx
  on public.outing_members (
    outing_id,
    user_id
  )
  where
    user_id is not null
    and removed_at is null;

----------------------------------------------------------------------
-- An outing can only have one active owner.
----------------------------------------------------------------------

create unique index outing_members_active_owner_unique_idx
  on public.outing_members (
    outing_id
  )
  where
    role = 'owner'
    and removed_at is null;

create index outing_members_outing_idx
  on public.outing_members (
    outing_id,
    joined_at
  )
  where removed_at is null;

create index outing_members_user_idx
  on public.outing_members (
    user_id,
    joined_at desc
  )
  where
    user_id is not null
    and removed_at is null;

----------------------------------------------------------------------
-- SELECTED PAYER
--
-- The selected payer references an outing-member row.
----------------------------------------------------------------------

alter table public.outings
  add column selected_member_id uuid
    references public.outing_members(id)
    on delete set null;

----------------------------------------------------------------------
-- Ensure the selected member actually belongs to the same outing.
----------------------------------------------------------------------

create or replace function public.validate_outing_selected_member()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.selected_member_id
      is null then
    return new;
  end if;

  if not exists (
    select 1
    from public.outing_members
    where id =
      new.selected_member_id
      and outing_id =
        new.id
      and removed_at is null
  ) then
    raise exception
      'Selected member must be an active member of this outing.'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all
  on function public.validate_outing_selected_member()
  from public, anon, authenticated;

create trigger outings_validate_selected_member
  before insert
  or update of selected_member_id
  on public.outings
  for each row
  execute function
    public.validate_outing_selected_member();

----------------------------------------------------------------------
-- DIRECT OUTING INVITATIONS
--
-- These represent invitations sent to a specific MOVA user.
----------------------------------------------------------------------

create table public.outing_invitations (
  id uuid primary key
    default gen_random_uuid(),

  outing_id uuid not null
    references public.outings(id)
    on delete cascade,

  invited_by_user_id uuid
    references public.profiles(user_id)
    on delete set null,

  invitee_user_id uuid not null
    references public.profiles(user_id)
    on delete cascade,

  status text not null
    default 'pending',

  created_at timestamptz not null
    default now(),

  expires_at timestamptz not null
    default (
      now() +
      interval '7 days'
    ),

  responded_at timestamptz,

  constraint outing_invitations_status_check
    check (
      status in (
        'pending',
        'accepted',
        'declined',
        'cancelled'
      )
    ),

  constraint outing_invitations_not_self_check
    check (
      invited_by_user_id is null
      or
      invited_by_user_id <>
        invitee_user_id
    ),

  constraint outing_invitations_expiry_check
    check (
      expires_at >
        created_at
    )
);

----------------------------------------------------------------------
-- Only one pending direct invitation for a user in an outing.
----------------------------------------------------------------------

create unique index outing_invitations_pending_unique_idx
  on public.outing_invitations (
    outing_id,
    invitee_user_id
  )
  where status = 'pending';

create index outing_invitations_invitee_idx
  on public.outing_invitations (
    invitee_user_id,
    created_at desc
  );

create index outing_invitations_outing_idx
  on public.outing_invitations (
    outing_id,
    created_at desc
  );

----------------------------------------------------------------------
-- SHAREABLE JOIN CODES
--
-- We do NOT store the raw invitation code.
--
-- The backend will:
--
--   generate random code
--   return raw code once
--   hash it using SHA-256
--   store only code_hash
--
-- If the database were exposed, active invitation codes would therefore
-- not be directly readable.
----------------------------------------------------------------------

create table public.outing_join_codes (
  id uuid primary key
    default gen_random_uuid(),

  outing_id uuid not null
    references public.outings(id)
    on delete cascade,

  created_by_user_id uuid
    references public.profiles(user_id)
    on delete set null,

  code_hash text not null,

  code_hint text,

  expires_at timestamptz not null
    default (
      now() +
      interval '24 hours'
    ),

  max_uses integer,

  use_count integer not null
    default 0,

  revoked_at timestamptz,

  created_at timestamptz not null
    default now(),

  constraint outing_join_codes_hash_check
    check (
      code_hash ~
        '^[0-9a-f]{64}$'
    ),

  constraint outing_join_codes_hint_check
    check (
      code_hint is null
      or
      char_length(
        code_hint
      ) between 2 and 8
    ),

  constraint outing_join_codes_expiry_check
    check (
      expires_at >
        created_at
    ),

  constraint outing_join_codes_max_uses_check
    check (
      max_uses is null
      or
      max_uses between
        1 and 1000
    ),

  constraint outing_join_codes_use_count_check
    check (
      use_count >= 0
      and
      (
        max_uses is null
        or
        use_count <=
          max_uses
      )
    )
);

create unique index outing_join_codes_hash_unique_idx
  on public.outing_join_codes (
    code_hash
  );

create index outing_join_codes_outing_idx
  on public.outing_join_codes (
    outing_id,
    created_at desc
  );

----------------------------------------------------------------------
-- UPDATED_AT
----------------------------------------------------------------------

create or replace function public.set_outing_updated_at()
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
  on function public.set_outing_updated_at()
  from public, anon, authenticated;

create trigger outings_set_updated_at
  before update
  on public.outings
  for each row
  execute function
    public.set_outing_updated_at();

----------------------------------------------------------------------
-- CREATOR AUTOMATICALLY BECOMES OWNER
--
-- Creating an outing and creating its owner membership therefore happen
-- inside the same database transaction.
----------------------------------------------------------------------

create or replace function public.handle_new_outing_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.created_by_user_id
      is null then
    raise exception
      'An outing must have a creator.'
      using errcode = '23502';
  end if;

  insert into public.outing_members (
    outing_id,
    user_id,
    role,
    opted_in,
    added_by_user_id
  )
  values (
    new.id,
    new.created_by_user_id,
    'owner',
    false,
    new.created_by_user_id
  );

  return new;
end;
$$;

revoke all
  on function public.handle_new_outing_owner()
  from public, anon, authenticated;

create trigger on_outing_created
  after insert
  on public.outings
  for each row
  execute function
    public.handle_new_outing_owner();

----------------------------------------------------------------------
-- BACKEND-ONLY ACCESS
--
-- The mobile application never receives direct table permissions.
-- All access will go through the Nest backend.
----------------------------------------------------------------------

alter table public.outings
  enable row level security;

alter table public.outing_members
  enable row level security;

alter table public.outing_invitations
  enable row level security;

alter table public.outing_join_codes
  enable row level security;

revoke all
  on table public.outings
  from public, anon, authenticated;

revoke all
  on table public.outing_members
  from public, anon, authenticated;

revoke all
  on table public.outing_invitations
  from public, anon, authenticated;

revoke all
  on table public.outing_join_codes
  from public, anon, authenticated;

grant select, insert, update, delete
  on table public.outings
  to service_role;

grant select, insert, update, delete
  on table public.outing_members
  to service_role;

grant select, insert, update, delete
  on table public.outing_invitations
  to service_role;

grant select, insert, update, delete
  on table public.outing_join_codes
  to service_role;

commit;