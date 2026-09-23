begin;

----------------------------------------------------------------------
-- PROFILE HANDLES + DISCOVERABILITY
----------------------------------------------------------------------

alter table public.profiles
  add column username text;

alter table public.profiles
  add column is_discoverable boolean
    not null
    default false;

----------------------------------------------------------------------
-- Existing accounts need a stable unique username.
--
-- These generated handles are intentionally implementation-safe rather
-- than pretty. A later profile/settings flow can allow the user to choose
-- a friendlier handle.
----------------------------------------------------------------------

update public.profiles
set username =
  'mova_' ||
  left(
    replace(user_id::text, '-', ''),
    24
  )
where username is null;

alter table public.profiles
  alter column username
    set not null;

alter table public.profiles
  add constraint profiles_username_format_check
    check (
      username = lower(username)
      and username ~ '^[a-z0-9_]{3,30}$'
    );

create unique index profiles_username_unique_idx
  on public.profiles (
    lower(username)
  );

create index profiles_discoverable_username_idx
  on public.profiles (
    lower(username)
  )
  where is_discoverable = true;

create index profiles_discoverable_display_name_idx
  on public.profiles (
    lower(display_name)
  )
  where is_discoverable = true;

----------------------------------------------------------------------
-- Update the Auth-user trigger so every future account gets a profile
-- with a unique starter username automatically.
----------------------------------------------------------------------

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  raw_display_name text;
  generated_username text;
begin
  raw_display_name :=
    nullif(
      btrim(
        new.raw_user_meta_data->>'display_name'
      ),
      ''
    );

  generated_username :=
    'mova_' ||
    left(
      replace(
        new.id::text,
        '-',
        ''
      ),
      24
    );

  insert into public.profiles (
    user_id,
    display_name,
    username
  )
  values (
    new.id,
    case
      when raw_display_name is not null
        and char_length(
          raw_display_name
        ) between 2 and 50
      then raw_display_name
      else 'Mova User'
    end,
    generated_username
  )
  on conflict (user_id)
  do nothing;

  return new;
end;
$$;

revoke all
  on function public.handle_new_auth_user()
  from public, anon, authenticated;

----------------------------------------------------------------------
-- FRIEND REQUESTS
--
-- Only live pending requests are stored here.
--
-- Accepted requests move into friendships.
-- Declined/cancelled requests are deleted.
----------------------------------------------------------------------

create table public.friend_requests (
  id uuid primary key
    default gen_random_uuid(),

  sender_id uuid not null
    references public.profiles(user_id)
    on delete cascade,

  recipient_id uuid not null
    references public.profiles(user_id)
    on delete cascade,

  created_at timestamptz
    not null
    default now(),

  constraint friend_requests_not_self_check
    check (
      sender_id <> recipient_id
    )
);

----------------------------------------------------------------------
-- Prevent two simultaneous requests for the same unordered pair.
--
-- A -> B and B -> A therefore cannot both exist.
----------------------------------------------------------------------

create unique index friend_requests_unique_pair_idx
  on public.friend_requests (
    least(
      sender_id,
      recipient_id
    ),
    greatest(
      sender_id,
      recipient_id
    )
  );

create index friend_requests_sender_idx
  on public.friend_requests (
    sender_id,
    created_at desc
  );

create index friend_requests_recipient_idx
  on public.friend_requests (
    recipient_id,
    created_at desc
  );

----------------------------------------------------------------------
-- ACCEPTED FRIENDSHIPS
--
-- Friendship is symmetric, so the smaller UUID is always stored first.
----------------------------------------------------------------------

create table public.friendships (
  user_a_id uuid not null
    references public.profiles(user_id)
    on delete cascade,

  user_b_id uuid not null
    references public.profiles(user_id)
    on delete cascade,

  created_at timestamptz
    not null
    default now(),

  primary key (
    user_a_id,
    user_b_id
  ),

  constraint friendships_canonical_order_check
    check (
      user_a_id < user_b_id
    )
);

create index friendships_user_b_idx
  on public.friendships (
    user_b_id,
    created_at desc
  );

----------------------------------------------------------------------
-- USER BLOCKS
--
-- Blocking is directional:
--
-- A blocks B
-- does not mean
-- B blocked A.
--
-- However, either direction prevents friendship/request interaction.
----------------------------------------------------------------------

create table public.user_blocks (
  blocker_id uuid not null
    references public.profiles(user_id)
    on delete cascade,

  blocked_id uuid not null
    references public.profiles(user_id)
    on delete cascade,

  created_at timestamptz
    not null
    default now(),

  primary key (
    blocker_id,
    blocked_id
  ),

  constraint user_blocks_not_self_check
    check (
      blocker_id <> blocked_id
    )
);

create index user_blocks_blocked_idx
  on public.user_blocks (
    blocked_id,
    created_at desc
  );

----------------------------------------------------------------------
-- BACKEND-ONLY TABLE ACCESS
----------------------------------------------------------------------

alter table public.friend_requests
  enable row level security;

alter table public.friendships
  enable row level security;

alter table public.user_blocks
  enable row level security;

revoke all
  on table public.friend_requests
  from public, anon, authenticated;

revoke all
  on table public.friendships
  from public, anon, authenticated;

revoke all
  on table public.user_blocks
  from public, anon, authenticated;

grant select, insert, update, delete
  on table public.friend_requests
  to service_role;

grant select, insert, update, delete
  on table public.friendships
  to service_role;

grant select, insert, update, delete
  on table public.user_blocks
  to service_role;

----------------------------------------------------------------------
-- SEND FRIEND REQUEST
----------------------------------------------------------------------

create or replace function public.send_friend_request(
  p_sender_id uuid,
  p_recipient_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  request_id uuid;
  lower_user uuid;
  upper_user uuid;
begin
  if p_sender_id is null
    or p_recipient_id is null
    or p_sender_id = p_recipient_id
  then
    return jsonb_build_object(
      'status',
      'invalid'
    );
  end if;

  if not exists (
    select 1
    from public.profiles
    where user_id = p_sender_id
  ) or not exists (
    select 1
    from public.profiles
    where user_id = p_recipient_id
  ) then
    return jsonb_build_object(
      'status',
      'invalid'
    );
  end if;

  --------------------------------------------------------------------
  -- Either blocking direction prevents interaction.
  --------------------------------------------------------------------

  if exists (
    select 1
    from public.user_blocks
    where (
      blocker_id = p_sender_id
      and blocked_id = p_recipient_id
    )
    or (
      blocker_id = p_recipient_id
      and blocked_id = p_sender_id
    )
  ) then
    return jsonb_build_object(
      'status',
      'blocked'
    );
  end if;

  lower_user :=
    least(
      p_sender_id,
      p_recipient_id
    );

  upper_user :=
    greatest(
      p_sender_id,
      p_recipient_id
    );

  if exists (
    select 1
    from public.friendships
    where user_a_id = lower_user
      and user_b_id = upper_user
  ) then
    return jsonb_build_object(
      'status',
      'already_friends'
    );
  end if;

  --------------------------------------------------------------------
  -- Serialize operations for the unordered pair so concurrent opposite
  -- requests cannot both win.
  --------------------------------------------------------------------

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'mova-friends:' ||
      lower_user::text ||
      ':' ||
      upper_user::text,
      0
    )
  );

  if exists (
    select 1
    from public.friend_requests
    where least(
      sender_id,
      recipient_id
    ) = lower_user
    and greatest(
      sender_id,
      recipient_id
    ) = upper_user
  ) then
    return jsonb_build_object(
      'status',
      'pending'
    );
  end if;

  insert into public.friend_requests (
    sender_id,
    recipient_id
  )
  values (
    p_sender_id,
    p_recipient_id
  )
  returning id
  into request_id;

  return jsonb_build_object(
    'status',
    'sent',
    'requestId',
    request_id
  );
end;
$$;

----------------------------------------------------------------------
-- RESPOND TO FRIEND REQUEST
----------------------------------------------------------------------

create or replace function public.respond_friend_request(
  p_request_id uuid,
  p_actor_id uuid,
  p_accept boolean
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  request_row public.friend_requests%rowtype;
  lower_user uuid;
  upper_user uuid;
begin
  select *
  into request_row
  from public.friend_requests
  where id = p_request_id
  for update;

  if not found then
    return jsonb_build_object(
      'status',
      'invalid'
    );
  end if;

  if request_row.recipient_id
      <> p_actor_id then
    return jsonb_build_object(
      'status',
      'forbidden'
    );
  end if;

  if exists (
    select 1
    from public.user_blocks
    where (
      blocker_id =
        request_row.sender_id
      and blocked_id =
        request_row.recipient_id
    )
    or (
      blocker_id =
        request_row.recipient_id
      and blocked_id =
        request_row.sender_id
    )
  ) then
    delete
    from public.friend_requests
    where id = p_request_id;

    return jsonb_build_object(
      'status',
      'blocked'
    );
  end if;

  if p_accept is not true then
    delete
    from public.friend_requests
    where id = p_request_id;

    return jsonb_build_object(
      'status',
      'declined'
    );
  end if;

  lower_user :=
    least(
      request_row.sender_id,
      request_row.recipient_id
    );

  upper_user :=
    greatest(
      request_row.sender_id,
      request_row.recipient_id
    );

  insert into public.friendships (
    user_a_id,
    user_b_id
  )
  values (
    lower_user,
    upper_user
  )
  on conflict (
    user_a_id,
    user_b_id
  )
  do nothing;

  delete
  from public.friend_requests
  where id = p_request_id;

  return jsonb_build_object(
    'status',
    'accepted'
  );
end;
$$;

----------------------------------------------------------------------
-- CANCEL OUTGOING FRIEND REQUEST
----------------------------------------------------------------------

create or replace function public.cancel_friend_request(
  p_request_id uuid,
  p_actor_id uuid
)
returns boolean
language sql
security invoker
set search_path = ''
as $$
  with removed as (
    delete
    from public.friend_requests
    where id = p_request_id
      and sender_id = p_actor_id
    returning id
  )
  select exists(
    select 1
    from removed
  );
$$;

----------------------------------------------------------------------
-- REMOVE FRIEND
----------------------------------------------------------------------

create or replace function public.remove_friend(
  p_actor_id uuid,
  p_other_id uuid
)
returns boolean
language sql
security invoker
set search_path = ''
as $$
  with removed as (
    delete
    from public.friendships
    where user_a_id =
      least(
        p_actor_id,
        p_other_id
      )
      and user_b_id =
      greatest(
        p_actor_id,
        p_other_id
      )
    returning user_a_id
  )
  select exists(
    select 1
    from removed
  );
$$;

----------------------------------------------------------------------
-- BLOCK USER
--
-- Blocking automatically:
--   * removes friendship
--   * removes pending requests in either direction
----------------------------------------------------------------------

create or replace function public.block_user(
  p_blocker_id uuid,
  p_blocked_id uuid
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_blocker_id is null
    or p_blocked_id is null
    or p_blocker_id = p_blocked_id
  then
    return false;
  end if;

  if not exists (
    select 1
    from public.profiles
    where user_id = p_blocker_id
  ) or not exists (
    select 1
    from public.profiles
    where user_id = p_blocked_id
  ) then
    return false;
  end if;

  insert into public.user_blocks (
    blocker_id,
    blocked_id
  )
  values (
    p_blocker_id,
    p_blocked_id
  )
  on conflict (
    blocker_id,
    blocked_id
  )
  do nothing;

  delete
  from public.friend_requests
  where (
    sender_id = p_blocker_id
    and recipient_id = p_blocked_id
  )
  or (
    sender_id = p_blocked_id
    and recipient_id = p_blocker_id
  );

  delete
  from public.friendships
  where user_a_id =
    least(
      p_blocker_id,
      p_blocked_id
    )
    and user_b_id =
      greatest(
        p_blocker_id,
        p_blocked_id
      );

  return true;
end;
$$;

----------------------------------------------------------------------
-- UNBLOCK USER
----------------------------------------------------------------------

create or replace function public.unblock_user(
  p_blocker_id uuid,
  p_blocked_id uuid
)
returns boolean
language sql
security invoker
set search_path = ''
as $$
  with removed as (
    delete
    from public.user_blocks
    where blocker_id =
      p_blocker_id
      and blocked_id =
        p_blocked_id
    returning blocker_id
  )
  select exists(
    select 1
    from removed
  );
$$;

----------------------------------------------------------------------
-- DATABASE FUNCTIONS ARE BACKEND-ONLY
----------------------------------------------------------------------

revoke all
  on function public.send_friend_request(uuid, uuid)
  from public, anon, authenticated;

revoke all
  on function public.respond_friend_request(uuid, uuid, boolean)
  from public, anon, authenticated;

revoke all
  on function public.cancel_friend_request(uuid, uuid)
  from public, anon, authenticated;

revoke all
  on function public.remove_friend(uuid, uuid)
  from public, anon, authenticated;

revoke all
  on function public.block_user(uuid, uuid)
  from public, anon, authenticated;

revoke all
  on function public.unblock_user(uuid, uuid)
  from public, anon, authenticated;

grant execute
  on function public.send_friend_request(uuid, uuid)
  to service_role;

grant execute
  on function public.respond_friend_request(uuid, uuid, boolean)
  to service_role;

grant execute
  on function public.cancel_friend_request(uuid, uuid)
  to service_role;

grant execute
  on function public.remove_friend(uuid, uuid)
  to service_role;

grant execute
  on function public.block_user(uuid, uuid)
  to service_role;

grant execute
  on function public.unblock_user(uuid, uuid)
  to service_role;

commit;