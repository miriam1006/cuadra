-- Run with a Supabase administrator after the migration, on a test project.
-- All fixtures and changes roll back. The script raises on the first regression.
begin;
insert into auth.users(id,email) values
 ('10000000-0000-4000-8000-000000000001','caja-test-one@example.invalid'),
 ('10000000-0000-4000-8000-000000000002','caja-test-two@example.invalid');
insert into public.merchants(id,owner_user_id,name,pey_api_key_id) values
 ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Test one','test-key-one'),
 ('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','Test two','test-key-two');

set local role service_role;
do $$
declare c public.charges; same_charge public.charges; claimed public.charges; result jsonb; fixed_time timestamptz := now();
begin
  c := public.reserve_charge('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',100,'Pago normal','30000000-0000-4000-8000-000000000001');
  same_charge := public.reserve_charge(c.merchant_id,c.created_by,100,'Pago normal',c.idempotency_key);
  if same_charge.id <> c.id then raise exception 'FAIL: reserve idempotency'; end if;
  begin
    perform public.reserve_charge(c.merchant_id,c.created_by,101,'Pago normal',c.idempotency_key);
    raise exception 'FAIL: changed amount accepted';
  exception when raise_exception then
    if sqlerrm <> 'idempotency_conflict' then raise; end if;
  end;
  begin
    perform public.reserve_charge(c.merchant_id,c.created_by,100,'Pago normal',null);
    raise exception 'FAIL: null idempotency key accepted';
  exception when raise_exception then
    if sqlerrm <> 'invalid_charge_request' then raise; end if;
  end;
  claimed := public.claim_charge_creation(c.id);
  if claimed.id <> c.id then raise exception 'FAIL: initial claim'; end if;
  claimed := public.claim_charge_creation(c.id);
  if claimed.id is not null then raise exception 'FAIL: duplicate claim'; end if;
  -- Webhook can arrive before finalization. Same event must process on retry.
  result := public.process_pey_payment('test-event-1','{"type":"codi.qr.payment_received"}','test-key-one','test-qr-1','test-tx-1',100,fixed_time);
  if result->>'outcome' <> 'unmatched' or result->>'retry' <> 'true' then raise exception 'FAIL: unmatched retry'; end if;
  perform public.finalize_charge(c.id,'test-qr-1','test-qr-string-1');
  result := public.process_pey_payment('test-event-1','{"type":"codi.qr.payment_received"}','test-key-one','test-qr-1','test-tx-1',100,fixed_time);
  if result->>'outcome' <> 'paid' then raise exception 'FAIL: paid after unmatched'; end if;
  result := public.process_pey_payment('test-event-1','{"type":"codi.qr.payment_received"}','test-key-one','test-qr-1','test-tx-1',100,fixed_time);
  if result->>'outcome' <> 'duplicate' then raise exception 'FAIL: duplicate event'; end if;
  result := public.process_pey_payment('test-event-2','{}','test-key-one','test-qr-1','test-tx-1',100,fixed_time);
  if result->>'outcome' <> 'duplicate_transaction' then raise exception 'FAIL: duplicate transaction'; end if;
  if (select count(*) from public.payment_receipts where charge_id = c.id) <> 1 then raise exception 'FAIL: double receipt'; end if;
  begin
    perform public.cancel_charge(c.id,c.created_by);
    raise exception 'FAIL: cancelled a paid charge';
  exception when raise_exception then
    if sqlerrm <> 'invalid_charge_state' then raise; end if;
  end;
  result := public.process_pey_payment('test-event-3','{}','test-key-one','test-qr-1','test-tx-extra',100,fixed_time);
  if result->>'outcome' <> 'review' then raise exception 'FAIL: extra payment review'; end if;
  if (select count(*) from public.payment_receipts where charge_id = c.id) <> 2 then raise exception 'FAIL: extra payment lost'; end if;
  if (select transaction_id from public.charges where id = c.id) <> 'test-tx-1' then raise exception 'FAIL: first folio overwritten'; end if;

  c := public.reserve_charge('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',100,'Monto distinto','30000000-0000-4000-8000-000000000002');
  perform public.finalize_charge(c.id,'test-qr-2','test-qr-string-2');
  result := public.process_pey_payment('test-event-4','{}','test-key-one','test-qr-2','test-tx-2',99,fixed_time);
  if result->>'outcome' <> 'review' or (select payment_status from public.charges where id = c.id) <> 'review' then raise exception 'FAIL: amount mismatch'; end if;
  result := public.process_pey_payment('test-event-4b','{}','test-key-one','test-qr-2','test-tx-2b',100,fixed_time);
  if result->>'outcome' <> 'review' then raise exception 'FAIL: later matching payment cleared unresolved review'; end if;

  c := public.reserve_charge('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',100,'Pago tardío','30000000-0000-4000-8000-000000000003');
  perform public.finalize_charge(c.id,'test-qr-3','test-qr-string-3');
  perform public.cancel_charge(c.id,c.created_by);
  result := public.process_pey_payment('test-event-5','{}','test-key-one','test-qr-3','test-tx-3',100,fixed_time);
  if result->>'outcome' <> 'paid_late' or not (select late_payment from public.charges where id = c.id) then raise exception 'FAIL: cancelled late payment'; end if;

  c := public.reserve_charge('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',100,'Vencido','30000000-0000-4000-8000-000000000004');
  perform public.finalize_charge(c.id,'test-qr-4','test-qr-string-4');
  update public.charges set expires_at = fixed_time - interval '1 minute' where id = c.id;
  result := public.process_pey_payment('test-event-6','{}','test-key-one','test-qr-4','test-tx-4',100,fixed_time);
  if result->>'outcome' <> 'paid_late' then raise exception 'FAIL: expiration late payment'; end if;

  c := public.reserve_charge('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002',100,'Otro comercio','30000000-0000-4000-8000-000000000005');
  perform public.finalize_charge(c.id,'test-qr-5','test-qr-string-5');
  result := public.process_pey_payment('test-event-7','{}','test-key-one','test-qr-5','test-tx-5',100,fixed_time);
  if result->>'outcome' <> 'unmatched' then raise exception 'FAIL: wrong key matched other merchant'; end if;
  result := public.process_pey_payment('test-event-8','{}','test-key-two','test-qr-5','test-tx-1',100,fixed_time);
  if result->>'outcome' <> 'transaction_conflict' then raise exception 'FAIL: conflicting transaction'; end if;
  if (select payment_status from public.charges where id = c.id) <> 'unpaid' then raise exception 'FAIL: conflict marked paid'; end if;

  -- Recover a successful/ambiguous provider POST whose finalize write was lost.
  c := public.reserve_charge('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',100,'Recuperación','30000000-0000-4000-8000-000000000006');
  result := public.process_pey_payment('test-event-recover',jsonb_build_object('type','codi.qr.payment_received','numRef',c.num_ref),'test-key-one','test-qr-recovered','test-tx-recovered',100,fixed_time);
  if result->>'outcome' <> 'unmatched' then raise exception 'FAIL: recovery without provider claim'; end if;
  perform public.claim_charge_creation(c.id);
  result := public.process_pey_payment('test-event-wrong-ref',jsonb_build_object('type','codi.qr.payment_received','numRef','9999999'),'test-key-one','test-qr-recovered','test-tx-recovered',100,fixed_time);
  if result->>'outcome' <> 'unmatched' then raise exception 'FAIL: recovery with wrong reference'; end if;
  result := public.process_pey_payment('test-event-wrong-key',jsonb_build_object('type','codi.qr.payment_received','numRef',c.num_ref),'test-key-two','test-qr-recovered','test-tx-recovered',100,fixed_time);
  if result->>'outcome' <> 'unmatched' then raise exception 'FAIL: recovery with wrong API key'; end if;
  result := public.process_pey_payment('test-event-recover',jsonb_build_object('type','codi.qr.payment_received','numRef',c.num_ref),'test-key-one','test-qr-recovered','test-tx-recovered',100,fixed_time);
  if result->>'outcome' <> 'paid' then raise exception 'FAIL: signed reference recovery'; end if;
  if (select pey_ref from public.charges where id = c.id) <> 'test-qr-recovered' then raise exception 'FAIL: provider reference not persisted'; end if;
  -- A later conflicting reference must never replace the recovered one.
  result := public.process_pey_payment('test-event-recover-conflict',jsonb_build_object('type','codi.qr.payment_received','numRef',c.num_ref),'test-key-one','test-qr-other','test-tx-other',100,fixed_time);
  if result->>'outcome' <> 'unmatched' then raise exception 'FAIL: rebound existing provider reference'; end if;

  c := public.reserve_charge('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',50,'Pendiente','30000000-0000-4000-8000-000000000007');
  perform public.finalize_charge(c.id,'test-qr-pending','test-qr-pending-string');
  result := public.daily_corte(c.merchant_id,c.created_by,(fixed_time at time zone 'America/Mexico_City')::date);
  if (result->>'total_paid_cents')::bigint <> 400 or (result->>'paid_count')::bigint <> 4 then
    raise exception 'FAIL: corte lost first valid payment after additional receipt review';
  end if;
  if (result->>'review_receipt_count')::bigint <> 3 or (result->>'review_amount_cents')::bigint <> 299 then
    raise exception 'FAIL: corte review receipts';
  end if;
  if (result->>'pending_count')::bigint <> 1 then raise exception 'FAIL: corte pending count'; end if;
  update public.charges set expires_at = fixed_time - interval '1 minute' where id = c.id;
  result := public.daily_corte(c.merchant_id,c.created_by,(fixed_time at time zone 'America/Mexico_City')::date);
  if (result->>'pending_count')::bigint <> 0 then raise exception 'FAIL: corte counted expired pending charge'; end if;
  result := public.daily_corte(c.merchant_id,c.created_by,(fixed_time at time zone 'America/Mexico_City')::date - 1);
  if (result->>'total_paid_cents')::bigint <> 0 or (result->>'paid_count')::bigint <> 0 then raise exception 'FAIL: corte wrong day'; end if;
  begin
    perform public.daily_corte(c.merchant_id,'10000000-0000-4000-8000-000000000002',(fixed_time at time zone 'America/Mexico_City')::date);
    raise exception 'FAIL: corte wrong owner accepted';
  exception when raise_exception then
    if sqlerrm <> 'merchant_not_found' then raise; end if;
  end;
end;
$$;
reset role;

-- Simulate owner one JWT: owner two rows must remain invisible.
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
do $$
begin
  if (select count(*) from public.merchants) <> 1 then raise exception 'FAIL: merchant isolation'; end if;
  if exists (select 1 from public.charges where merchant_id = '20000000-0000-4000-8000-000000000002') then raise exception 'FAIL: charge isolation'; end if;
  if (select count(*) from public.charges) <> 6 then raise exception 'FAIL: own charges not visible'; end if;
  begin
    update public.charges set status = 'paid';
    raise exception 'FAIL: browser can write charges';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.process_pey_payment('forged','{}','test-key-one','test-qr-1','forged',100,now());
    raise exception 'FAIL: browser can call payment RPC';
  exception when insufficient_privilege then null;
  end;
  begin
    perform count(*) from public.webhook_events;
    raise exception 'FAIL: browser can read webhook payloads';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.daily_corte('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',current_date);
    raise exception 'FAIL: browser can call privileged corte RPC';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;
set local role anon;
do $$
begin
  begin
    perform count(*) from public.charges;
    raise exception 'FAIL: anon reads charges';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;
rollback;
-- Expected: no errors, final ROLLBACK, no fixture rows persisted.
