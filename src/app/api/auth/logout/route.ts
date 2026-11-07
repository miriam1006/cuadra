import { NextResponse } from 'next/server';
import { sameOrigin, fail } from '@/lib/api';
import { createSessionClient } from '@/lib/supabase/server';
export async function POST(request:Request) {try {sameOrigin(request); const client=await createSessionClient(); const {error}=await client.auth.signOut(); if(error) throw error; return NextResponse.json({ok:true});}catch(e){return fail(e);}}
