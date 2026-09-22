begin;

create table public.auth_challenges (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  purpose text not null default 'signup'
    check (purpose = 'signup'),
  attempts integer not null default 0
    check (attempts >= 0 and attempts <= 5),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes',
  consumed_at timestamptz,
  constraint auth_challenges_expiry_check
    check (expires_at > created_at)
);

create index auth_challenges_expires_at_idx
  on public.auth_challenges (expires_at);

alter table public.auth_challenges enable row level security;

revoke all on table public.auth_challenges
  from public, anon, authenticated;

grant select, insert, update, delete
  on table public.auth_challenges
  to service_role;

commit;