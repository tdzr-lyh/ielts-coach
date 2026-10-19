-- 在与 cloud-config.js 对应的 Supabase 项目 SQL Editor 中执行一次。
-- 独立于旧听力站的 learning_states；本脚本不会读取或修改旧站数据。
create table if not exists public.ielts_coach_states (
  user_id uuid primary key references auth.users(id) on delete cascade,
  state jsonb not null default '{}'::jsonb check (jsonb_typeof(state) = 'object'),
  revision integer not null default 1 check (revision >= 1),
  updated_at timestamptz not null default now()
);

alter table public.ielts_coach_states enable row level security;

revoke all on public.ielts_coach_states from anon, authenticated;
grant select on public.ielts_coach_states to authenticated;

drop policy if exists "coach users read own state" on public.ielts_coach_states;
create policy "coach users read own state"
on public.ielts_coach_states for select to authenticated
using ((select auth.uid()) = user_id);

-- 唯一写入口：原子比较版本后写入。旧版本只返回冲突，不覆盖新版本。
-- security definer 仅用于此受控写入口；UID只取当前登录用户，不能由客户端传入。
create or replace function public.save_ielts_coach_state(
  p_expected_revision integer,
  p_state jsonb
)
returns table (
  applied boolean,
  state jsonb,
  revision integer,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_state jsonb;
  v_revision integer;
  v_updated_at timestamptz;
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_expected_revision is null or p_expected_revision < 0 then
    raise exception 'Invalid expected revision' using errcode = '22023';
  end if;
  if p_state is null or pg_catalog.jsonb_typeof(p_state) <> 'object' then
    raise exception 'State must be a JSON object' using errcode = '22023';
  end if;

  if p_expected_revision = 0 then
    insert into public.ielts_coach_states as target (user_id, state, revision, updated_at)
    values (v_user_id, p_state, 1, pg_catalog.now())
    on conflict (user_id) do nothing
    returning target.state, target.revision, target.updated_at
    into v_state, v_revision, v_updated_at;
  else
    update public.ielts_coach_states as target
    set state = p_state,
        revision = target.revision + 1,
        updated_at = pg_catalog.now()
    where target.user_id = v_user_id and target.revision = p_expected_revision
    returning target.state, target.revision, target.updated_at
    into v_state, v_revision, v_updated_at;
  end if;

  if found then
    return query select true, v_state, v_revision, v_updated_at;
    return;
  end if;

  select target.state, target.revision, target.updated_at
  into v_state, v_revision, v_updated_at
  from public.ielts_coach_states as target
  where target.user_id = v_user_id;

  return query select false, v_state, coalesce(v_revision, 0), v_updated_at;
end;
$$;

revoke all on function public.save_ielts_coach_state(integer, jsonb) from public, anon;
grant execute on function public.save_ielts_coach_state(integer, jsonb) to authenticated;
