begin;

----------------------------------------------------------------------
-- ROULETTE SPIN HISTORY
----------------------------------------------------------------------

create table public.outing_roulette_spins (
  id uuid primary key
    default gen_random_uuid(),

  outing_id uuid not null
    references public.outings(id)
    on delete cascade,

  initiated_by_user_id uuid
    references public.profiles(user_id)
    on delete set null,

  selected_member_id uuid
    references public.outing_members(id)
    on delete set null,

  eligible_count integer not null,

  created_at timestamptz not null
    default now(),

  constraint outing_roulette_spins_eligible_count_check
    check (
      eligible_count >= 2
    )
);

create index outing_roulette_spins_outing_idx
  on public.outing_roulette_spins (
    outing_id,
    created_at desc
  );

----------------------------------------------------------------------
-- REMOVE ANY STALE EXISTING SELECTION
----------------------------------------------------------------------

update public.outings
set selected_member_id = null
where selected_member_id is not null
  and not exists (
    select 1
    from public.outing_members
    where id =
      public.outings.selected_member_id
      and outing_id =
        public.outings.id
      and removed_at is null
      and opted_in = true
  );

----------------------------------------------------------------------
-- SELECTED PAYER MUST BE AN ACTIVE OPTED-IN MEMBER
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
      and opted_in = true
  ) then
    raise exception
      'Selected member must be an active opted-in member of this outing.'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all
  on function public.validate_outing_selected_member()
  from public, anon, authenticated;

----------------------------------------------------------------------
-- CLEAR OLD WINNER WHEN ELIGIBILITY CHANGES
----------------------------------------------------------------------

create or replace function public.clear_outing_selection_on_member_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_outing_id uuid;

  eligibility_changed boolean :=
    false;
begin
  if tg_op = 'INSERT' then
    target_outing_id :=
      new.outing_id;

    eligibility_changed :=
      new.removed_at is null
      and new.opted_in = true;

  elsif tg_op = 'UPDATE' then
    target_outing_id :=
      new.outing_id;

    eligibility_changed :=
      new.opted_in
        is distinct from
          old.opted_in
      or
      new.removed_at
        is distinct from
          old.removed_at;

  elsif tg_op = 'DELETE' then
    target_outing_id :=
      old.outing_id;

    eligibility_changed :=
      old.removed_at is null
      and old.opted_in = true;
  end if;

  if eligibility_changed then
    update public.outings
    set selected_member_id =
      null
    where id =
      target_outing_id
      and selected_member_id
        is not null;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  return new;
end;
$$;

revoke all
  on function public.clear_outing_selection_on_member_change()
  from public, anon, authenticated;

drop trigger if exists
  outing_members_clear_selection
  on public.outing_members;

create trigger outing_members_clear_selection
  after insert
  or update of opted_in, removed_at
  or delete
  on public.outing_members
  for each row
  execute function
    public.clear_outing_selection_on_member_change();

----------------------------------------------------------------------
-- SERVER-SIDE ROULETTE
----------------------------------------------------------------------

create or replace function public.spin_outing_roulette(
  p_actor_id uuid,
  p_outing_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  outing_status text;

  existing_selected_member_id uuid;

  eligible_count integer;

  winner_member_id uuid;
begin
  if p_actor_id is null
    or p_outing_id is null
  then
    return jsonb_build_object(
      'status',
      'invalid'
    );
  end if;

  --------------------------------------------------------------------
  -- LOCK OUTING TO PREVENT CONCURRENT SPINS
  --------------------------------------------------------------------

  select
    status,
    selected_member_id
  into
    outing_status,
    existing_selected_member_id
  from public.outings
  where id =
    p_outing_id
  for update;

  if not found then
    return jsonb_build_object(
      'status',
      'not_found'
    );
  end if;

  --------------------------------------------------------------------
  -- CALLER MUST BELONG TO OUTING
  --------------------------------------------------------------------

  if not exists (
    select 1
    from public.outing_members
    where outing_id =
      p_outing_id
      and user_id =
        p_actor_id
      and removed_at is null
  ) then
    return jsonb_build_object(
      'status',
      'forbidden'
    );
  end if;

  if outing_status <>
      'active'
  then
    return jsonb_build_object(
      'status',
      'inactive'
    );
  end if;

  --------------------------------------------------------------------
  -- EXISTING VALID WINNER IS RETURNED
  --------------------------------------------------------------------

  if existing_selected_member_id
      is not null
    and exists (
      select 1
      from public.outing_members
      where id =
        existing_selected_member_id
        and outing_id =
          p_outing_id
        and removed_at is null
        and opted_in = true
    )
  then
    return jsonb_build_object(
      'status',
      'already_selected',
      'selectedMemberId',
      existing_selected_member_id
    );
  end if;

  --------------------------------------------------------------------
  -- COUNT ELIGIBLE MEMBERS
  --------------------------------------------------------------------

  select count(*)::integer
  into eligible_count
  from public.outing_members
  where outing_id =
    p_outing_id
    and removed_at is null
    and opted_in = true;

  if eligible_count < 2 then
    return jsonb_build_object(
      'status',
      'insufficient_members',
      'eligibleCount',
      eligible_count
    );
  end if;

  --------------------------------------------------------------------
  -- RANDOMLY PICK ONE ELIGIBLE MEMBER
  --------------------------------------------------------------------

  select id
  into winner_member_id
  from public.outing_members
  where outing_id =
    p_outing_id
    and removed_at is null
    and opted_in = true
  order by gen_random_uuid()
  limit 1;

  if winner_member_id
      is null then
    return jsonb_build_object(
      'status',
      'unavailable'
    );
  end if;

  --------------------------------------------------------------------
  -- STORE WINNER
  --------------------------------------------------------------------

  update public.outings
  set selected_member_id =
    winner_member_id
  where id =
    p_outing_id;

  --------------------------------------------------------------------
  -- AUDIT COMPLETED SPIN
  --------------------------------------------------------------------

  insert into public.outing_roulette_spins (
    outing_id,
    initiated_by_user_id,
    selected_member_id,
    eligible_count
  )
  values (
    p_outing_id,
    p_actor_id,
    winner_member_id,
    eligible_count
  );

  return jsonb_build_object(
    'status',
    'selected',
    'selectedMemberId',
    winner_member_id,
    'eligibleCount',
    eligible_count
  );
end;
$$;

----------------------------------------------------------------------
-- BACKEND-ONLY ACCESS
----------------------------------------------------------------------

alter table public.outing_roulette_spins
  enable row level security;

revoke all
  on table public.outing_roulette_spins
  from public, anon, authenticated;

grant select, insert
  on table public.outing_roulette_spins
  to service_role;

revoke all
  on function public.spin_outing_roulette(
    uuid,
    uuid
  )
  from public, anon, authenticated;

grant execute
  on function public.spin_outing_roulette(
    uuid,
    uuid
  )
  to service_role;

commit;