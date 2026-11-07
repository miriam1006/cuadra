import 'server-only';
import { NextResponse } from 'next/server';
import { createSessionClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }
export async function owner() {
  const client = await createSessionClient();
  const { data: { user }, error } = await client.auth.getUser();
  if (error || !user) throw new ApiError(401, 'Inicia sesión para abrir tu caja.');
  const email = process.env.OWNER_EMAIL?.trim().toLowerCase();
  if (!email) throw new ApiError(503, 'Configura OWNER_EMAIL antes de abrir la caja.');
  if (user.email?.toLowerCase() !== email) throw new ApiError(403, 'Esta caja está reservada a su dueña.');
  const admin = createAdminClient();
  const { data: merchant, error: merchantError } = await admin.from('merchants').select('*').eq('owner_user_id', user.id).maybeSingle();
  if (merchantError) throw new ApiError(503, 'No se pudo consultar tu comercio. Revisa la configuración de la base de datos.');
  return { user, merchant, admin, client };
}
export function sameOrigin(request: Request) {
  const origin = request.headers.get('origin');
  const expected = process.env.APP_URL;
  if (!expected || origin !== new URL(expected).origin) throw new ApiError(403, 'Solicitud no autorizada.');
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new ApiError(415, 'Se requiere JSON.');
}
export async function jsonBody(request: Request) {
  if (Number(request.headers.get('content-length')) > 4096) throw new ApiError(413, 'Solicitud demasiado grande.');
  // Bounded streaming protects requests without Content-Length too.
  const reader = request.body?.getReader(); if (!reader) throw new ApiError(400, 'Faltan datos.');
  const parts: Uint8Array[] = []; let size = 0;
  while (true) { const {done,value} = await reader.read(); if (done) break; size += value.length; if (size > 4096) { await reader.cancel(); throw new ApiError(413,'Solicitud demasiado grande.'); } parts.push(value); }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown; } catch { throw new ApiError(400, 'JSON inválido.'); }
}
export function fail(error: unknown) {
  if (error instanceof ApiError) return NextResponse.json({error:error.message},{status:error.status});
  return NextResponse.json({error:'No se pudo completar la operación. Intenta de nuevo o revisa la configuración.'},{status:503});
}
export function publicCharge(c: Record<string, any>) {
  const status = c.status === 'pending' && Date.parse(c.expires_at) <= Date.now() ? 'expired' : c.status;
  return {id:c.id, amount_cents:c.amount_cents, concept:c.concept, status, payment_status:c.payment_status, created_at:c.created_at, expires_at:c.expires_at, paid_at:c.paid_at, transaction_id:c.transaction_id, qr_string:c.qr_string, late_payment:c.late_payment};
}
