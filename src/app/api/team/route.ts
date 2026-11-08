import { NextResponse } from 'next/server';
import { ApiError, owner, fail, jsonBody, sameOrigin } from '@/lib/api';
import { teamCreateSchema } from '@/lib/team-validation';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=30;
function membershipError(message:string) {
  if(message.includes('auth_user_not_found')) return new ApiError(404,'No existe ese usuario. Usa Crear acceso para registrarlo.');
  if(message.includes('member_other_merchant')) return new ApiError(409,'Ese usuario ya pertenece a otro negocio.');
  if(message.includes('owner_membership_protected')) return new ApiError(409,'El administrador principal debe conservar su acceso.');
  return new ApiError(503,'No se pudo vincular el usuario al negocio.');
}
export async function GET(){try{
  const {user,merchant,admin}=await owner();
  if(!merchant) throw new ApiError(409,'Primero crea tu negocio.');
  const {data,error}=await admin.rpc('list_merchant_team',{p_merchant_id:merchant.id,p_actor_user_id:user.id});
  if(error) throw new ApiError(503,'No se pudo consultar el equipo.');
  return NextResponse.json({members:data || []},{headers:{'Cache-Control':'no-store'}});
}catch(e){return fail(e);}}
export async function POST(request:Request){try{
  sameOrigin(request);
  const {user,merchant,admin}=await owner();
  if(!merchant) throw new ApiError(409,'Primero crea tu negocio.');
  const parsed=teamCreateSchema.safeParse(await jsonBody(request));
  if(!parsed.success) throw new ApiError(400,'Revisa el nombre, correo, rol y contraseña de al menos 12 caracteres.');
  const input=parsed.data;
  if(input.mode==='existing'){
    const {data,error}=await admin.rpc('attach_merchant_member_by_email',{p_merchant_id:merchant.id,p_actor_user_id:user.id,p_email:input.email,p_display_name:input.display_name,p_role:input.role,p_active:true});
    if(error) throw membershipError(error.message);
    return NextResponse.json({member:data},{status:201,headers:{'Cache-Control':'no-store'}});
  }
  const {data:created,error:createError}=await admin.auth.admin.createUser({email:input.email,password:input.password,email_confirm:true,user_metadata:{full_name:input.display_name},app_metadata:{must_change_password:true}});
  if(createError || !created.user){
    if(createError?.code==='email_exists' || createError?.code==='user_already_exists') throw new ApiError(409,'Ese correo ya está registrado. Usa Vincular usuario existente; su contraseña se conservará.');
    if(createError?.code==='weak_password') throw new ApiError(400,'Elige una contraseña temporal más fuerte.');
    throw new ApiError(503,'No se pudo crear el acceso. Revisa los datos e intenta de nuevo.');
  }
  const {data,error}=await admin.rpc('set_merchant_member',{p_merchant_id:merchant.id,p_actor_user_id:user.id,p_user_id:created.user.id,p_display_name:input.display_name,p_role:input.role,p_active:true});
  if(error) throw new ApiError(503,'El usuario se creó, pero falta vincularlo. Reintenta con Vincular usuario existente y el mismo correo.');
  return NextResponse.json({member:data},{status:201,headers:{'Cache-Control':'no-store'}});
}catch(e){return fail(e);}}
