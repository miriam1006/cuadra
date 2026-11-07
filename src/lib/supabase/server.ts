import 'server-only';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
export async function createSessionClient() {
  const jar = await cookies();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('Falta configurar Supabase.');
  return createServerClient(url, key, {
    cookieOptions: { httpOnly:true, secure:process.env.APP_URL?.startsWith('https://') ?? false, sameSite:'lax', path:'/' },
    cookies: { getAll: () => jar.getAll(), setAll(values) { for (const {name,value,options} of values) jar.set(name,value,options); } }
  });
}
