begin;

----------------------------------------------------------------------
-- ADD GUEST TO OUTING
--
-- Only an active owner/admin may add a named guest.
-- Guests are added without payer consent.
----------------------------------------------------------------------

create or replace function public.add_outing_guest(
  p_actor_id uuid,
  p_outing_id uuid,
  p_display_name text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  cleaned_name text;
  new_member_id uuid;
begin
  cleaned_name :=
    btrim(
      coalesce(
        p_display_name,
        ''
      )
    );

  if p_actor_id is null
    or p_outing_id is null
    or char_length(
      cleaned_name
    ) not between 2 and 50
  then
    return jsonb_build_object(
      'status',
      'invalid'
    );
  end if;

  if not exists (
    select 1
    from public.outings
    where id =
      p_outing_id
  ) then
    return jsonb_build_object(
      'status',
      'not_found'
    );
  end if;

  if not exists (
    select 1
    from public.outing_members
    where outing_id =
      p_outing_id
      and user_id =
        p_actor_id
      and removed_at is null
      and role in (
        'owner',
        'admin'
      )
  ) then
    return jsonb_build_object(
      'status',
      'forbidden'
    );
  end if;

  if not exists (
    select 1
    from public.outings
    where id =
      p_outing_id
      and status =
        'active'
  ) then
    return jsonb_build_object(
      'status',
      'inactive'
    );
  end if;

  insert into public.outing_members (
    outing_id,
    guest_display_name,
    role,
    opted_in,
    opted_in_at,
    added_by_user_id
  )
  values (
    p_outing_id,
    cleaned_name,
    'member',
    false,
    null,
    p_actor_id
  )
  returning id
  into new_member_id;

  return jsonb_build_object(
    'status',
    'added',
    'memberId',
    new_member_id
  );
end;
$$;

----------------------------------------------------------------------
-- CREATE / REPLACE SHAREABLE JOIN CODE
--
-- The Nest backend generates the raw random code and SHA-256 hash.
--
-- Only the hash is stored here.
--
-- Generating a new code revokes previous active shareable codes for the
-- outing, so "Generate a new code" really replaces the previous one.
----------------------------------------------------------------------

create or replace function public.create_outing_join_code(
  p_actor_id uuid,
  p_outing_id uuid,
  p_code_hash text,
  p_code_hint text,
  p_expires_at timestamptz,
  p_max_uses integer
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  new_code_id uuid;
begin
  if p_actor_id is null
    or p_outing_id is null
    or p_code_hash is null
    or p_code_hash !~
      '^[0-9a-f]{64}$'
    or p_code_hint is null
    or char_length(
      p_code_hint
    ) not between 2 and 8
    or p_expires_at is null
    or p_expires_at <=
      now()
    or p_expires_at >
      now() +
      interval '7 days'
    or (
      p_max_uses is not null
      and
      p_max_uses not between
        1 and 1000
    )
  then
    return jsonb_build_object(
      'status',
      'invalid'
    );
  end if;

  if not exists (
    select 1
    from public.outings
    where id =
      p_outing_id
  ) then
    return jsonb_build_object(
      'status',
      'not_found'
    );
  end if;

  if not exists (
    select 1
    from public.outing_members
    where outing_id =
      p_outing_id
      and user_id =
        p_actor_id
      and removed_at is null
      and role in (
        'owner',
        'admin'
      )
  ) then
    return jsonb_build_object(
      'status',
      'forbidden'
    );
  end if;

  if not exists (
    select 1
    from public.outings
    where id =
      p_outing_id
      and status =
        'active'
  ) then
    return jsonb_build_object(
      'status',
      'inactive'
    );
  end if;

  --------------------------------------------------------------------
  -- Serialize code replacement for this outing.
  --------------------------------------------------------------------

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'mova-outing-code:' ||
      p_outing_id::text,
      0
    )
  );

  update public.outing_join_codes
  set revoked_at =
    now()
  where outing_id =
    p_outing_id
    and revoked_at is null;

  insert into public.outing_join_codes (
    outing_id,
    created_by_user_id,
    code_hash,
    code_hint,
    expires_at,
    max_uses
  )
  values (
    p_outing_id,
    p_actor_id,
    p_code_hash,
    p_code_hint,
    p_expires_at,
    p_max_uses
  )
  returning id
  into new_code_id;

  return jsonb_build_object(
    'status',
    'created',
    'codeId',
    new_code_id,
    'expiresAt',
    p_expires_at
  );
end;
$$;

----------------------------------------------------------------------
-- LOOK UP SHAREABLE JOIN CODE
--
-- Returns only the outing ID.
--
-- The backend decides which preview details are safe to expose.
----------------------------------------------------------------------

create or replace function public.lookup_outing_join_code(
  p_code_hash text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  code_row
    public.outing_join_codes%rowtype;
begin
  if p_code_hash is null
    or p_code_hash !~
      '^[0-9a-f]{64}$'
  then
    return jsonb_build_object(
      'status',
      'invalid'
    );
  end if;

  select *
  into code_row
  from public.outing_join_codes
  where code_hash =
    p_code_hash
    and revoked_at is null
    and expires_at >
      now()
    and (
      max_uses is null
      or use_count <
        max_uses
    )
  limit 1;

  if not found then
    return jsonb_build_object(
      'status',
      'invalid'
    );
  end if;

  if not exists (
    select 1
    from public.outings
    where id =
      code_row.outing_id
      and status =
        'active'
  ) then
    return jsonb_build_object(
      'status',
      'invalid'
    );
  end if;

  return jsonb_build_object(
    'status',
    'ready',
    'outingId',
    code_row.outing_id
  );
end;
$$;

----------------------------------------------------------------------
-- JOIN OUTING WITH CODE
--
-- This operation is atomic:
--
--   validate code
--   check blocks
--   check existing membership
--   create membership
--   increment use count
--
-- A retry by an existing member does not consume another use.
----------------------------------------------------------------------

create or replace function public.join_outing_with_code(
  p_code_hash text,
  p_user_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  code_row
    public.outing_join_codes%rowtype;

  existing_member_id uuid;
  new_member_id uuid;
begin
  if p_code_hash is null
    or p_code_hash !~
      '^[0-9a-f]{64}$'
    or p_user_id is null
  then
    return jsonb_build_object(
      'status',
      'invalid'
    );
  end if;

  --------------------------------------------------------------------
  -- Lock the code so max-use enforcement is safe under concurrency.
  --------------------------------------------------------------------

  select *
  into code_row
  from public.outing_join_codes
  where code_hash =
    p_code_hash
  for update;

  if not found
    or code_row.revoked_at
      is not null
    or code_row.expires_at <=
      now()
    or (
      code_row.max_uses
        is not null
      and
      code_row.use_count >=
        code_row.max_uses
    )
  then
    return jsonb_build_object(
      'status',
      'invalid'
    );
  end if;

  if not exists (
    select 1
    from public.outings
    where id =
      code_row.outing_id
      and status =
        'active'
  ) then
    return jsonb_build_object(
      'status',
      'inactive'
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
      'invalid'
    );
  end if;

  --------------------------------------------------------------------
  -- If the person who issued the code and the joining user have blocked
  -- each other, the code cannot be used by that user.
  --------------------------------------------------------------------

  if code_row.created_by_user_id
      is not null
    and exists (
      select 1
      from public.user_blocks
      where (
        blocker_id =
          p_user_id
        and blocked_id =
          code_row.created_by_user_id
      )
      or (
        blocker_id =
          code_row.created_by_user_id
        and blocked_id =
          p_user_id
      )
    )
  then
    return jsonb_build_object(
      'status',
      'blocked'
    );
  end if;

  --------------------------------------------------------------------
  -- Serialize membership for the outing/user pair.
  --------------------------------------------------------------------

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'mova-outing-member:' ||
      code_row.outing_id::text ||
      ':' ||
      p_user_id::text,
      0
    )
  );

  select id
  into existing_member_id
  from public.outing_members
  where outing_id =
    code_row.outing_id
    and user_id =
      p_user_id
    and removed_at is null
  limit 1;

  if found then
    return jsonb_build_object(
      'status',
      'already_member',
      'outingId',
      code_row.outing_id,
      'memberId',
      existing_member_id
    );
  end if;

  insert into public.outing_members (
    outing_id,
    user_id,
    role,
    opted_in,
    opted_in_at,
    added_by_user_id
  )
  values (
    code_row.outing_id,
    p_user_id,
    'member',
    false,
    null,
    code_row.created_by_user_id
  )
  returning id
  into new_member_id;

  update public.outing_join_codes
  set use_count =
    use_count + 1
  where id =
    code_row.id;

  return jsonb_build_object(
    'status',
    'joined',
    'outingId',
    code_row.outing_id,
    'memberId',
    new_member_id
  );
end;
$$;

----------------------------------------------------------------------
-- PAYER-SELECTION CONSENT
--
-- A registered active member controls only their own consent.
----------------------------------------------------------------------

create or replace function public.set_outing_member_consent(
  p_user_id uuid,
  p_outing_id uuid,
  p_opted_in boolean
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  member_id uuid;
begin
  if p_user_id is null
    or p_outing_id is null
    or p_opted_in is null
  then
    return jsonb_build_object(
      'status',
      'invalid'
    );
  end if;

  if not exists (
    select 1
    from public.outings
    where id =
      p_outing_id
      and status =
        'active'
  ) then
    return jsonb_build_object(
      'status',
      'not_available'
    );
  end if;

  update public.outing_members
  set
    opted_in =
      p_opted_in,

    opted_in_at =
      case
        when p_opted_in
        then now()
        else null
      end
  where outing_id =
    p_outing_id
    and user_id =
      p_user_id
    and removed_at is null
  returning id
  into member_id;

  if member_id is null then
    return jsonb_build_object(
      'status',
      'not_found'
    );
  end if;

  return jsonb_build_object(
    'status',
    'updated',
    'memberId',
    member_id,
    'optedIn',
    p_opted_in
  );
end;
$$;

----------------------------------------------------------------------
-- BACKEND-ONLY RPC ACCESS
----------------------------------------------------------------------

revoke all
  on function public.add_outing_guest(
    uuid,
    uuid,
    text
  )
  from public, anon, authenticated;

revoke all
  on function public.create_outing_join_code(
    uuid,
    uuid,
    text,
    text,
    timestamptz,
    integer
  )
  from public, anon, authenticated;

revoke all
  on function public.lookup_outing_join_code(
    text
  )
  from public, anon, authenticated;

revoke all
  on function public.join_outing_with_code(
    text,
    uuid
  )
  from public, anon, authenticated;

revoke all
  on function public.set_outing_member_consent(
    uuid,
    uuid,
    boolean
  )
  from public, anon, authenticated;

grant execute
  on function public.add_outing_guest(
    uuid,
    uuid,
    text
  )
  to service_role;

grant execute
  on function public.create_outing_join_code(
    uuid,
    uuid,
    text,
    text,
    timestamptz,
    integer
  )
  to service_role;

grant execute
  on function public.lookup_outing_join_code(
    text
  )
  to service_role;

grant execute
  on function public.join_outing_with_code(
    text,
    uuid
  )
  to service_role;

grant execute
  on function public.set_outing_member_consent(
    uuid,
    uuid,
    boolean
  )
  to service_role;

commit;