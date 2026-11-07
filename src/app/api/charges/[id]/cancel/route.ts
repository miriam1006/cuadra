import { NextResponse } from 'next/server';
import { owner, fail, sameOrigin, ApiError, publicCharge } from '@/lib/api';
import { z } from 'zod';
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){try{
  sameOrigin(request); const {id}=await params; if(!z.uuid().safeParse(id).success) throw new ApiError(400,'Identificador inválido.');
  const {user,admin}=await owner();
  const {data,error}=await admin.rpc('cancel_charge',{p_charge_id:id,p_owner_user_id:user.id});
  if(error) throw new ApiError(409,'Solo puedes cancelar solicitudes sin pago confirmado.');
  return NextResponse.json({charge:publicCharge(Array.isArray(data)?data[0]:data)});
}catch(e){return fail(e);}}
