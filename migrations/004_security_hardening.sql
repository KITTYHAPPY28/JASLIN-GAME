-- ============================================================
-- JASLIN V6 SECURITY HARDENING
-- Run ONCE in Supabase SQL Editor / migration.
-- Target: Jaslin-db
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1) VERIFIED WALLET OWNERSHIP
-- ------------------------------------------------------------
alter table public.users
  add column if not exists wallet_verified_at bigint not null default 0;

alter table public.users
  add column if not exists wallet_chain text not null default '';

-- Existing addresses are intentionally NOT marked verified.
-- Users must reconnect once with TON Proof.

create table if not exists public.jaslin_ton_proof_nonces (
  id bigserial primary key,
  telegram_id text not null,
  payload text not null unique,
  expires_at bigint not null,
  used_at bigint not null default 0,
  created_at bigint not null
);

create index if not exists idx_jaslin_ton_proof_nonces_user
  on public.jaslin_ton_proof_nonces (telegram_id, used_at, expires_at);

alter table public.jaslin_ton_proof_nonces enable row level security;

revoke all on table public.jaslin_ton_proof_nonces from anon, authenticated;
grant all on table public.jaslin_ton_proof_nonces to service_role;

do $$
begin
  if to_regclass('public.jaslin_ton_proof_nonces_id_seq') is not null then
    revoke all on sequence public.jaslin_ton_proof_nonces_id_seq
      from anon, authenticated;
    grant usage, select, update
      on sequence public.jaslin_ton_proof_nonces_id_seq
      to service_role;
  end if;
end $$;

-- ------------------------------------------------------------
-- 2) DISTRIBUTED RATE LIMIT FOR VERCEL SERVERLESS
-- ------------------------------------------------------------
create table if not exists public.jaslin_rate_limits (
  rate_key text primary key,
  request_count integer not null default 0,
  reset_at bigint not null,
  updated_at bigint not null
);

alter table public.jaslin_rate_limits enable row level security;

revoke all on table public.jaslin_rate_limits from anon, authenticated;
grant all on table public.jaslin_rate_limits to service_role;

create or replace function public.jaslin_rate_limit(
  p_key text,
  p_window_ms bigint,
  p_limit integer,
  p_now bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
  v_reset bigint;
begin
  if p_key is null or length(p_key) < 3 then
    raise exception 'invalid rate key';
  end if;

  if p_window_ms < 1000 or p_limit < 1 then
    raise exception 'invalid rate limit config';
  end if;

  insert into public.jaslin_rate_limits(
    rate_key,
    request_count,
    reset_at,
    updated_at
  )
  values(
    p_key,
    1,
    p_now + p_window_ms,
    p_now
  )
  on conflict (rate_key)
  do update set
    request_count =
      case
        when public.jaslin_rate_limits.reset_at <= p_now
          then 1
        else public.jaslin_rate_limits.request_count + 1
      end,
    reset_at =
      case
        when public.jaslin_rate_limits.reset_at <= p_now
          then p_now + p_window_ms
        else public.jaslin_rate_limits.reset_at
      end,
    updated_at = p_now
  returning request_count, reset_at
    into v_count, v_reset;

  return jsonb_build_object(
    'allowed', v_count <= p_limit,
    'count', v_count,
    'limit', p_limit,
    'reset_at', v_reset
  );
end;
$$;

revoke all on function public.jaslin_rate_limit(text,bigint,integer,bigint)
  from public, anon, authenticated;
grant execute on function public.jaslin_rate_limit(text,bigint,integer,bigint)
  to service_role;

-- ------------------------------------------------------------
-- 3) ATOMIC MINING + REFERRAL COMMISSION COMMIT
-- ------------------------------------------------------------
create or replace function public.jaslin_commit_mining_claim(
  p_telegram_id text,
  p_expected_balance numeric,
  p_expected_mining_started_at bigint,
  p_claimed numeric,
  p_referrer text,
  p_commission numeric,
  p_now bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user public.users%rowtype;
  v_new_balance numeric;
begin
  if p_claimed <= 0 then
    return jsonb_build_object(
      'ok', false,
      'error', 'claim amount invalid'
    );
  end if;

  select *
    into v_user
  from public.users
  where telegram_id = p_telegram_id
  for update;

  if not found then
    return jsonb_build_object(
      'ok', false,
      'error', 'user not found'
    );
  end if;

  if v_user.balance is distinct from p_expected_balance
     or v_user.mining_started_at is distinct from p_expected_mining_started_at then
    return jsonb_build_object(
      'ok', false,
      'error', 'state changed'
    );
  end if;

  v_new_balance := v_user.balance + p_claimed;

  update public.users
  set
    balance = v_new_balance,
    mining_started_at = p_now
  where telegram_id = p_telegram_id;

  insert into public.transactions(
    telegram_id,
    type,
    amount,
    status,
    tx_signature,
    note,
    created_at
  )
  values(
    p_telegram_id,
    'mining',
    p_claimed,
    'completed',
    null,
    'Mining claim',
    p_now
  );

  if p_referrer is not null
     and p_referrer <> ''
     and p_referrer <> p_telegram_id
     and coalesce(p_commission, 0) > 0 then

    update public.users
    set referral_commission_balance =
      referral_commission_balance + p_commission
    where telegram_id = p_referrer;

    if found then
      insert into public.transactions(
        telegram_id,
        type,
        amount,
        status,
        tx_signature,
        note,
        created_at
      )
      values(
        p_referrer,
        'referral_commission_pending',
        p_commission,
        'completed',
        null,
        'Mining referral commission',
        p_now
      );
    end if;
  end if;

  return jsonb_build_object(
    'ok', true,
    'balance', v_new_balance,
    'mining_started_at', p_now
  );
end;
$$;

revoke all on function public.jaslin_commit_mining_claim(
  text,numeric,bigint,numeric,text,numeric,bigint
) from public, anon, authenticated;

grant execute on function public.jaslin_commit_mining_claim(
  text,numeric,bigint,numeric,text,numeric,bigint
) to service_role;

-- ------------------------------------------------------------
-- 4) LEAST PRIVILEGE: FRONTEND MUST USE EXPRESS API, NOT TABLES
-- ------------------------------------------------------------
revoke all on table public.users from anon, authenticated;
revoke all on table public.transactions from anon, authenticated;
revoke all on table public.withdrawals from anon, authenticated;
revoke all on table public.jaslin_hot_wallet_lock from anon, authenticated;
revoke all on table public.jaslin_social_task_progress from anon, authenticated;
revoke all on table public.jaslin_x_accounts from anon, authenticated;
revoke all on table public.jaslin_x_oauth_states from anon, authenticated;
revoke all on table public.jaslin_x_verification_logs from anon, authenticated;

grant all on table public.users to service_role;
grant all on table public.transactions to service_role;
grant all on table public.withdrawals to service_role;
grant all on table public.jaslin_hot_wallet_lock to service_role;
grant all on table public.jaslin_social_task_progress to service_role;
grant all on table public.jaslin_x_accounts to service_role;
grant all on table public.jaslin_x_oauth_states to service_role;
grant all on table public.jaslin_x_verification_logs to service_role;

-- Existing RPCs used by the backend stay service-role-only.
do $$
declare
  r record;
begin
  for r in
    select
      n.nspname as schema_name,
      p.proname as function_name,
      pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'jaslin_acquire_hot_wallet_lock',
        'jaslin_release_hot_wallet_lock',
        'jaslin_reserve_auto_withdrawal',
        'jaslin_refund_auto_withdrawal',
        'claim_x_social_reward'
      )
  loop
    execute format(
      'revoke all on function %I.%I(%s) from public, anon, authenticated',
      r.schema_name,
      r.function_name,
      r.args
    );
    execute format(
      'grant execute on function %I.%I(%s) to service_role',
      r.schema_name,
      r.function_name,
      r.args
    );
  end loop;
end $$;

-- ------------------------------------------------------------
-- 5) ADVISOR FIX: MUTABLE SEARCH PATH
-- ------------------------------------------------------------
do $$
begin
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname='public'
      and p.proname='jaslin_set_updated_at'
      and pg_get_function_identity_arguments(p.oid) = ''
  ) then
    execute
      'alter function public.jaslin_set_updated_at() set search_path = public, pg_temp';
    execute
      'revoke all on function public.jaslin_set_updated_at() from public, anon, authenticated';
    execute
      'grant execute on function public.jaslin_set_updated_at() to service_role';
  end if;
end $$;

-- ------------------------------------------------------------
-- 6) DATABASE INDEX CLEANUP
-- Keep one copy of every duplicated index reported by Advisor.
-- ------------------------------------------------------------
drop index if exists public.users_last_seen_at_idx;
drop index if exists public.users_referred_by_idx;
drop index if exists public.withdrawals_status_idx;
drop index if exists public.withdrawals_telegram_id_idx;
drop index if exists public.withdrawals_user_created_idx;

-- Missing covering index reported by Advisor.
create index if not exists idx_jaslin_x_verification_logs_task_id
  on public.jaslin_x_verification_logs(task_id);

-- Helpful for reconciliation.
create index if not exists idx_withdrawals_status_query
  on public.withdrawals(status, query_id)
  where query_id is not null;

-- Keep RLS enabled on financial/security tables.
alter table public.users enable row level security;
alter table public.transactions enable row level security;
alter table public.withdrawals enable row level security;
alter table public.jaslin_hot_wallet_lock enable row level security;
alter table public.jaslin_social_task_progress enable row level security;
alter table public.jaslin_x_accounts enable row level security;
alter table public.jaslin_x_oauth_states enable row level security;
alter table public.jaslin_x_verification_logs enable row level security;

commit;

-- ============================================================
-- POST-CHECK (read-only)
-- ============================================================
-- select telegram_id, wallet, wallet_verified_at, wallet_chain
-- from public.users order by created_at desc limit 20;
--
-- select status, count(*) from public.withdrawals group by status;
-- ============================================================
