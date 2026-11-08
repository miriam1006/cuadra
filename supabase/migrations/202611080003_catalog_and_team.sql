-- Apply after migrations 001 and 002. Server-only writes; authenticated clients read via RLS.
begin;

create table public.merchant_members (
  user_id uuid primary key references auth.users(id),
  merchant_id uuid not null references public.merchants(id),
  role text not null check (role in ('admin','cashier')),
  display_name text not null check (length(trim(display_name)) between 1 and 100 and display_name = trim(display_name)),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index merchant_members_merchant_idx on public.merchant_members(merchant_id,active,role);
insert into public.merchant_members(user_id,merchant_id,role,display_name)
  select owner_user_id,id,'admin',coalesce(nullif(trim(name),''),'Administrador') from public.merchants;

create function public.seed_merchant_owner_member() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.merchant_members(user_id,merchant_id,role,display_name) values (new.owner_user_id,new.id,'admin',coalesce(nullif(trim(new.name),''),'Administrador'));
  return new;
end; $$;
revoke all on function public.seed_merchant_owner_member() from public,anon,authenticated;
create trigger merchant_owner_membership after insert on public.merchants for each row execute function public.seed_merchant_owner_member();

create function public.protect_merchant_member() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op='UPDATE' and (new.user_id<>old.user_id or new.merchant_id<>old.merchant_id) then raise exception 'member_other_merchant'; end if;
  if exists(select 1 from public.merchants where id=old.merchant_id and owner_user_id=old.user_id) then
    if tg_op='DELETE' then raise exception 'owner_membership_protected'; end if;
    if new.role<>'admin' or not new.active then raise exception 'owner_membership_protected'; end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end; $$;
revoke all on function public.protect_merchant_member() from public,anon,authenticated;
create trigger merchant_member_protected before update or delete on public.merchant_members for each row execute function public.protect_merchant_member();

-- This helper accepts only a merchant ID; it can reveal only the caller's own role.
create function public.current_merchant_role(p_merchant_id uuid) returns text
language sql stable security definer set search_path = '' as $$
  select role from public.merchant_members where merchant_id = p_merchant_id and user_id = (select auth.uid()) and active;
$$;
revoke all on function public.current_merchant_role(uuid) from public,anon;
grant execute on function public.current_merchant_role(uuid) to authenticated,service_role;

create table public.products (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id),
  name text not null check (length(trim(name)) between 1 and 100 and name = trim(name)),
  price_cents integer not null check (price_cents between 1 and 100000000),
  barcode text check (barcode is null or (length(barcode) between 1 and 64 and barcode = trim(barcode) and barcode !~ '[[:cntrl:]]')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(id,merchant_id)
);
create unique index products_merchant_barcode_unique on public.products(merchant_id,barcode) where barcode is not null;
create index products_merchant_active_name_idx on public.products(merchant_id,active,name);
alter table public.charges add constraint charges_id_merchant_unique unique(id,merchant_id);
create table public.charge_items (
  charge_id uuid not null,
  merchant_id uuid not null references public.merchants(id),
  product_id uuid not null,
  name text not null check (length(name) between 1 and 100),
  unit_price_cents integer not null check (unit_price_cents between 1 and 100000000),
  quantity integer not null check (quantity between 1 and 999),
  line_total_cents bigint generated always as (unit_price_cents::bigint * quantity) stored,
  primary key(charge_id,product_id),
  foreign key(charge_id,merchant_id) references public.charges(id,merchant_id),
  foreign key(product_id,merchant_id) references public.products(id,merchant_id)
);
create index charge_items_merchant_charge_idx on public.charge_items(merchant_id,charge_id);
create index charge_items_product_merchant_idx on public.charge_items(product_id,merchant_id);
create index charges_merchant_creator_created_idx on public.charges(merchant_id,created_by,created_at desc);
create function public.reject_charge_item_mutation() returns trigger language plpgsql set search_path = '' as $$
begin raise exception 'charge_items_immutable'; end; $$;
revoke all on function public.reject_charge_item_mutation() from public,anon,authenticated;
create trigger charge_items_immutable before update or delete on public.charge_items for each row execute function public.reject_charge_item_mutation();

alter table public.merchant_members enable row level security;
alter table public.products enable row level security;
alter table public.charge_items enable row level security;
drop policy merchant_owner_read on public.merchants;
drop policy charges_owner_read on public.charges;
drop policy receipts_owner_read on public.payment_receipts;
drop policy audit_owner_read on public.audit_log;
create policy merchants_member_read on public.merchants for select to authenticated using (public.current_merchant_role(id) is not null);
create policy members_scoped_read on public.merchant_members for select to authenticated using (
  public.current_merchant_role(merchant_id) = 'admin' or (user_id = (select auth.uid()) and active)
);
create policy products_scoped_read on public.products for select to authenticated using (
  public.current_merchant_role(merchant_id) = 'admin' or (active and public.current_merchant_role(merchant_id) = 'cashier')
);
create policy charges_scoped_read on public.charges for select to authenticated using (
  public.current_merchant_role(merchant_id) = 'admin' or (created_by = (select auth.uid()) and public.current_merchant_role(merchant_id) = 'cashier')
);
create policy receipts_scoped_read on public.payment_receipts for select to authenticated using (
  exists (select 1 from public.charges c where c.id = charge_id and c.merchant_id = payment_receipts.merchant_id)
);
create policy items_scoped_read on public.charge_items for select to authenticated using (
  exists (select 1 from public.charges c where c.id = charge_id and c.merchant_id = charge_items.merchant_id)
);
create policy audit_admin_read on public.audit_log for select to authenticated using (public.current_merchant_role(merchant_id) = 'admin');
revoke all on public.merchant_members,public.products,public.charge_items from anon,authenticated;
grant select on public.merchant_members,public.products,public.charge_items to authenticated;
grant all on public.merchant_members,public.products,public.charge_items to service_role;

create function public.save_product(p_merchant_id uuid,p_actor_user_id uuid,p_product_id uuid,p_name text,p_price_cents integer,p_barcode text,p_active boolean)
returns public.products language plpgsql security definer set search_path = '' as $$
declare p public.products;
begin
  perform 1 from public.merchants where id = p_merchant_id for update;
  if not found or not exists (select 1 from public.merchant_members where merchant_id=p_merchant_id and user_id=p_actor_user_id and role='admin' and active) then raise exception 'admin_required'; end if;
  if p_name is null or length(trim(p_name)) not between 1 and 100 or p_price_cents is null or p_price_cents not between 1 and 100000000 or p_active is null
    or (p_barcode is not null and (length(p_barcode) not between 1 and 64 or p_barcode <> trim(p_barcode) or p_barcode ~ '[[:cntrl:]]')) then raise exception 'invalid_product'; end if;
  if p_product_id is null then
    insert into public.products(merchant_id,name,price_cents,barcode,active) values(p_merchant_id,trim(p_name),p_price_cents,p_barcode,p_active) returning * into p;
  else
    update public.products set name=trim(p_name),price_cents=p_price_cents,barcode=p_barcode,active=p_active,updated_at=now()
      where id=p_product_id and merchant_id=p_merchant_id returning * into p;
    if not found then raise exception 'product_not_found'; end if;
  end if;
  insert into public.audit_log(merchant_id,actor,action,details) values(p_merchant_id,p_actor_user_id::text,'product.saved',jsonb_build_object('product_id',p.id,'active',p.active));
  return p;
end; $$;

create function public.set_merchant_member(p_merchant_id uuid,p_actor_user_id uuid,p_user_id uuid,p_display_name text,p_role text,p_active boolean)
returns public.merchant_members language plpgsql security definer set search_path = '' as $$
declare m public.merchants; mm public.merchant_members;
begin
  select * into m from public.merchants where id=p_merchant_id for update;
  if not found or not exists(select 1 from public.merchant_members where merchant_id=p_merchant_id and user_id=p_actor_user_id and role='admin' and active) then raise exception 'admin_required'; end if;
  if p_user_id is null or p_display_name is null or length(trim(p_display_name)) not between 1 and 100 or p_role is null or p_role not in ('admin','cashier') or p_active is null then raise exception 'invalid_member'; end if;
  if not exists(select 1 from auth.users where id=p_user_id) then raise exception 'auth_user_not_found'; end if;
  -- Serialize assignments of the same auth user across distinct merchant locks.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('member:'||p_user_id::text,0));
  select * into mm from public.merchant_members where user_id=p_user_id for update;
  if found and mm.merchant_id <> p_merchant_id then raise exception 'member_other_merchant'; end if;
  if m.owner_user_id=p_user_id and (p_role<>'admin' or not p_active) then raise exception 'owner_membership_protected'; end if;
  if mm.active and mm.role='admin' and (p_role<>'admin' or not p_active)
    and (select count(*) from public.merchant_members where merchant_id=p_merchant_id and active and role='admin')<=1 then raise exception 'last_admin_protected'; end if;
  insert into public.merchant_members(user_id,merchant_id,display_name,role,active) values(p_user_id,p_merchant_id,trim(p_display_name),p_role,p_active)
    on conflict(user_id) do update set display_name=excluded.display_name,role=excluded.role,active=excluded.active returning * into mm;
  insert into public.audit_log(merchant_id,actor,action,details) values(p_merchant_id,p_actor_user_id::text,'member.saved',jsonb_build_object('user_id',p_user_id,'role',p_role,'active',p_active));
  return mm;
end; $$;

create function public.attach_merchant_member_by_email(p_merchant_id uuid,p_actor_user_id uuid,p_email text,p_display_name text,p_role text,p_active boolean)
returns public.merchant_members language plpgsql security definer set search_path = '' as $$
declare v_user uuid;
begin
  if not exists(select 1 from public.merchant_members where merchant_id=p_merchant_id and user_id=p_actor_user_id and role='admin' and active) then raise exception 'admin_required'; end if;
  if p_email is null or length(trim(p_email)) not between 3 and 254 then raise exception 'invalid_member_email'; end if;
  select id into v_user from auth.users where lower(email)=lower(trim(p_email));
  if not found then raise exception 'auth_user_not_found'; end if;
  if (select count(*) from auth.users where lower(email)=lower(trim(p_email)))<>1 then raise exception 'ambiguous_auth_user'; end if;
  return public.set_merchant_member(p_merchant_id,p_actor_user_id,v_user,p_display_name,p_role,p_active);
end; $$;

create function public.reserve_product_charge(p_merchant_id uuid,p_actor_user_id uuid,p_items jsonb,p_idempotency_key uuid)
returns public.charges language plpgsql security definer set search_path = '' as $$
declare m public.merchants; c public.charges; v_item jsonb; v_canonical jsonb; v_existing jsonb; v_total bigint; v_count integer;
begin
  if p_merchant_id is null or p_actor_user_id is null or p_idempotency_key is null or p_items is null or jsonb_typeof(p_items)<>'array' then raise exception 'invalid_cart'; end if;
  v_count := jsonb_array_length(p_items);
  if v_count not between 1 and 50 then raise exception 'invalid_cart'; end if;
  for v_item in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_item)<>'object' then raise exception 'invalid_cart'; end if;
    if (select count(*) from jsonb_object_keys(v_item))<>2 or not (v_item ? 'product_id' and v_item ? 'quantity')
      or jsonb_typeof(v_item->'product_id')<>'string' or jsonb_typeof(v_item->'quantity')<>'number'
      or (v_item->>'product_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or (v_item->>'quantity') !~ '^[1-9][0-9]{0,2}$' then raise exception 'invalid_cart'; end if;
  end loop;
  if (select count(distinct (value->>'product_id')::uuid) from jsonb_array_elements(p_items))<>v_count then raise exception 'duplicate_cart_product'; end if;
  select jsonb_agg(jsonb_build_object('product_id',(value->>'product_id')::uuid,'quantity',(value->>'quantity')::integer) order by (value->>'product_id')::uuid)
    into v_canonical from jsonb_array_elements(p_items);
  select * into m from public.merchants where id=p_merchant_id for update;
  if not found or not exists(select 1 from public.merchant_members where merchant_id=p_merchant_id and user_id=p_actor_user_id and active) then raise exception 'merchant_not_found'; end if;
  select * into c from public.charges where merchant_id=p_merchant_id and idempotency_key=p_idempotency_key;
  if found then
    select jsonb_agg(jsonb_build_object('product_id',product_id,'quantity',quantity) order by product_id) into v_existing from public.charge_items where charge_id=c.id;
    if c.created_by<>p_actor_user_id or v_existing is distinct from v_canonical then raise exception 'idempotency_conflict'; end if;
    return c;
  end if;
  -- Product saves acquire this same merchant lock; prices cannot change mid-snapshot.
  if (select count(*) from public.products p join jsonb_array_elements(v_canonical) i on p.id=(i->>'product_id')::uuid where p.merchant_id=p_merchant_id and p.active)<>v_count then raise exception 'cart_product_unavailable'; end if;
  select sum(p.price_cents::bigint*(i->>'quantity')::integer) into v_total from public.products p join jsonb_array_elements(v_canonical) i on p.id=(i->>'product_id')::uuid where p.merchant_id=p_merchant_id;
  if v_total is null or v_total<1 or v_total>m.max_amount_cents then raise exception 'invalid_amount'; end if;
  if (select count(*) from public.charges where merchant_id=m.id and created_at>now()-interval '1 minute')>=10 then raise exception 'rate_limited'; end if;
  if m.next_num_ref>9999999 then raise exception 'reference_exhausted'; end if;
  insert into public.charges(merchant_id,created_by,idempotency_key,amount_cents,concept,num_ref)
    values(m.id,p_actor_user_id,p_idempotency_key,v_total::integer,'Venta de '||v_count||' producto(s)',m.next_num_ref::text) returning * into c;
  insert into public.charge_items(charge_id,merchant_id,product_id,name,unit_price_cents,quantity)
    select c.id,m.id,p.id,p.name,p.price_cents,(i->>'quantity')::integer from public.products p join jsonb_array_elements(v_canonical) i on p.id=(i->>'product_id')::uuid where p.merchant_id=m.id;
  update public.merchants set next_num_ref=next_num_ref+1 where id=m.id;
  insert into public.audit_log(merchant_id,actor,action,details) values(m.id,p_actor_user_id::text,'charge.created',jsonb_build_object('charge_id',c.id,'source','catalog','items',v_count));
  return c;
end; $$;

-- Existing charge/payment RPCs are replaced below with membership-aware authorization.

create or replace function public.reserve_charge(
  p_merchant_id uuid, p_owner_user_id uuid, p_amount_cents integer,
  p_concept text, p_idempotency_key uuid
) returns public.charges language plpgsql security definer set search_path = '' as $$
declare m public.merchants; c public.charges;
begin
  if p_merchant_id is null or p_owner_user_id is null or p_idempotency_key is null then raise exception 'invalid_charge_request'; end if;
  select * into m from public.merchants where id = p_merchant_id for update;
  if not found or not exists(select 1 from public.merchant_members where merchant_id=p_merchant_id and user_id=p_owner_user_id and active) then raise exception 'merchant_not_found'; end if;
  select * into c from public.charges where merchant_id = m.id and idempotency_key = p_idempotency_key;
  if found then
    if c.created_by <> p_owner_user_id or c.amount_cents is distinct from p_amount_cents or c.concept is distinct from trim(p_concept) or exists(select 1 from public.charge_items where charge_id=c.id) then raise exception 'idempotency_conflict'; end if;
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

create or replace function public.cancel_charge(p_charge_id uuid, p_owner_user_id uuid)
returns public.charges language plpgsql security definer set search_path = '' as $$
declare c public.charges;
begin
  if p_charge_id is null or p_owner_user_id is null then raise exception 'invalid_charge_request'; end if;
  select ch.* into c from public.charges ch join public.merchants m on m.id = ch.merchant_id
    where ch.id = p_charge_id and exists(select 1 from public.merchant_members mm where mm.merchant_id=ch.merchant_id and mm.user_id=p_owner_user_id and mm.active and (mm.role='admin' or ch.created_by=p_owner_user_id)) for update of ch;
  if not found then raise exception 'charge_not_found'; end if;
  if c.status = 'cancelled' then return c; end if;
  if c.status not in ('pending','expired') or c.payment_status <> 'unpaid' then raise exception 'invalid_charge_state'; end if;
  update public.charges set status = 'cancelled', cancelled_at = now() where id = c.id returning * into c;
  insert into public.audit_log(merchant_id, actor, action, details) values (c.merchant_id, p_owner_user_id::text, 'charge.cancelled', jsonb_build_object('charge_id', c.id));
  return c;
end;
$$;

create or replace function public.daily_corte(p_merchant_id uuid, p_owner_user_id uuid, p_date date)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_start timestamptz; v_end timestamptz; v_result jsonb; v_pending bigint; v_role text;
begin
  if p_merchant_id is null or p_owner_user_id is null or p_date is null or not isfinite(p_date) then
    raise exception 'invalid_corte_request';
  end if;
  select role into v_role from public.merchant_members where merchant_id=p_merchant_id and user_id=p_owner_user_id and active;
  if not found then
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
    where merchant_id = p_merchant_id and paid_at >= v_start and paid_at < v_end
      and (v_role='admin' or exists(select 1 from public.charges c where c.id=charge_id and c.created_by=p_owner_user_id));
  select count(*) into v_pending from public.charges
    where merchant_id = p_merchant_id and created_at >= v_start and created_at < v_end
      and (v_role='admin' or created_by=p_owner_user_id) and status = 'pending' and payment_status = 'unpaid' and expires_at > now();
  return v_result || jsonb_build_object('pending_count', v_pending);
end;
$$;

create or replace function public.reconcile_pey_payment(
  p_merchant_id uuid, p_owner_user_id uuid, p_charge_id uuid,
  p_pey_api_key_id text, p_pey_ref text, p_transaction_id text,
  p_amount_cents integer, p_paid_at timestamptz
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare c public.charges; r public.payment_receipts; v_review boolean; v_late boolean; v_outcome text;
begin
  if p_merchant_id is null or p_owner_user_id is null or p_charge_id is null
    or p_pey_api_key_id is null or length(p_pey_api_key_id) not between 1 and 255
    or p_pey_api_key_id <> trim(p_pey_api_key_id)
    or p_pey_api_key_id ~ '[[:space:][:cntrl:]]'
    or p_pey_ref is null or length(p_pey_ref) not between 1 and 255 or p_pey_ref <> trim(p_pey_ref)
    or p_pey_ref ~ '[[:space:][:cntrl:]]'
    or p_transaction_id is null or length(p_transaction_id) not between 1 and 255 or p_transaction_id <> trim(p_transaction_id)
    or p_transaction_id ~ '[[:space:][:cntrl:]]'
    or p_amount_cents is null or p_amount_cents < 1
    or p_paid_at is null or not isfinite(p_paid_at)
    or p_paid_at < '2000-01-01 00:00:00+00'::timestamptz
    or p_paid_at > clock_timestamp() + interval '5 minutes' then
    raise exception 'invalid_reconciliation_request';
  end if;
  -- Same charge-row then transaction advisory-lock ordering as the webhook RPC.
  select ch.* into c from public.charges ch join public.merchants m on m.id = ch.merchant_id
    where ch.id = p_charge_id and ch.merchant_id = p_merchant_id
      and exists(select 1 from public.merchant_members mm where mm.merchant_id=ch.merchant_id and mm.user_id=p_owner_user_id and mm.active and (mm.role='admin' or ch.created_by=p_owner_user_id))
      and m.pey_api_key_id = p_pey_api_key_id
      and ch.pey_ref = p_pey_ref for update of ch;
  if not found then raise exception 'reconciliation_charge_not_found'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_transaction_id, 0));
  select * into r from public.payment_receipts where transaction_id = p_transaction_id;
  if found then
    if r.charge_id <> c.id or r.amount_cents <> p_amount_cents or r.paid_at <> p_paid_at then
      insert into public.audit_log(merchant_id,actor,action,details)
        values (c.merchant_id,'api_reconciliation','payment.transaction_conflict',
          jsonb_build_object('charge_id',c.id,'transaction_id',p_transaction_id,'requested_by',p_owner_user_id));
      return jsonb_build_object('outcome','transaction_conflict','charge_id',c.id,'retry',false);
    end if;
    return jsonb_build_object('outcome','duplicate_transaction','charge_id',c.id,'retry',false);
  end if;
  v_review := c.amount_cents <> p_amount_cents or c.transaction_id is not null or c.payment_status = 'review';
  v_late := c.status in ('expired','cancelled','failed') or p_paid_at > c.expires_at;
  insert into public.payment_receipts(transaction_id,charge_id,merchant_id,webhook_id,amount_cents,paid_at,needs_review,source)
    values (p_transaction_id,c.id,c.merchant_id,null,p_amount_cents,p_paid_at,v_review,'api_reconciliation');
  if v_review then
    update public.charges set status = 'review', payment_status = 'review', late_payment = late_payment or v_late where id = c.id;
    v_outcome := 'review';
  else
    update public.charges set status = 'paid', payment_status = 'paid', transaction_id = p_transaction_id,
      paid_at = p_paid_at, late_payment = v_late where id = c.id;
    v_outcome := case when v_late then 'paid_late' else 'paid' end;
  end if;
  insert into public.audit_log(merchant_id,actor,action,details)
    values (c.merchant_id,'api_reconciliation',case when v_review then 'payment.review' else 'payment.reconciled' end,
      jsonb_build_object('charge_id',c.id,'transaction_id',p_transaction_id,'outcome',v_outcome,'requested_by',p_owner_user_id));
  return jsonb_build_object('outcome',v_outcome,'charge_id',c.id,'retry',false);
end;
$$;

revoke all on function public.save_product(uuid,uuid,uuid,text,integer,text,boolean) from public,anon,authenticated;
grant execute on function public.save_product(uuid,uuid,uuid,text,integer,text,boolean) to service_role;

revoke all on function public.set_merchant_member(uuid,uuid,uuid,text,text,boolean) from public,anon,authenticated;
grant execute on function public.set_merchant_member(uuid,uuid,uuid,text,text,boolean) to service_role;

revoke all on function public.attach_merchant_member_by_email(uuid,uuid,text,text,text,boolean) from public,anon,authenticated;
grant execute on function public.attach_merchant_member_by_email(uuid,uuid,text,text,text,boolean) to service_role;

revoke all on function public.reserve_product_charge(uuid,uuid,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.reserve_product_charge(uuid,uuid,jsonb,uuid) to service_role;

create function public.list_merchant_team(p_merchant_id uuid,p_actor_user_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_result jsonb;
begin
  if not exists(select 1 from public.merchant_members where merchant_id=p_merchant_id and user_id=p_actor_user_id and role='admin' and active) then raise exception 'admin_required'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('user_id',mm.user_id,'email',u.email,'display_name',mm.display_name,
    'role',mm.role,'active',mm.active,'created_at',mm.created_at,'is_owner',m.owner_user_id=mm.user_id)
    order by (m.owner_user_id=mm.user_id) desc,mm.display_name,mm.user_id),'[]'::jsonb) into v_result
    from public.merchant_members mm join auth.users u on u.id=mm.user_id join public.merchants m on m.id=mm.merchant_id
    where mm.merchant_id=p_merchant_id;
  return v_result;
end; $$;
revoke all on function public.list_merchant_team(uuid,uuid) from public,anon,authenticated;
grant execute on function public.list_merchant_team(uuid,uuid) to service_role;

notify pgrst, 'reload schema';
commit;
