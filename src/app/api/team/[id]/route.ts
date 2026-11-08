import { NextResponse } from 'next/server';
import { z } from 'zod';
import { owner,fail,ApiError,jsonBody,sameOrigin } from '@/lib/api';
import { teamUpdateSchema } from '@/lib/team-validation';
export async function PATCH(request:Request,{params}:{params:Promise<{id:string}>}){try{
  sameOrigin(request); const {user,merchant,admin}=await owner();
  if(!merchant) throw new ApiError(409,'Primero crea tu negocio.');
  const {id}=await params; if(!z.uuid().safeParse(id).success) throw new ApiError(400,'Usuario inválido.');
  const input=teamUpdateSchema.safeParse(await jsonBody(request));
  if(!input.success) throw new ApiError(400,'Revisa el nombre, rol y estado del acceso.');
  const {data,error}=await admin.rpc('set_merchant_member',{p_merchant_id:merchant.id,p_actor_user_id:user.id,p_user_id:id,p_display_name:input.data.display_name,p_role:input.data.role,p_active:input.data.active});
  if(error){
    if(error.message.includes('owner_membership_protected')) throw new ApiError(409,'El administrador principal debe conservar su acceso.');
    if(error.message.includes('member_other_merchant')) throw new ApiError(404,'Usuario no encontrado en este negocio.');
    throw new ApiError(503,'No se pudo actualizar el acceso.');
  }
  return NextResponse.json({member:data},{headers:{'Cache-Control':'no-store'}});
}catch(e){return fail(e);}}
