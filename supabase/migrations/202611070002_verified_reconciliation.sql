-- Apply AFTER 202611070001_initial.sql. No external API calls are made by SQL.
begin;

alter table public.payment_receipts
  add column source text not null default 'webhook'
    check (source in ('webhook','api_reconciliation'));
alter table public.payment_receipts alter column webhook_id drop not null;
alter table public.payment_receipts add constraint payment_receipts_source_webhook_check
  check ((source = 'webhook' and webhook_id is not null)
      or (source = 'api_reconciliation' and webhook_id is null));

-- TRUST BOUNDARY: the server must authenticate the owner and fetch this exact
-- settled transaction from Pey's authenticated API BEFORE invoking this RPC.
-- This function validates stored relationships; it does not contact Pey itself.
create function public.reconcile_pey_payment(
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
      and m.owner_user_id = p_owner_user_id and m.pey_api_key_id = p_pey_api_key_id
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

revoke all on function public.reconcile_pey_payment(uuid,uuid,uuid,text,text,text,integer,timestamptz) from public,anon,authenticated;
grant execute on function public.reconcile_pey_payment(uuid,uuid,uuid,text,text,text,integer,timestamptz) to service_role;
commit;
