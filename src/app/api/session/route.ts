import { NextResponse } from 'next/server';
import { owner, fail } from '@/lib/api';
export async function GET() { try { const {user,merchant} = await owner(); return NextResponse.json({user:{email:user.email},merchant:merchant ? {id:merchant.id,name:merchant.name,max_amount_cents:merchant.max_amount_cents} : null}); } catch(e) {return fail(e);} }
