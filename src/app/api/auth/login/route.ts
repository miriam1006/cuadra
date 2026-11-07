import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ApiError, fail, jsonBody, sameOrigin } from '@/lib/api';
import { createSessionClient } from '@/lib/supabase/server';
export async function POST(request:Request) {try{
  sameOrigin(request);
  const input=z.object({email:z.string().trim().max(254).pipe(z.email()),password:z.string().min(1).max(256)}).safeParse(await jsonBody(request));
  if(!input.success) throw new ApiError(400,'Escribe tu correo electrónico y contraseña.');
  const ownerEmail=process.env.OWNER_EMAIL?.trim().toLowerCase();
  if(!ownerEmail) throw new ApiError(503,'El acceso todavía no está configurado.');
  if(input.data.email.toLowerCase()!==ownerEmail) throw new ApiError(401,'Correo o contraseña incorrectos.');
  const client=await createSessionClient();
  const {data,error}=await client.auth.signInWithPassword({email:ownerEmail,password:input.data.password});
  if(error) {
    if(error.status===429) throw new ApiError(429,'Demasiados intentos. Espera un momento antes de volver a intentar.');
    if(!error.status || error.status>=500) throw new ApiError(503,'No se pudo conectar con el servicio de acceso. Intenta de nuevo.');
    throw new ApiError(401,'Correo o contraseña incorrectos.');
  }
  if(!data.user || data.user.email?.toLowerCase()!==ownerEmail) {
    await client.auth.signOut();
    throw new ApiError(401,'Correo o contraseña incorrectos.');
  }
  return NextResponse.json({ok:true});
}catch(e){return fail(e);}}
