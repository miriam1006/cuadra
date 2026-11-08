begin;
insert into auth.users(id,email) values
 ('12000000-0000-4000-8000-000000000001','catalog-owner@example.invalid'),
 ('12000000-0000-4000-8000-000000000002','catalog-other@example.invalid'),
 ('12000000-0000-4000-8000-000000000003','catalog-cashier@example.invalid'),
 ('12000000-0000-4000-8000-000000000004','catalog-cashier-two@example.invalid'),
 ('12000000-0000-4000-8000-000000000005','catalog-inactive@example.invalid'),
 ('12000000-0000-4000-8000-000000000006','catalog-admin@example.invalid');
insert into public.merchants(id,owner_user_id,name,pey_api_key_id) values
 ('22000000-0000-4000-8000-000000000001','12000000-0000-4000-8000-000000000001','Catalog one','catalog-key-one'),
 ('22000000-0000-4000-8000-000000000002','12000000-0000-4000-8000-000000000002','Catalog two','catalog-key-two');
set local role service_role;
do $$
declare
 m uuid:='22000000-0000-4000-8000-000000000001'; o uuid:='12000000-0000-4000-8000-000000000001';
 cash uuid:='12000000-0000-4000-8000-000000000003'; cash2 uuid:='12000000-0000-4000-8000-000000000004';
 inactive uuid:='12000000-0000-4000-8000-000000000005'; admin2 uuid:='12000000-0000-4000-8000-000000000006';
 p public.products; q public.products; otherp public.products; c public.charges; d public.charges; manual public.charges; pending public.charges;
 items jsonb; result jsonb; ts timestamptz:=now();
begin
 if not exists(select 1 from public.merchant_members where merchant_id=m and user_id=o and role='admin' and active) then raise exception 'FAIL owner seed'; end if;
 perform public.attach_merchant_member_by_email(m,o,'  CATALOG-CASHIER@EXAMPLE.INVALID ','Caja uno','cashier',true);
 perform public.set_merchant_member(m,o,cash2,'Caja dos','cashier',true);
 perform public.set_merchant_member(m,o,inactive,'Inactivo','cashier',false);
 perform public.set_merchant_member(m,o,admin2,'Admin delegado','admin',true);
 result:=public.list_merchant_team(m,admin2);
 if jsonb_array_length(result)<>5 or not exists(select 1 from jsonb_array_elements(result) r where r->>'email'='catalog-owner@example.invalid' and r->>'is_owner'='true') then raise exception 'FAIL admin team listing'; end if;
 begin perform public.list_merchant_team(m,cash); raise exception 'FAIL cashier team list'; exception when raise_exception then if sqlerrm<>'admin_required' then raise; end if; end;
 begin
  perform public.set_merchant_member(m,cash,admin2,'Elevado','admin',true); raise exception 'FAIL cashier promoted user';
 exception when raise_exception then if sqlerrm<>'admin_required' then raise; end if; end;
 begin
  perform public.set_merchant_member(m,admin2,o,'Dueño','cashier',true); raise exception 'FAIL owner demotion';
 exception when raise_exception then if sqlerrm<>'owner_membership_protected' then raise; end if; end;
 begin
  perform public.set_merchant_member(m,o,o,'Dueño','admin',false); raise exception 'FAIL owner deactivation';
 exception when raise_exception then if sqlerrm<>'owner_membership_protected' then raise; end if; end;
 begin
  perform public.set_merchant_member('22000000-0000-4000-8000-000000000002','12000000-0000-4000-8000-000000000002',cash,'Movido','cashier',true); raise exception 'FAIL cross merchant assignment';
 exception when raise_exception then if sqlerrm<>'member_other_merchant' then raise; end if; end;
 p:=public.save_product(m,admin2,null,'Producto A',200,'0012345',true);
 q:=public.save_product(m,o,null,'Producto B',350,'ABC 123',true);
 if p.barcode<>'0012345' then raise exception 'FAIL leading zero lost'; end if;
 begin
  perform public.save_product(m,cash,null,'Prohibido',1,null,true); raise exception 'FAIL cashier save';
 exception when raise_exception then if sqlerrm<>'admin_required' then raise; end if; end;
 begin
  perform public.save_product(m,o,null,'Duplicado',1,'0012345',true); raise exception 'FAIL duplicate barcode';
 exception when unique_violation then null; end;
 otherp:=public.save_product('22000000-0000-4000-8000-000000000002','12000000-0000-4000-8000-000000000002',null,'Otro',10,'0012345',true);
 items:=jsonb_build_array(jsonb_build_object('product_id',p.id,'quantity',2),jsonb_build_object('product_id',q.id,'quantity',1));
 c:=public.reserve_product_charge(m,cash,items,'32000000-0000-4000-8000-000000000001');
 if c.amount_cents<>750 or (select sum(line_total_cents) from public.charge_items where charge_id=c.id)<>750 then raise exception 'FAIL trusted cart total'; end if;
 perform public.save_product(m,o,p.id,'Nuevo nombre',999,'0012345',false);
 d:=public.reserve_product_charge(m,cash,jsonb_build_array(items->1,items->0),'32000000-0000-4000-8000-000000000001');
 if d.id<>c.id or d.amount_cents<>750 then raise exception 'FAIL snapshot idempotency after archive/price change'; end if;
 if not exists(select 1 from public.charge_items where charge_id=c.id and product_id=p.id and name='Producto A' and unit_price_cents=200 and quantity=2) then raise exception 'FAIL immutable snapshot values'; end if;
 begin
  update public.charge_items set quantity=3 where charge_id=c.id; raise exception 'FAIL snapshot mutation';
 exception when raise_exception then if sqlerrm<>'charge_items_immutable' then raise; end if; end;
 begin
  perform public.reserve_product_charge(m,cash2,items,'32000000-0000-4000-8000-000000000001'); raise exception 'FAIL cart stolen idempotency';
 exception when raise_exception then if sqlerrm<>'idempotency_conflict' then raise; end if; end;
 begin
  perform public.reserve_product_charge(m,cash,jsonb_build_array(jsonb_build_object('product_id',q.id,'quantity',2)),'32000000-0000-4000-8000-000000000001'); raise exception 'FAIL changed cart accepted';
 exception when raise_exception then if sqlerrm<>'idempotency_conflict' then raise; end if; end;
 begin
  perform public.reserve_charge(m,cash,750,c.concept,'32000000-0000-4000-8000-000000000001'); raise exception 'FAIL cart key reused as manual';
 exception when raise_exception then if sqlerrm<>'idempotency_conflict' then raise; end if; end;
 begin
  perform public.reserve_product_charge(m,cash,items,'32000000-0000-4000-8000-000000000002'); raise exception 'FAIL archived product';
 exception when raise_exception then if sqlerrm<>'cart_product_unavailable' then raise; end if; end;
 begin
  perform public.reserve_product_charge(m,cash,jsonb_build_array(jsonb_build_object('product_id',q.id,'quantity',1,'price_cents',1)),'32000000-0000-4000-8000-000000000002'); raise exception 'FAIL browser price tampering';
 exception when raise_exception then if sqlerrm<>'invalid_cart' then raise; end if; end;
 begin
  perform public.reserve_product_charge(m,cash,jsonb_build_array(jsonb_build_object('product_id',otherp.id,'quantity',1)),'32000000-0000-4000-8000-000000000002'); raise exception 'FAIL cross merchant cart';
 exception when raise_exception then if sqlerrm<>'cart_product_unavailable' then raise; end if; end;
 begin
  perform public.reserve_product_charge(m,cash,jsonb_build_array(items->1,items->1),'32000000-0000-4000-8000-000000000002'); raise exception 'FAIL duplicate product';
 exception when raise_exception then if sqlerrm<>'duplicate_cart_product' then raise; end if; end;
 begin
  perform public.reserve_product_charge(m,inactive,jsonb_build_array(items->1),'32000000-0000-4000-8000-000000000002'); raise exception 'FAIL inactive cart';
 exception when raise_exception then if sqlerrm<>'merchant_not_found' then raise; end if; end;
 begin
  perform public.reserve_product_charge(m,cash,jsonb_build_array(jsonb_build_object('product_id',q.id,'quantity',999)),'32000000-0000-4000-8000-000000000002');
  -- 349650 is under default maximum; lower merchant maximum and try separately below.
 exception when others then raise; end;
 update public.merchants set max_amount_cents=1000 where id=m;
 begin
  perform public.reserve_product_charge(m,cash,jsonb_build_array(jsonb_build_object('product_id',q.id,'quantity',4)),'32000000-0000-4000-8000-000000000003'); raise exception 'FAIL merchant max';
 exception when raise_exception then if sqlerrm<>'invalid_amount' then raise; end if; end;
 update public.merchants set max_amount_cents=800000 where id=m;

 manual:=public.reserve_charge(m,cash2,1000,'Manual caja dos','32000000-0000-4000-8000-000000000004');
 d:=public.reserve_charge(m,o,300,'Manual admin','32000000-0000-4000-8000-000000000005');
 perform public.finalize_charge(c.id,'catalog-qr-cart','qr');
 perform public.finalize_charge(manual.id,'catalog-qr-cash2','qr');
 perform public.finalize_charge(d.id,'catalog-qr-admin','qr');
 result:=public.reconcile_pey_payment(m,cash,c.id,'catalog-key-one','catalog-qr-cart','catalog-tx-cart',750,ts);
 if result->>'outcome'<>'paid' then raise exception 'FAIL cashier own reconcile'; end if;
 begin
  perform public.reconcile_pey_payment(m,cash,manual.id,'catalog-key-one','catalog-qr-cash2','catalog-tx-no',1000,ts); raise exception 'FAIL cashier other reconcile';
 exception when raise_exception then if sqlerrm<>'reconciliation_charge_not_found' then raise; end if; end;
 perform public.reconcile_pey_payment(m,admin2,manual.id,'catalog-key-one','catalog-qr-cash2','catalog-tx-cash2',1000,ts);
 perform public.process_pey_payment('catalog-event-admin','{}','catalog-key-one','catalog-qr-admin','catalog-tx-admin',300,ts);
 result:=public.daily_corte(m,cash,(ts at time zone 'America/Mexico_City')::date);
 if (result->>'total_paid_cents')::int<>750 or (result->>'paid_count')::int<>1 then raise exception 'FAIL cashier corte own'; end if;
 result:=public.daily_corte(m,cash2,(ts at time zone 'America/Mexico_City')::date);
 if (result->>'total_paid_cents')::int<>1000 then raise exception 'FAIL other cashier corte'; end if;
 result:=public.daily_corte(m,admin2,(ts at time zone 'America/Mexico_City')::date);
 if (result->>'total_paid_cents')::int<>2050 or (result->>'paid_count')::int<>3 then raise exception 'FAIL delegated admin corte'; end if;
 pending:=public.reserve_charge(m,cash,100,'Pendiente','32000000-0000-4000-8000-000000000006');
 perform public.finalize_charge(pending.id,'catalog-qr-pending','qr');
 begin
  perform public.cancel_charge(pending.id,cash2); raise exception 'FAIL cashier cancelled other';
 exception when raise_exception then if sqlerrm<>'charge_not_found' then raise; end if; end;
 perform public.cancel_charge(pending.id,cash);
 perform public.set_merchant_member(m,o,inactive,'Inactivo','cashier',false);
 perform public.set_merchant_member(m,o,cash,'Caja uno','cashier',false);
 begin perform public.reserve_charge(m,cash,100,'Deshabilitado','32000000-0000-4000-8000-000000000007'); raise exception 'FAIL disabled existing member reserve'; exception when raise_exception then if sqlerrm<>'merchant_not_found' then raise; end if; end;
 begin perform public.daily_corte(m,cash,(ts at time zone 'America/Mexico_City')::date); raise exception 'FAIL disabled corte'; exception when raise_exception then if sqlerrm<>'merchant_not_found' then raise; end if; end;
 perform public.set_merchant_member(m,o,cash,'Caja uno','cashier',true);
 if not exists(select 1 from public.audit_log where merchant_id=m and action='member.saved') or not exists(select 1 from public.audit_log where merchant_id=m and action='product.saved') then raise exception 'FAIL catalog/team audit'; end if;
end; $$;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub','12000000-0000-4000-8000-000000000003',true);
do $$ begin
 if (select count(*) from public.merchants)<>1 or (select count(*) from public.merchant_members)<>1 then raise exception 'FAIL cashier tenant/member RLS'; end if;
 if (select count(*) from public.products)<>1 then raise exception 'FAIL cashier archived product RLS'; end if;
 if exists(select 1 from public.charges where created_by<>'12000000-0000-4000-8000-000000000003') then raise exception 'FAIL cashier charge RLS'; end if;
 if (select count(*) from public.payment_receipts)<>1 then raise exception 'FAIL cashier receipt RLS'; end if;
 if (select count(*) from public.charge_items)<>3 then raise exception 'FAIL cashier item RLS'; end if;
 if exists(select 1 from public.audit_log) then raise exception 'FAIL cashier audit RLS'; end if;
 begin update public.products set price_cents=1; raise exception 'FAIL browser product write'; exception when insufficient_privilege then null; end;
 begin perform public.save_product('22000000-0000-4000-8000-000000000001','12000000-0000-4000-8000-000000000001',null,'Hack',1,null,true); raise exception 'FAIL browser product RPC'; exception when insufficient_privilege then null; end;
 begin perform public.list_merchant_team('22000000-0000-4000-8000-000000000001','12000000-0000-4000-8000-000000000001'); raise exception 'FAIL browser team RPC'; exception when insufficient_privilege then null; end;
end; $$;
select set_config('request.jwt.claim.sub','12000000-0000-4000-8000-000000000006',true);
do $$ begin
 if (select count(*) from public.products)<>2 or (select count(*) from public.merchant_members)<>5 then raise exception 'FAIL delegated admin RLS'; end if;
 if (select count(*) from public.payment_receipts)<>3 then raise exception 'FAIL admin receipt RLS'; end if;
end; $$;
select set_config('request.jwt.claim.sub','12000000-0000-4000-8000-000000000005',true);
do $$ begin
 if exists(select 1 from public.merchants) or exists(select 1 from public.products) or exists(select 1 from public.charges) or exists(select 1 from public.merchant_members) then raise exception 'FAIL inactive member RLS'; end if;
end; $$;
reset role;
rollback;
