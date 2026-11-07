import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ApiError, fail, jsonBody, sameOrigin } from '@/lib/api';
import { createSessionClient } from '@/lib/supabase/server';
export async function POST(request:Request) {try{
  sameOrigin(request);
  const input=z.object({email:z.email()}).safeParse(await jsonBody(request));
  if(!input.success) throw new ApiError(400,'Escribe un correo válido.');
  const ownerEmail=process.env.OWNER_EMAIL?.trim().toLowerCase();
  if(!ownerEmail) throw new ApiError(503,'Falta configurar el correo de la dueña.');
  if(input.data.email.trim().toLowerCase()!==ownerEmail) throw new ApiError(403,'Usa el correo configurado para esta caja.');
  const client=await createSessionClient();
  const {error}=await client.auth.signInWithOtp({email:ownerEmail,options:{emailRedirectTo:`${new URL(process.env.APP_URL!).origin}/auth/callback`,shouldCreateUser:true}});
  if(error) throw new ApiError(error.status===429?429:503,error.status===429?'Espera un momento antes de pedir otro enlace.':'No se pudo enviar el enlace. Revisa la configuración de correo en Supabase.');
  return NextResponse.json({ok:true});
}catch(e){return fail(e);}}
