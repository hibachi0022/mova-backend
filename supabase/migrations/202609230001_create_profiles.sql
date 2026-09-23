begin;

create table public.profiles (
  user_id uuid primary key
    references auth.users(id)
    on delete cascade,

  display_name text not null
    check (
      char_length(btrim(display_name)) between 2 and 50
    ),

  phone text,

  avatar_url text,

  created_at timestamptz not null default now(),

  updated_at timestamptz not null default now(),

  constraint profiles_phone_length_check
    check (
      phone is null
      or char_length(phone) between 7 and 20
    )
);

create index profiles_display_name_idx
  on public.profiles (lower(display_name));

alter table public.profiles enable row level security;

revoke all on table public.profiles
  from public, anon, authenticated;

grant select, insert, update, delete
  on table public.profiles
  to service_role;

----------------------------------------------------------------------
-- Automatically create a profile whenever Supabase Auth creates a user.
----------------------------------------------------------------------

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  raw_display_name text;
begin
  raw_display_name :=
    nullif(
      btrim(new.raw_user_meta_data->>'display_name'),
      ''
    );

  insert into public.profiles (
    user_id,
    display_name
  )
  values (
    new.id,
    case
      when raw_display_name is not null
        and char_length(raw_display_name) between 2 and 50
      then raw_display_name
      else 'Mova User'
    end
  )
  on conflict (user_id) do nothing;

  return new;
end;
$$;

revoke all on function public.handle_new_auth_user()
  from public, anon, authenticated;

drop trigger if exists on_auth_user_created
  on auth.users;

create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_auth_user();

----------------------------------------------------------------------
-- Keep updated_at accurate.
----------------------------------------------------------------------

create or replace function public.set_profile_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function public.set_profile_updated_at()
  from public, anon, authenticated;

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row
  execute function public.set_profile_updated_at();

----------------------------------------------------------------------
-- Backfill users that already existed before this migration.
----------------------------------------------------------------------

insert into public.profiles (
  user_id,
  display_name,
  created_at,
  updated_at
)
select
  users.id,
  case
    when nullif(
      btrim(users.raw_user_meta_data->>'display_name'),
      ''
    ) is not null
      and char_length(
        btrim(users.raw_user_meta_data->>'display_name')
      ) between 2 and 50
    then btrim(
      users.raw_user_meta_data->>'display_name'
    )
    else 'Mova User'
  end,
  users.created_at,
  now()
from auth.users as users
on conflict (user_id) do nothing;

commit;