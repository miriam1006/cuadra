import { NextResponse } from 'next/server';
import { createSessionClient } from '@/lib/supabase/server';
export async function GET(request:Request){
  const origin=process.env.APP_URL ? new URL(process.env.APP_URL).origin : new URL(request.url).origin;
  const code=new URL(request.url).searchParams.get('code');
  if(code) { try {const client=await createSessionClient(); const {error}=await client.auth.exchangeCodeForSession(code); if(!error) return NextResponse.redirect(new URL('/',origin));}catch{/* Return a safe, actionable login error. */} }
  return NextResponse.redirect(new URL('/login?error=expired',origin));
}
