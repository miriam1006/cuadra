import { NextResponse } from 'next/server';
import { access,fail,ApiError,jsonBody,sameOrigin } from '@/lib/api';
import { passwordChangeSchema } from '@/lib/team-validation';
export async function POST(request:Request){try{
  sameOrigin(request); const {user,merchant,admin,client}=await access({allowPasswordChange:true});
  const input=passwordChangeSchema.safeParse(await jsonBody(request));
  if(!input.success) throw new ApiError(400,input.error.issues[0]?.message || 'Revisa las contraseñas.');
  const {error}=await client.auth.updateUser({password:input.data.password});
  if(error) throw new ApiError(error.status===429?429:400,'No se pudo cambiar la contraseña. Usa una contraseña nueva y vuelve a intentar.');
  if(user.app_metadata?.must_change_password===true){
    const {error:flagError}=await admin.auth.admin.updateUserById(user.id,{app_metadata:{...user.app_metadata,must_change_password:false}});
    if(flagError) throw new ApiError(503,'La contraseña cambió, pero falta habilitar tu acceso. Vuelve a iniciar sesión con la contraseña nueva e intenta de nuevo.');
  }
  // Refresh the session after the administrative metadata update.
  await client.auth.refreshSession();
  const {error:auditError}=await admin.from('audit_log').insert({merchant_id:merchant?.id || null,actor:user.id,action:'user.password_changed',details:{}});
  if(auditError) console.warn('password_audit_pending',{code:auditError.code});
  return NextResponse.json({ok:true},{headers:{'Cache-Control':'no-store'}});
}catch(e){return fail(e);}}
