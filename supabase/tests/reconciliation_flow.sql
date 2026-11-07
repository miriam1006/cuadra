-- Run as administrator after migrations 001 and 002; all fixture changes roll back.
begin;
insert into auth.users(id,email) values
 ('11000000-0000-4000-8000-000000000001','reconcile-one@example.invalid'),
 ('11000000-0000-4000-8000-000000000002','reconcile-two@example.invalid');
insert into public.merchants(id,owner_user_id,name,pey_api_key_id) values
 ('21000000-0000-4000-8000-000000000001','11000000-0000-4000-8000-000000000001','Reconcile one','reconcile-key-one'),
 ('21000000-0000-4000-8000-000000000002','11000000-0000-4000-8000-000000000002','Reconcile two','reconcile-key-two');
set local role service_role;
do $$
declare
  c public.charges; d public.charges; result jsonb; fixed_time timestamptz := now();
  yesterday timestamptz := now() - interval '1 day';
  merchant uuid := '21000000-0000-4000-8000-000000000001';
  owner_id uuid := '11000000-0000-4000-8000-000000000001';
begin
  -- API-first recovery: retain actual old payment time, even when request is long expired.
  c := public.reserve_charge(merchant,owner_id,100,'Recuperado','31000000-0000-4000-8000-000000000001');
  perform public.finalize_charge(c.id,'reconcile-qr-a','qr-a');
  update public.charges set created_at = yesterday - interval '1 hour', expires_at = yesterday - interval '30 minutes', status = 'expired' where id = c.id;
  result := public.reconcile_pey_payment(merchant,owner_id,c.id,'reconcile-key-one','reconcile-qr-a','reconcile-tx-a',100,yesterday);
  if result->>'outcome' <> 'paid_late' then raise exception 'FAIL: reconciliation late recovery'; end if;
  if (select paid_at from public.charges where id = c.id) <> yesterday then raise exception 'FAIL: original paid_at lost'; end if;
  if not exists (select 1 from public.payment_receipts where transaction_id = 'reconcile-tx-a' and source = 'api_reconciliation' and webhook_id is null) then raise exception 'FAIL: API provenance'; end if;
  if exists (select 1 from public.webhook_events) then raise exception 'FAIL: reconciliation synthesized webhook'; end if;
  result := public.reconcile_pey_payment(merchant,owner_id,c.id,'reconcile-key-one','reconcile-qr-a','reconcile-tx-a',100,yesterday);
  if result->>'outcome' <> 'duplicate_transaction' then raise exception 'FAIL: reconciliation duplicate'; end if;
  result := public.process_pey_payment('reconcile-event-a','{}','reconcile-key-one','reconcile-qr-a','reconcile-tx-a',100,yesterday);
  if result->>'outcome' <> 'duplicate_transaction' then raise exception 'FAIL: webhook after reconciliation'; end if;
  if (select count(*) from public.payment_receipts where charge_id = c.id) <> 1 then raise exception 'FAIL: API/webhook double receipt'; end if;
  result := public.daily_corte(merchant,owner_id,(yesterday at time zone 'America/Mexico_City')::date);
  if (result->>'total_paid_cents')::integer <> 100 or (result->>'paid_count')::integer <> 1 then raise exception 'FAIL: original payment day corte'; end if;

  -- Webhook-first remains a webhook receipt and API replay adds nothing.
  c := public.reserve_charge(merchant,owner_id,200,'Webhook primero','31000000-0000-4000-8000-000000000002');
  perform public.finalize_charge(c.id,'reconcile-qr-b','qr-b');
  result := public.process_pey_payment('reconcile-event-b','{}','reconcile-key-one','reconcile-qr-b','reconcile-tx-b',200,fixed_time);
  result := public.reconcile_pey_payment(merchant,owner_id,c.id,'reconcile-key-one','reconcile-qr-b','reconcile-tx-b',200,fixed_time);
  if result->>'outcome' <> 'duplicate_transaction' then raise exception 'FAIL: API after webhook'; end if;
  if not exists (select 1 from public.payment_receipts where transaction_id = 'reconcile-tx-b' and source = 'webhook' and webhook_id = 'reconcile-event-b') then raise exception 'FAIL: original webhook provenance changed'; end if;
  result := public.reconcile_pey_payment(merchant,owner_id,c.id,'reconcile-key-one','reconcile-qr-b','reconcile-tx-b',201,fixed_time);
  if result->>'outcome' <> 'transaction_conflict' then raise exception 'FAIL: changed duplicate amount'; end if;

  c := public.reserve_charge(merchant,owner_id,300,'Diferencia','31000000-0000-4000-8000-000000000003');
  perform public.finalize_charge(c.id,'reconcile-qr-c','qr-c');
  result := public.reconcile_pey_payment(merchant,owner_id,c.id,'reconcile-key-one','reconcile-qr-c','reconcile-tx-c',299,fixed_time);
  if result->>'outcome' <> 'review' then raise exception 'FAIL: reconciliation mismatch'; end if;
  result := public.reconcile_pey_payment(merchant,owner_id,c.id,'reconcile-key-one','reconcile-qr-c','reconcile-tx-c2',300,fixed_time);
  if result->>'outcome' <> 'review' then raise exception 'FAIL: unresolved mismatch cleared'; end if;

  d := public.reserve_charge(merchant,owner_id,400,'Pago extra','31000000-0000-4000-8000-000000000004');
  perform public.finalize_charge(d.id,'reconcile-qr-d','qr-d');
  result := public.reconcile_pey_payment(merchant,owner_id,d.id,'reconcile-key-one','reconcile-qr-d','reconcile-tx-d',400,fixed_time);
  if result->>'outcome' <> 'paid' then raise exception 'FAIL: reconciliation paid'; end if;
  result := public.reconcile_pey_payment(merchant,owner_id,d.id,'reconcile-key-one','reconcile-qr-d','reconcile-tx-d2',400,fixed_time);
  if result->>'outcome' <> 'review' or (select transaction_id from public.charges where id = d.id) <> 'reconcile-tx-d' then raise exception 'FAIL: extra payment review'; end if;
  result := public.daily_corte(merchant,owner_id,(fixed_time at time zone 'America/Mexico_City')::date);
  if (result->>'total_paid_cents')::integer <> 600 or (result->>'paid_count')::integer <> 2 then raise exception 'FAIL: corte duplicates or lost first valid receipt'; end if;
  if (result->>'review_receipt_count')::integer <> 3 or (result->>'review_amount_cents')::integer <> 999 then raise exception 'FAIL: review corte'; end if;

  -- Exact owner/key/charge/QR scoping; failed calls do not create receipts/audits.
  c := public.reserve_charge(merchant,owner_id,500,'Vencido ahora','31000000-0000-4000-8000-000000000005');
  perform public.finalize_charge(c.id,'reconcile-qr-e','qr-e');
  begin
    perform public.reconcile_pey_payment(merchant,'11000000-0000-4000-8000-000000000002',c.id,'reconcile-key-one','reconcile-qr-e','reconcile-tx-invalid',500,fixed_time);
    raise exception 'FAIL: wrong owner accepted';
  exception when raise_exception then if sqlerrm <> 'reconciliation_charge_not_found' then raise; end if; end;
  begin
    perform public.reconcile_pey_payment(merchant,owner_id,c.id,'reconcile-key-two','reconcile-qr-e','reconcile-tx-invalid',500,fixed_time);
    raise exception 'FAIL: wrong key accepted';
  exception when raise_exception then if sqlerrm <> 'reconciliation_charge_not_found' then raise; end if; end;
  begin
    perform public.reconcile_pey_payment(merchant,owner_id,c.id,'reconcile-key-one','reconcile-qr-d','reconcile-tx-invalid',500,fixed_time);
    raise exception 'FAIL: wrong QR accepted';
  exception when raise_exception then if sqlerrm <> 'reconciliation_charge_not_found' then raise; end if; end;
  begin
    perform public.reconcile_pey_payment('21000000-0000-4000-8000-000000000002',owner_id,c.id,'reconcile-key-one','reconcile-qr-e','reconcile-tx-invalid',500,fixed_time);
    raise exception 'FAIL: wrong merchant accepted';
  exception when raise_exception then if sqlerrm <> 'reconciliation_charge_not_found' then raise; end if; end;
  begin
    perform public.reconcile_pey_payment(merchant,owner_id,c.id,'reconcile-key-one','reconcile-qr-e','reconcile-tx-invalid',500,fixed_time + interval '1 hour');
    raise exception 'FAIL: future paid_at accepted';
  exception when raise_exception then if sqlerrm <> 'invalid_reconciliation_request' then raise; end if; end;
  begin
    perform public.reconcile_pey_payment(merchant,owner_id,c.id,'reconcile-key-one','reconcile-qr-e','',500,fixed_time);
    raise exception 'FAIL: empty transaction accepted';
  exception when raise_exception then if sqlerrm <> 'invalid_reconciliation_request' then raise; end if; end;
  if exists (select 1 from public.payment_receipts where charge_id = c.id) then raise exception 'FAIL: rejected scope created receipt'; end if;
  -- It was paid before expiration; discovering it after current expiry does not change paid_at.
  update public.charges set expires_at = fixed_time - interval '30 seconds' where id = c.id;
  result := public.reconcile_pey_payment(merchant,owner_id,c.id,'reconcile-key-one','reconcile-qr-e','reconcile-tx-e',500,fixed_time - interval '1 minute');
  if result->>'outcome' <> 'paid' or (select paid_at from public.charges where id = c.id) <> fixed_time - interval '1 minute' then raise exception 'FAIL: payment judged using current clock'; end if;

  -- Same transaction cannot move between charges or merchants.
  c := public.reserve_charge('21000000-0000-4000-8000-000000000002','11000000-0000-4000-8000-000000000002',200,'Otro comercio','31000000-0000-4000-8000-000000000006');
  perform public.finalize_charge(c.id,'reconcile-qr-other','qr-other');
  result := public.reconcile_pey_payment(c.merchant_id,c.created_by,c.id,'reconcile-key-two','reconcile-qr-other','reconcile-tx-b',200,fixed_time);
  if result->>'outcome' <> 'transaction_conflict' then raise exception 'FAIL: cross merchant transaction reassigned'; end if;
  if exists (select 1 from public.payment_receipts where charge_id = c.id) then raise exception 'FAIL: conflict created receipt'; end if;
  -- Database enforces provenance pairings even for privileged direct writes.
  begin
    insert into public.payment_receipts(transaction_id,charge_id,merchant_id,amount_cents,paid_at,source)
      values ('invalid-source-webhook',c.id,c.merchant_id,1,fixed_time,'webhook');
    raise exception 'FAIL: webhook receipt accepted without event';
  exception when check_violation then null; end;
  begin
    insert into public.payment_receipts(transaction_id,charge_id,merchant_id,webhook_id,amount_cents,paid_at,source)
      values ('invalid-source-api',c.id,c.merchant_id,'reconcile-event-b',1,fixed_time,'api_reconciliation');
    raise exception 'FAIL: API receipt accepted with synthetic webhook';
  exception when check_violation then null; end;
  if not exists (select 1 from public.audit_log where actor = 'api_reconciliation' and action = 'payment.reconciled') then raise exception 'FAIL: reconciliation audit missing'; end if;
end;
$$;
reset role;
set local role authenticated;
do $$ begin
  begin
    perform public.reconcile_pey_payment('21000000-0000-4000-8000-000000000001','11000000-0000-4000-8000-000000000001',gen_random_uuid(),'reconcile-key-one','qr','tx',1,now());
    raise exception 'FAIL: authenticated can reconcile';
  exception when insufficient_privilege then null; end;
end; $$;
reset role;
set local role anon;
do $$ begin
  begin
    perform public.reconcile_pey_payment('21000000-0000-4000-8000-000000000001','11000000-0000-4000-8000-000000000001',gen_random_uuid(),'reconcile-key-one','qr','tx',1,now());
    raise exception 'FAIL: anon can reconcile';
  exception when insufficient_privilege then null; end;
end; $$;
reset role;
rollback;
