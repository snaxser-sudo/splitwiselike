begin;

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 80),
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  invite_code text not null unique default lower(encode(gen_random_bytes(9), 'hex')),
  created_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.group_members (
  group_id uuid not null references public.groups (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 140),
  amount_cents integer not null check (amount_cents > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  paid_by uuid not null references auth.users (id) on delete restrict,
  spent_at date not null default current_date,
  notes text,
  created_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now()
);

create table if not exists public.expense_splits (
  expense_id uuid not null references public.expenses (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete restrict,
  share_cents integer not null check (share_cents >= 0),
  primary key (expense_id, user_id)
);

create table if not exists public.settlements (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id) on delete cascade,
  from_user uuid not null references auth.users (id) on delete restrict,
  to_user uuid not null references auth.users (id) on delete restrict,
  amount_cents integer not null check (amount_cents > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  settled_at date not null default current_date,
  created_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  check (from_user <> to_user)
);

create index if not exists group_members_user_id_idx on public.group_members (user_id);
create index if not exists expenses_group_id_idx on public.expenses (group_id, spent_at desc);
create index if not exists expenses_paid_by_idx on public.expenses (paid_by);
create index if not exists expense_splits_user_id_idx on public.expense_splits (user_id);
create index if not exists settlements_group_id_idx on public.settlements (group_id, settled_at desc);
create index if not exists settlements_users_idx on public.settlements (from_user, to_user);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at
before update on public.profiles
for each row execute function public.touch_updated_at();

drop trigger if exists groups_touch_updated_at on public.groups;
create trigger groups_touch_updated_at
before update on public.groups
for each row execute function public.touch_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name, avatar_url)
  values (
    new.id,
    coalesce(
      nullif(new.raw_user_meta_data ->> 'full_name', ''),
      nullif(new.raw_user_meta_data ->> 'name', ''),
      split_part(new.email, '@', 1),
      'New user'
    ),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

create or replace function public.handle_new_group()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.group_members (group_id, user_id, role)
  values (new.id, new.created_by, 'owner')
  on conflict (group_id, user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_group_created on public.groups;
create trigger on_group_created
after insert on public.groups
for each row execute function public.handle_new_group();

create or replace function public.is_group_member(p_group_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_user_id is not null
    and exists (
      select 1
      from public.group_members
      where group_id = p_group_id
        and user_id = p_user_id
    );
$$;

create or replace function public.is_group_owner(p_group_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_user_id is not null
    and exists (
      select 1
      from public.group_members
      where group_id = p_group_id
        and user_id = p_user_id
        and role = 'owner'
    );
$$;

create or replace function public.shares_group(p_user_a uuid, p_user_b uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_user_a is not null
    and p_user_b is not null
    and (
      p_user_a = p_user_b
      or exists (
        select 1
        from public.group_members a
        join public.group_members b on b.group_id = a.group_id
        where a.user_id = p_user_a
          and b.user_id = p_user_b
      )
    );
$$;

alter table public.profiles enable row level security;
alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.expenses enable row level security;
alter table public.expense_splits enable row level security;
alter table public.settlements enable row level security;

drop policy if exists "profiles select own and shared" on public.profiles;
create policy "profiles select own and shared"
on public.profiles
for select
to authenticated
using (public.shares_group((select auth.uid()), id));

drop policy if exists "profiles insert own" on public.profiles;
create policy "profiles insert own"
on public.profiles
for insert
to authenticated
with check (id = (select auth.uid()));

drop policy if exists "profiles update own" on public.profiles;
create policy "profiles update own"
on public.profiles
for update
to authenticated
using (id = (select auth.uid()))
with check (id = (select auth.uid()));

drop policy if exists "groups select member" on public.groups;
create policy "groups select member"
on public.groups
for select
to authenticated
using (
  created_by = (select auth.uid())
  or public.is_group_member(id, (select auth.uid()))
);

drop policy if exists "groups insert own" on public.groups;
create policy "groups insert own"
on public.groups
for insert
to authenticated
with check (created_by = (select auth.uid()));

drop policy if exists "groups update owner" on public.groups;
create policy "groups update owner"
on public.groups
for update
to authenticated
using (public.is_group_owner(id, (select auth.uid())))
with check (public.is_group_owner(id, (select auth.uid())));

drop policy if exists "groups delete owner" on public.groups;
create policy "groups delete owner"
on public.groups
for delete
to authenticated
using (public.is_group_owner(id, (select auth.uid())));

drop policy if exists "group members select group" on public.group_members;
create policy "group members select group"
on public.group_members
for select
to authenticated
using (public.is_group_member(group_id, (select auth.uid())));

drop policy if exists "group members delete own or owner" on public.group_members;
create policy "group members delete own or owner"
on public.group_members
for delete
to authenticated
using (
  (user_id = (select auth.uid()) and role = 'member')
  or public.is_group_owner(group_id, (select auth.uid()))
);

drop policy if exists "expenses select group" on public.expenses;
create policy "expenses select group"
on public.expenses
for select
to authenticated
using (public.is_group_member(group_id, (select auth.uid())));

drop policy if exists "expenses update owner or creator" on public.expenses;
create policy "expenses update owner or creator"
on public.expenses
for update
to authenticated
using (
  created_by = (select auth.uid())
  or public.is_group_owner(group_id, (select auth.uid()))
)
with check (
  public.is_group_member(group_id, (select auth.uid()))
  and public.is_group_member(group_id, paid_by)
);

drop policy if exists "expenses delete owner or creator" on public.expenses;
create policy "expenses delete owner or creator"
on public.expenses
for delete
to authenticated
using (
  created_by = (select auth.uid())
  or public.is_group_owner(group_id, (select auth.uid()))
);

drop policy if exists "expense splits select group" on public.expense_splits;
create policy "expense splits select group"
on public.expense_splits
for select
to authenticated
using (
  exists (
    select 1
    from public.expenses e
    where e.id = expense_id
      and public.is_group_member(e.group_id, (select auth.uid()))
  )
);

drop policy if exists "settlements select group" on public.settlements;
create policy "settlements select group"
on public.settlements
for select
to authenticated
using (public.is_group_member(group_id, (select auth.uid())));

drop policy if exists "settlements delete owner or creator" on public.settlements;
create policy "settlements delete owner or creator"
on public.settlements
for delete
to authenticated
using (
  created_by = (select auth.uid())
  or public.is_group_owner(group_id, (select auth.uid()))
);

create or replace function public.join_group_by_invite(p_invite_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_group_id uuid;
  v_code text := lower(regexp_replace(trim(coalesce(p_invite_code, '')), '[[:space:]]+', '', 'g'));
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  select id into v_group_id
  from public.groups
  where invite_code = v_code;

  if v_group_id is null then
    raise exception 'Invite not found';
  end if;

  insert into public.group_members (group_id, user_id, role)
  values (v_group_id, v_uid, 'member')
  on conflict (group_id, user_id) do nothing;

  return v_group_id;
end;
$$;

create or replace function public.create_expense(
  p_group_id uuid,
  p_title text,
  p_amount_cents integer,
  p_currency text,
  p_paid_by uuid,
  p_spent_at date,
  p_notes text,
  p_splits jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_expense_id uuid;
  v_currency text;
  v_count integer;
  v_distinct_count integer;
  v_total integer;
  v_all_valid boolean;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if not public.is_group_member(p_group_id, v_uid) then
    raise exception 'Not a member of this group';
  end if;

  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'Amount must be greater than zero';
  end if;

  if trim(coalesce(p_title, '')) = '' then
    raise exception 'Title is required';
  end if;

  if not public.is_group_member(p_group_id, p_paid_by) then
    raise exception 'Payer must be a group member';
  end if;

  select currency into v_currency
  from public.groups
  where id = p_group_id;

  if v_currency is null then
    raise exception 'Group not found';
  end if;

  v_currency := upper(coalesce(nullif(trim(p_currency), ''), v_currency));

  if v_currency !~ '^[A-Z]{3}$' then
    raise exception 'Currency must be a three-letter code';
  end if;

  if jsonb_typeof(coalesce(p_splits, 'null'::jsonb)) <> 'array' then
    raise exception 'Splits must be an array';
  end if;

  with split_rows as (
    select
      (value ->> 'user_id')::uuid as user_id,
      (value ->> 'share_cents')::integer as share_cents
    from jsonb_array_elements(p_splits)
  )
  select
    count(*),
    count(distinct user_id),
    coalesce(sum(share_cents), 0)::integer,
    coalesce(
      bool_and(
        user_id is not null
        and share_cents is not null
        and share_cents >= 0
        and public.is_group_member(p_group_id, user_id)
      ),
      false
    )
  into v_count, v_distinct_count, v_total, v_all_valid
  from split_rows;

  if v_count = 0 then
    raise exception 'At least one split is required';
  end if;

  if v_count <> v_distinct_count then
    raise exception 'Duplicate split members are not allowed';
  end if;

  if not v_all_valid then
    raise exception 'Every split must belong to a group member';
  end if;

  if v_total <> p_amount_cents then
    raise exception 'Split total must match amount';
  end if;

  insert into public.expenses (
    group_id,
    title,
    amount_cents,
    currency,
    paid_by,
    spent_at,
    notes,
    created_by
  )
  values (
    p_group_id,
    trim(p_title),
    p_amount_cents,
    v_currency,
    p_paid_by,
    coalesce(p_spent_at, current_date),
    nullif(trim(coalesce(p_notes, '')), ''),
    v_uid
  )
  returning id into v_expense_id;

  insert into public.expense_splits (expense_id, user_id, share_cents)
  select
    v_expense_id,
    (value ->> 'user_id')::uuid,
    (value ->> 'share_cents')::integer
  from jsonb_array_elements(p_splits);

  return v_expense_id;
end;
$$;

create or replace function public.create_settlement(
  p_group_id uuid,
  p_from_user uuid,
  p_to_user uuid,
  p_amount_cents integer,
  p_currency text,
  p_settled_at date
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_settlement_id uuid;
  v_currency text;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if not public.is_group_member(p_group_id, v_uid) then
    raise exception 'Not a member of this group';
  end if;

  if not public.is_group_member(p_group_id, p_from_user)
    or not public.is_group_member(p_group_id, p_to_user) then
    raise exception 'Both payment users must be group members';
  end if;

  if p_from_user = p_to_user then
    raise exception 'Payment users must be different';
  end if;

  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'Amount must be greater than zero';
  end if;

  select currency into v_currency
  from public.groups
  where id = p_group_id;

  if v_currency is null then
    raise exception 'Group not found';
  end if;

  v_currency := upper(coalesce(nullif(trim(p_currency), ''), v_currency));

  if v_currency !~ '^[A-Z]{3}$' then
    raise exception 'Currency must be a three-letter code';
  end if;

  insert into public.settlements (
    group_id,
    from_user,
    to_user,
    amount_cents,
    currency,
    settled_at,
    created_by
  )
  values (
    p_group_id,
    p_from_user,
    p_to_user,
    p_amount_cents,
    v_currency,
    coalesce(p_settled_at, current_date),
    v_uid
  )
  returning id into v_settlement_id;

  return v_settlement_id;
end;
$$;

revoke execute on function public.join_group_by_invite(text) from public, anon;
revoke execute on function public.create_expense(uuid, text, integer, text, uuid, date, text, jsonb) from public, anon;
revoke execute on function public.create_settlement(uuid, uuid, uuid, integer, text, date) from public, anon;

grant execute on function public.join_group_by_invite(text) to authenticated;
grant execute on function public.create_expense(uuid, text, integer, text, uuid, date, text, jsonb) to authenticated;
grant execute on function public.create_settlement(uuid, uuid, uuid, integer, text, date) to authenticated;

commit;
