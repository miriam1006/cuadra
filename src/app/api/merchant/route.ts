import { NextResponse } from 'next/server';
import { z } from 'zod';
import { owner, fail, sameOrigin, jsonBody, ApiError } from '@/lib/api';
export async function POST(request: Request) { try {
  sameOrigin(request); const {user,merchant,admin} = await owner();
  if (merchant) return NextResponse.json({merchant});
  const parsed = z.object({name:z.string().trim().min(1).max(100)}).safeParse(await jsonBody(request));
  if (!parsed.success) throw new ApiError(400,'Escribe un nombre de hasta 100 caracteres.');
  if (!process.env.PEY_API_KEY_ID) throw new ApiError(503,'Configura el identificador de tu API key de Pey.');
  const {data,error} = await admin.from('merchants').insert({name:parsed.data.name,owner_user_id:user.id,pey_api_key_id:process.env.PEY_API_KEY_ID}).select('id,name,max_amount_cents').single();
  if(error) throw new ApiError(409,'No se pudo crear el comercio. Comprueba si ya existe.');
  await admin.from('audit_log').insert({merchant_id:data.id,actor:user.id,action:'merchant.created'});
  return NextResponse.json({merchant:data},{status:201});
}catch(e){return fail(e);} }
