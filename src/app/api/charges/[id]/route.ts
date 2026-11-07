import { NextResponse } from 'next/server';
import { owner, fail, ApiError, publicCharge } from '@/lib/api';
import { z } from 'zod';
export async function GET(_request:Request,{params}:{params:Promise<{id:string}>}){try{
  const {id}=await params; if(!z.uuid().safeParse(id).success) throw new ApiError(400,'Identificador inválido.');
  const {merchant,admin}=await owner(); if(!merchant) throw new ApiError(404,'Cobro no encontrado.');
  const {data,error}=await admin.from('charges').select('*').eq('id',id).eq('merchant_id',merchant.id).maybeSingle();
  if(error) throw new ApiError(503,'No se pudo consultar el cobro.'); if(!data) throw new ApiError(404,'Cobro no encontrado.');
  return NextResponse.json({charge:publicCharge(data)});
}catch(e){return fail(e);}}
