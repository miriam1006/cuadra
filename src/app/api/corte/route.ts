import { NextResponse } from 'next/server';
import { access, fail, ApiError } from '@/lib/api';
import { isValidCorteDate } from '@/lib/corte-date';
export async function GET(request:Request){try{
  const {merchant,user,admin}=await access();
  const date=new URL(request.url).searchParams.get('date');
  if(!isValidCorteDate(date)) throw new ApiError(400,'Elige una fecha válida, hasta hoy en Ciudad de México.');
  if(!merchant) throw new ApiError(409,'Primero crea tu comercio.');
  const {data,error}=await admin.rpc('daily_corte',{p_merchant_id:merchant.id,p_owner_user_id:user.id,p_date:date});
  if(error || !data) throw new ApiError(503,'No se pudo calcular el corte.');
  return NextResponse.json(data,{headers:{'Cache-Control':'no-store'}});
}catch(e){return fail(e);}}
