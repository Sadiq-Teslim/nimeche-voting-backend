create extension if not exists pgcrypto;

create table if not exists organizations (
    id text primary key,
    name text not null,
    short_name text not null,
    created_at timestamptz not null default now()
);

create table if not exists elections (
    id uuid primary key default gen_random_uuid(),
    organization_id text not null references organizations(id) on delete cascade,
    title text not null,
    year text not null,
    status text not null default 'closed' check (status in ('open', 'closed')),
    created_at timestamptz not null default now()
);

create table if not exists positions (
    id text primary key,
    organization_id text not null references organizations(id) on delete cascade,
    election_id uuid not null references elections(id) on delete cascade,
    title text not null,
    group_key text not null,
    department_id text,
    sort_order integer not null default 0,
    created_at timestamptz not null default now()
);

-- Older factory databases used a fixed group list. Organization-defined groups
-- (for example, "graduate") must be allowed without a schema migration per event.
alter table positions drop constraint if exists positions_group_key_check;

create table if not exists departments (
    id text primary key,
    organization_id text not null references organizations(id) on delete cascade,
    title text not null,
    sort_order integer not null default 0
);

create table if not exists candidates (
    id uuid primary key default gen_random_uuid(),
    organization_id text not null references organizations(id) on delete cascade,
    election_id uuid not null references elections(id) on delete cascade,
    position_id text not null references positions(id) on delete cascade,
    name text not null,
    description text,
    image_url text,
    status text not null default 'approved' check (status in ('pending', 'approved', 'rejected')),
    created_at timestamptz not null default now()
);

create table if not exists nominations (
    id uuid primary key default gen_random_uuid(),
    organization_id text not null references organizations(id) on delete cascade,
    election_id uuid references elections(id) on delete cascade,
    full_name text not null,
    popular_name text,
    position_id text not null,
    image_url text,
    status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
    submitted_at timestamptz not null default now()
);

create table if not exists votes (
    id uuid primary key default gen_random_uuid(),
    organization_id text not null references organizations(id) on delete cascade,
    election_id uuid not null references elections(id) on delete cascade,
    voter_fingerprint text not null,
    department_id text not null,
    position_id text not null references positions(id) on delete cascade,
    candidate_id uuid not null references candidates(id) on delete restrict,
    created_at timestamptz not null default now(),
    unique (election_id, voter_fingerprint, position_id)
);

create table if not exists settings (
    organization_id text not null references organizations(id) on delete cascade,
    key text not null,
    value text not null,
    updated_at timestamptz not null default now(),
    primary key (organization_id, key)
);

create index if not exists candidates_position_idx on candidates(position_id);
create unique index if not exists candidates_election_position_name_idx
    on candidates(election_id, position_id, lower(name));
create index if not exists nominations_status_idx on nominations(organization_id, status, submitted_at desc);
create index if not exists votes_results_idx on votes(election_id, position_id, candidate_id);
