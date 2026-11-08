import { NextResponse } from 'next/server';
import { access, fail } from '@/lib/api';
export async function GET() { try {
  const {user,merchant,role} = await access({allowPasswordChange:true});
  return NextResponse.json({user:{id:user.id,email:user.email},role,must_change_password:user.app_metadata?.must_change_password === true,merchant:merchant ? {id:merchant.id,name:merchant.name,max_amount_cents:merchant.max_amount_cents} : null},{headers:{'Cache-Control':'no-store'}});
} catch(e) { return fail(e); } }
