import { NextResponse } from 'next/server';
import { z } from 'zod';
import { owner, fail, sameOrigin, jsonBody, ApiError, publicCharge } from '@/lib/api';
import { createPeyQr, PeyError } from '@/lib/pey';
export const runtime = 'nodejs';
export const maxDuration = 30;
const schema = z.object({amount_cents:z.number().int().positive().max(100000000),concept:z.string().trim().max(100).optional()});
export async function POST(request: Request) { try {
  sameOrigin(request); const {user,merchant,admin} = await owner();
  if(!merchant) throw new ApiError(409,'Primero crea tu comercio.');
  const input=schema.safeParse(await jsonBody(request)); if(!input.success) throw new ApiError(400,'Revisa el monto y el concepto.');
  const key=request.headers.get('idempotency-key');
  if(!key || !z.uuid().safeParse(key).success) throw new ApiError(400,'Falta una referencia única para el cobro.');
  const {data:reserved,error:reserveError}=await admin.rpc('reserve_charge',{p_merchant_id:merchant.id,p_owner_user_id:user.id,p_amount_cents:input.data.amount_cents,p_concept:input.data.concept||'Venta',p_idempotency_key:key});
  if(reserveError) { const msg=reserveError.message; throw new ApiError(msg.includes('rate_limited')?429:400,msg.includes('rate_limited')?'Espera un minuto antes de crear más cobros.':'No se pudo reservar el cobro. Revisa el límite de monto.'); }
  const c=Array.isArray(reserved)?reserved[0]:reserved;
  if(!c?.id) throw new ApiError(503,'No se pudo reservar el cobro.');
  if(c.status!=='creating') return NextResponse.json({charge:publicCharge(c)});
  const {data:claimed,error:claimError}=await admin.rpc('claim_charge_creation',{p_charge_id:c.id});
  if(claimError) throw new ApiError(503,'No se pudo iniciar el cobro.');
  const claim=Array.isArray(claimed)?claimed[0]:claimed;
  if(!claim?.id) return NextResponse.json({charge:publicCharge(c)},{status:202});
  try {
    const qr=await createPeyQr({amountCents:c.amount_cents,concept:c.concept,numRef:c.num_ref});
    const args={p_charge_id:c.id,p_pey_ref:qr.id,p_qr_string:qr.qrString};
    let finalResult=await admin.rpc('finalize_charge',args);
    // Retrying this DB operation is safe with the SAME provider ID. Never retry Pey.
    if(finalResult.error) finalResult=await admin.rpc('finalize_charge',args);
    if(finalResult.error) throw new ApiError(503,'Pey respondió, pero falta guardar el cobro. Requiere revisión; no lo vuelvas a crear.');
    return NextResponse.json({charge:publicCharge(Array.isArray(finalResult.data)?finalResult.data[0]:finalResult.data)},{status:201});
  } catch(e) {
    // A provider timeout is ambiguous: retain the reserved charge and never auto-retry Pey.
    const code=e instanceof PeyError?e.code:'finalization';
    await admin.from('charges').update({status:code==='rejected'?'failed':'creating',failure_code:code}).eq('id',c.id).eq('status','creating');
    if(e instanceof ApiError) throw e;
    throw new ApiError(503,'No se pudo confirmar la creación con Pey. Revisa el historial antes de volver a cobrar.');
  }
}catch(e){return fail(e);} }
export async function GET(request:Request) {try {
  const {merchant,admin}=await owner(); if(!merchant) return NextResponse.json({charges:[]});
  const date=new URL(request.url).searchParams.get('date');
  if(!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date))) throw new ApiError(400,'Fecha inválida.');
  // Mexico City is UTC-06:00 year-round. Query payment day as well as creation day.
  const start=new Date(`${date}T00:00:00-06:00`); const end=new Date(start.getTime()+86400000);
  const range=`and(created_at.gte.${start.toISOString()},created_at.lt.${end.toISOString()}),and(paid_at.gte.${start.toISOString()},paid_at.lt.${end.toISOString()})`;
  const {data,error}=await admin.from('charges').select('*').eq('merchant_id',merchant.id).or(range).order('created_at',{ascending:false}).limit(1000);
  if(error) throw new ApiError(503,'No se pudo consultar el historial.');
  return NextResponse.json({charges:data.map(publicCharge),truncated:data.length===1000});
}catch(e){return fail(e);} }
