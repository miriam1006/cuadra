import { NextResponse } from 'next/server';
import { owner, fail, ApiError } from '@/lib/api';
export async function GET(request:Request){try{
  const {merchant,user,admin}=await owner();
  const date=new URL(request.url).searchParams.get('date');
  if(!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date))) throw new ApiError(400,'Fecha inválida.');
  if(!merchant) throw new ApiError(409,'Primero crea tu comercio.');
  const {data,error}=await admin.rpc('daily_corte',{p_merchant_id:merchant.id,p_owner_user_id:user.id,p_date:date});
  if(error || !data) throw new ApiError(503,'No se pudo calcular el corte.');
  return NextResponse.json(data);
}catch(e){return fail(e);}}
