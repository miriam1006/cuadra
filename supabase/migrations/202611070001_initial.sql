-- Apply in Supabase SQL Editor as the project administrator.
-- Provider secrets belong in server environment variables, never these tables.
begin;

create table public.merchants (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null unique references auth.users(id),
  name text not null check (length(name) between 1 and 100),
  pey_api_key_id text not null unique,
  max_amount_cents integer not null default 800000 check (max_amount_cents between 1 and 100000000),
  next_num_ref integer not null default 1 check (next_num_ref between 1 and 10000000),
  created_at timestamptz not null default now()
);

create table public.charges (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id),
  created_by uuid not null references auth.users(id),
  idempotency_key uuid not null,
  amount_cents integer not null check (amount_cents > 0),
  concept text not null check (length(concept) between 1 and 100),
  num_ref text not null check (num_ref ~ '^[0-9]{1,7}$'),
  method text not null default 'qr' check (method = 'qr'),
  status text not null default 'creating' check (status in ('creating','pending','paid','expired','cancelled','review','failed')),
  payment_status text not null default 'unpaid' check (payment_status in ('unpaid','paid','review')),
  pey_ref text unique,
  qr_string text,
  transaction_id text unique,
  late_payment boolean not null default false,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  paid_at timestamptz,
  cancelled_at timestamptz,
  failure_code text,
  provider_requested_at timestamptz,
  unique (merchant_id, num_ref),
  unique (merchant_id, idempotency_key)
);
create index charges_merchant_created_idx on public.charges(merchant_id, created_at desc);
create index charges_merchant_paid_idx on public.charges(merchant_id, paid_at) where payment_status = 'paid';

create table public.webhook_events (
  webhook_id text primary key,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  attempts integer not null default 0,
  outcome text,
  error text
);

-- Each payment remains a separate financial fact, including overpayments and late payments.
create table public.payment_receipts (
  transaction_id text primary key,
  charge_id uuid not null references public.charges(id),
  merchant_id uuid not null references public.merchants(id),
  webhook_id text not null references public.webhook_events(webhook_id),
  amount_cents integer not null check (amount_cents > 0),
  paid_at timestamptz not null,
  needs_review boolean not null default false,
  received_at timestamptz not null default now()
);
create index receipts_merchant_paid_idx on public.payment_receipts(merchant_id, paid_at);

create table public.audit_log (
  id bigint generated always as identity primary key,
  merchant_id uuid references public.merchants(id),
  actor text not null,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.merchants enable row level security;
alter table public.charges enable row level security;
alter table public.webhook_events enable row level security;
alter table public.payment_receipts enable row level security;
alter table public.audit_log enable row level security;

create policy merchant_owner_read on public.merchants for select to authenticated using (owner_user_id = (select auth.uid()));
create policy charges_owner_read on public.charges for select to authenticated using (
  exists (select 1 from public.merchants m where m.id = merchant_id and m.owner_user_id = (select auth.uid()))
);
create policy receipts_owner_read on public.payment_receipts for select to authenticated using (
  exists (select 1 from public.merchants m where m.id = merchant_id and m.owner_user_id = (select auth.uid()))
);
create policy audit_owner_read on public.audit_log for select to authenticated using (
  exists (select 1 from public.merchants m where m.id = merchant_id and m.owner_user_id = (select auth.uid()))
);
revoke all on public.merchants, public.charges, public.webhook_events, public.payment_receipts, public.audit_log from anon, authenticated;
grant select on public.merchants, public.charges, public.payment_receipts, public.audit_log to authenticated;
grant all on public.merchants, public.charges, public.webhook_events, public.payment_receipts, public.audit_log to service_role;
grant usage, select on sequence public.audit_log_id_seq to service_role;

create function public.reserve_charge(
  p_merchant_id uuid, p_owner_user_id uuid, p_amount_cents integer,
  p_concept text, p_idempotency_key uuid
) returns public.charges language plpgsql security definer set search_path = '' as $$
declare m public.merchants; c public.charges;
begin
  if p_merchant_id is null or p_owner_user_id is null or p_idempotency_key is null then raise exception 'invalid_charge_request'; end if;
  select * into m from public.merchants where id = p_merchant_id and owner_user_id = p_owner_user_id for update;
  if not found then raise exception 'merchant_not_found'; end if;
  select * into c from public.charges where merchant_id = m.id and idempotency_key = p_idempotency_key;
  if found then
    if c.amount_cents <> p_amount_cents or c.concept <> trim(p_concept) then raise exception 'idempotency_conflict'; end if;
    return c;
  end if;
  if p_amount_cents is null or p_amount_cents < 1 or p_amount_cents > m.max_amount_cents then raise exception 'invalid_amount'; end if;
  if p_concept is null or length(trim(p_concept)) not between 1 and 100 then raise exception 'invalid_concept'; end if;
  if (select count(*) from public.charges where merchant_id = m.id and created_at > now() - interval '1 minute') >= 10 then raise exception 'rate_limited'; end if;
  if m.next_num_ref > 9999999 then raise exception 'reference_exhausted'; end if;
  insert into public.charges (merchant_id, created_by, idempotency_key, amount_cents, concept, num_ref)
    values (m.id, p_owner_user_id, p_idempotency_key, p_amount_cents, trim(p_concept), m.next_num_ref::text) returning * into c;
  update public.merchants set next_num_ref = next_num_ref + 1 where id = m.id;
  insert into public.audit_log (merchant_id, actor, action, details) values (m.id, p_owner_user_id::text, 'charge.created', jsonb_build_object('charge_id', c.id));
  return c;
end;
$$;

create function public.finalize_charge(p_charge_id uuid, p_pey_ref text, p_qr_string text)
returns public.charges language plpgsql security definer set search_path = '' as $$
declare c public.charges;
begin
  if p_charge_id is null or length(trim(coalesce(p_pey_ref,''))) = 0 or length(trim(coalesce(p_qr_string,''))) = 0 then raise exception 'invalid_provider_response'; end if;
  select * into c from public.charges where id = p_charge_id for update;
  if not found then raise exception 'charge_not_found'; end if;
  if c.pey_ref is not null then
    if c.pey_ref <> p_pey_ref then raise exception 'provider_reference_conflict'; end if;
    return c;
  end if;
  if c.status <> 'creating' then raise exception 'invalid_charge_state'; end if;
  update public.charges set pey_ref = p_pey_ref, qr_string = p_qr_string, status = 'pending' where id = c.id returning * into c;
  return c;
end;
$$;

-- Claim provider creation exactly once across concurrent HTTP requests/retries.
-- A timeout after this claim is ambiguous; reconcile, never blindly create another QR.
create function public.claim_charge_creation(p_charge_id uuid)
returns public.charges language plpgsql security definer set search_path = '' as $$
declare c public.charges;
begin
  if p_charge_id is null then raise exception 'invalid_charge_request'; end if;
  update public.charges set provider_requested_at = now()
    where id = p_charge_id and status = 'creating' and provider_requested_at is null
    returning * into c;
  return c;
end;
$$;

create function public.cancel_charge(p_charge_id uuid, p_owner_user_id uuid)
returns public.charges language plpgsql security definer set search_path = '' as $$
declare c public.charges;
begin
  if p_charge_id is null or p_owner_user_id is null then raise exception 'invalid_charge_request'; end if;
  select ch.* into c from public.charges ch join public.merchants m on m.id = ch.merchant_id
    where ch.id = p_charge_id and m.owner_user_id = p_owner_user_id for update of ch;
  if not found then raise exception 'charge_not_found'; end if;
  if c.status = 'cancelled' then return c; end if;
  if c.status not in ('pending','expired') or c.payment_status <> 'unpaid' then raise exception 'invalid_charge_state'; end if;
  update public.charges set status = 'cancelled', cancelled_at = now() where id = c.id returning * into c;
  insert into public.audit_log(merchant_id, actor, action, details) values (c.merchant_id, p_owner_user_id::text, 'charge.cancelled', jsonb_build_object('charge_id', c.id));
  return c;
end;
$$;

-- The HTTP handler MUST verify Standard Webhooks against the raw body before this RPC.
-- No browser role can execute it. One RPC = one transaction: event, receipt, charge, audit.
create function public.process_pey_payment(
  p_webhook_id text, p_payload jsonb, p_pey_api_key_id text, p_pey_ref text,
  p_transaction_id text, p_amount_cents integer, p_paid_at timestamptz
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare e public.webhook_events; c public.charges; r public.payment_receipts; v_review boolean; v_late boolean; v_outcome text;
begin
  if length(trim(coalesce(p_webhook_id,''))) = 0 or length(trim(coalesce(p_transaction_id,''))) = 0
    or length(trim(coalesce(p_pey_ref,''))) = 0 or length(trim(coalesce(p_pey_api_key_id,''))) = 0
    or p_payload is null or jsonb_typeof(p_payload) <> 'object'
    or p_amount_cents is null or p_amount_cents < 1 or p_paid_at is null or not isfinite(p_paid_at) then
    raise exception 'invalid_payment';
  end if;
  insert into public.webhook_events(webhook_id, payload) values (p_webhook_id, p_payload) on conflict do nothing;
  select * into e from public.webhook_events where webhook_id = p_webhook_id for update;
  if e.payload <> p_payload then raise exception 'webhook_id_payload_conflict'; end if;
  if e.processed_at is not null then return jsonb_build_object('outcome', 'duplicate', 'retry', false); end if;
  update public.webhook_events set attempts = attempts + 1 where webhook_id = p_webhook_id;
  select ch.* into c from public.charges ch join public.merchants m on m.id = ch.merchant_id
    where ch.pey_ref = p_pey_ref and m.pey_api_key_id = p_pey_api_key_id for update of ch;
  if not found and p_payload->>'type' = 'codi.qr.payment_received'
    and p_payload->>'numRef' ~ '^[0-9]{1,7}$' then
    -- A successful Pey POST may have timed out or its finalize write may have failed.
    -- Only a signed webhook's never-reused reference + matching API key can recover it.
    select ch.* into c from public.charges ch join public.merchants m on m.id = ch.merchant_id
      where m.pey_api_key_id = p_pey_api_key_id and ch.num_ref = p_payload->>'numRef'
        and ch.pey_ref is null and ch.provider_requested_at is not null
      for update of ch;
    if found then
      update public.charges set pey_ref = p_pey_ref where id = c.id returning * into c;
      insert into public.audit_log(merchant_id, actor, action, details)
        values (c.merchant_id, 'pey_webhook', 'charge.provider_reference_recovered', jsonb_build_object('charge_id', c.id));
    end if;
  end if;
  if not found then
    update public.webhook_events set error = 'charge_not_found_or_key_mismatch', outcome = 'unmatched' where webhook_id = p_webhook_id;
    return jsonb_build_object('outcome', 'unmatched', 'retry', true);
  end if;
  -- Global transaction lock also serializes a malicious/conflicting delivery to another charge.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_transaction_id, 0));
  select * into r from public.payment_receipts where transaction_id = p_transaction_id;
  if found then
    if r.charge_id <> c.id or r.amount_cents <> p_amount_cents or r.paid_at <> p_paid_at then
      update public.webhook_events set outcome = 'transaction_conflict', error = 'transaction_conflict', processed_at = now() where webhook_id = p_webhook_id;
      insert into public.audit_log(merchant_id, actor, action, details) values (c.merchant_id, 'pey_webhook', 'payment.transaction_conflict', jsonb_build_object('charge_id', c.id, 'transaction_id', p_transaction_id));
      return jsonb_build_object('outcome', 'transaction_conflict', 'retry', false);
    end if;
    update public.webhook_events set outcome = 'duplicate_transaction', processed_at = now(), error = null where webhook_id = p_webhook_id;
    return jsonb_build_object('outcome', 'duplicate_transaction', 'retry', false);
  end if;
  v_review := c.amount_cents <> p_amount_cents or c.transaction_id is not null or c.payment_status = 'review';
  v_late := c.status in ('expired','cancelled','failed') or p_paid_at > c.expires_at;
  insert into public.payment_receipts(transaction_id, charge_id, merchant_id, webhook_id, amount_cents, paid_at, needs_review)
    values (p_transaction_id, c.id, c.merchant_id, p_webhook_id, p_amount_cents, p_paid_at, v_review);
  if v_review then
    update public.charges set status = 'review', payment_status = 'review', late_payment = late_payment or v_late where id = c.id;
    v_outcome := 'review';
  else
    update public.charges set status = 'paid', payment_status = 'paid', transaction_id = p_transaction_id,
      paid_at = p_paid_at, late_payment = v_late where id = c.id;
    v_outcome := case when v_late then 'paid_late' else 'paid' end;
  end if;
  update public.webhook_events set processed_at = now(), outcome = v_outcome, error = null where webhook_id = p_webhook_id;
  insert into public.audit_log(merchant_id, actor, action, details) values (c.merchant_id, 'pey_webhook', 'payment.' || v_outcome, jsonb_build_object('charge_id', c.id, 'transaction_id', p_transaction_id));
  return jsonb_build_object('outcome', v_outcome, 'charge_id', c.id, 'retry', false);
end;
$$;

-- Aggregate immutable receipts so a later extra payment putting the charge in review
-- never removes its earlier, valid confirmed receipt from the daily total.
create function public.daily_corte(p_merchant_id uuid, p_owner_user_id uuid, p_date date)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_start timestamptz; v_end timestamptz; v_result jsonb; v_pending bigint;
begin
  if p_merchant_id is null or p_owner_user_id is null or p_date is null or not isfinite(p_date) then
    raise exception 'invalid_corte_request';
  end if;
  if not exists (select 1 from public.merchants where id = p_merchant_id and owner_user_id = p_owner_user_id) then
    raise exception 'merchant_not_found';
  end if;
  v_start := p_date::timestamp at time zone 'America/Mexico_City';
  v_end := (p_date + 1)::timestamp at time zone 'America/Mexico_City';
  select jsonb_build_object(
    'date', p_date,
    'timezone', 'America/Mexico_City',
    'total_paid_cents', coalesce(sum(amount_cents) filter (where not needs_review), 0),
    'paid_count', count(*) filter (where not needs_review),
    'review_receipt_count', count(*) filter (where needs_review),
    'review_amount_cents', coalesce(sum(amount_cents) filter (where needs_review), 0)
  ) into v_result from public.payment_receipts
    where merchant_id = p_merchant_id and paid_at >= v_start and paid_at < v_end;
  select count(*) into v_pending from public.charges
    where merchant_id = p_merchant_id and created_at >= v_start and created_at < v_end
      and status = 'pending' and payment_status = 'unpaid' and expires_at > now();
  return v_result || jsonb_build_object('pending_count', v_pending);
end;
$$;

revoke all on function public.daily_corte(uuid,uuid,date) from public, anon, authenticated;
grant execute on function public.daily_corte(uuid,uuid,date) to service_role;
revoke all on function public.reserve_charge(uuid,uuid,integer,text,uuid) from public, anon, authenticated;
revoke all on function public.finalize_charge(uuid,text,text) from public, anon, authenticated;
revoke all on function public.claim_charge_creation(uuid) from public, anon, authenticated;
revoke all on function public.cancel_charge(uuid,uuid) from public, anon, authenticated;
revoke all on function public.process_pey_payment(text,jsonb,text,text,text,integer,timestamptz) from public, anon, authenticated;
grant execute on function public.reserve_charge(uuid,uuid,integer,text,uuid) to service_role;
grant execute on function public.finalize_charge(uuid,text,text) to service_role;
grant execute on function public.claim_charge_creation(uuid) to service_role;
grant execute on function public.cancel_charge(uuid,uuid) to service_role;
grant execute on function public.process_pey_payment(text,jsonb,text,text,text,integer,timestamptz) to service_role;
commit;
