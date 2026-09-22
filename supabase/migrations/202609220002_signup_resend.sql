begin;

alter table public.auth_challenges
  add column next_resend_at timestamptz
    not null default now() + interval '60 seconds',
  add column resend_count integer
    not null default 0
    check (resend_count between 0 and 5);

create function public.reserve_signup_resend(p_challenge_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  challenge public.auth_challenges%rowtype;
begin
  select *
  into challenge
  from public.auth_challenges
  where id = p_challenge_id
  for update;

  if not found then
    return jsonb_build_object('status', 'invalid');
  end if;

  if challenge.purpose <> 'signup'
    or challenge.consumed_at is not null
    or challenge.attempts >= 5
    or challenge.resend_count >= 5
    or challenge.created_at < now() - interval '24 hours'
  then
    return jsonb_build_object('status', 'invalid');
  end if;

  if challenge.next_resend_at > now() then
    return jsonb_build_object('status', 'cooldown');
  end if;

  update public.auth_challenges
  set next_resend_at = now() + interval '60 seconds',
      resend_count = resend_count + 1
  where id = p_challenge_id;

  return jsonb_build_object(
    'status', 'ready',
    'email', challenge.email
  );
end;
$$;

create function public.finish_signup_resend(p_challenge_id uuid)
returns boolean
language sql
security invoker
set search_path = ''
as $$
  with renewed as (
    update public.auth_challenges
    set expires_at = now() + interval '10 minutes'
    where id = p_challenge_id
      and purpose = 'signup'
      and consumed_at is null
      and attempts < 5
      and resend_count > 0
      and created_at > now() - interval '24 hours'
    returning id
  )
  select exists(select 1 from renewed);
$$;

revoke all on function public.reserve_signup_resend(uuid)
  from public, anon, authenticated;

revoke all on function public.finish_signup_resend(uuid)
  from public, anon, authenticated;

grant execute on function public.reserve_signup_resend(uuid)
  to service_role;

grant execute on function public.finish_signup_resend(uuid)
  to service_role;

commit;