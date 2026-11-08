import 'server-only';
import { NextResponse } from 'next/server';
import type { User } from '@supabase/supabase-js';
import { createSessionClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }
export type MerchantRole = 'admin' | 'cashier';

/** Resolve only a verified Auth user. Browser input never selects a merchant or role. */
export async function resolveMerchantAccess(user: User, admin = createAdminClient()) {
  const { data: membership, error } = await admin.from('merchant_members')
    .select('merchant_id,role,active,display_name').eq('user_id', user.id).maybeSingle();
  if (error) throw new ApiError(503, 'No se pudo consultar tu acceso. Revisa la actualización de la base de datos.');
  if (membership) {
    if (!membership.active || !['admin', 'cashier'].includes(membership.role)) {
      throw new ApiError(403, 'Tu acceso a este negocio está desactivado. Consulta al administrador.');
    }
    const { data: merchant, error: merchantError } = await admin.from('merchants').select('*')
      .eq('id', membership.merchant_id).maybeSingle();
    if (merchantError || !merchant) throw new ApiError(503, 'No se pudo consultar tu negocio.');
    return { merchant, role: membership.role as MerchantRole };
  }
  // OWNER_EMAIL is retained solely to bootstrap the initial administrator.
  const bootstrapEmail = process.env.OWNER_EMAIL?.trim().toLowerCase();
  if (bootstrapEmail && user.email?.toLowerCase() === bootstrapEmail) {
    const { data: existing, error: lookupError } = await admin.from('merchants')
      .select('id').eq('owner_user_id', user.id).maybeSingle();
    if (lookupError) throw new ApiError(503, 'No se pudo consultar tu negocio.');
    if (existing) throw new ApiError(503, 'Falta actualizar la vinculación del administrador del negocio.');
    return { merchant: null, role: 'admin' as const };
  }
  throw new ApiError(403, 'Tu usuario no tiene acceso a un negocio de Cuadra. Consulta al administrador.');
}

export async function access(options: { allowPasswordChange?: boolean } = {}) {
  const client = await createSessionClient();
  const { data: { user }, error } = await client.auth.getUser();
  if (error || !user) throw new ApiError(401, 'Inicia sesión para abrir tu caja.');
  const admin = createAdminClient();
  const membership = await resolveMerchantAccess(user, admin);
  if (user.app_metadata?.must_change_password === true && !options.allowPasswordChange) {
    throw new ApiError(403, 'Cambia tu contraseña temporal antes de usar la caja.');
  }
  return { user, admin, client, ...membership };
}

/** Administrative operations. Cashiers use access() and explicit creator scope. */
export async function owner() {
  const context = await access();
  if (context.role !== 'admin') throw new ApiError(403, 'Esta acción requiere un administrador.');
  return context;
}

export function sameOrigin(request: Request) {
  const origin = request.headers.get('origin');
  const expected = process.env.APP_URL;
  if (!expected || origin !== new URL(expected).origin) throw new ApiError(403, 'Solicitud no autorizada.');
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new ApiError(415, 'Se requiere JSON.');
}
export async function jsonBody(request: Request) {
  if (Number(request.headers.get('content-length')) > 4096) throw new ApiError(413, 'Solicitud demasiado grande.');
  const reader = request.body?.getReader(); if (!reader) throw new ApiError(400, 'Faltan datos.');
  const parts: Uint8Array[] = []; let size = 0;
  while (true) { const {done,value} = await reader.read(); if (done) break; size += value.length; if (size > 4096) { await reader.cancel(); throw new ApiError(413,'Solicitud demasiado grande.'); } parts.push(value); }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown; } catch { throw new ApiError(400, 'JSON inválido.'); }
}
export function fail(error: unknown) {
  if (error instanceof ApiError) return NextResponse.json({error:error.message},{status:error.status,headers:{'Cache-Control':'no-store'}});
  return NextResponse.json({error:'No se pudo completar la operación. Intenta de nuevo o revisa la configuración.'},{status:503,headers:{'Cache-Control':'no-store'}});
}
export function publicCharge(c: Record<string, any>) {
  const status = c.status === 'pending' && Date.parse(c.expires_at) <= Date.now() ? 'expired' : c.status;
  const items = Array.isArray(c.charge_items) ? c.charge_items.map((item: Record<string, any>) => ({
    product_id:item.product_id,name:item.name,unit_price_cents:item.unit_price_cents,quantity:item.quantity,line_total_cents:item.line_total_cents,
  })) : undefined;
  return {id:c.id, amount_cents:c.amount_cents, concept:c.concept, status, payment_status:c.payment_status, created_at:c.created_at, expires_at:c.expires_at, paid_at:c.paid_at, transaction_id:c.transaction_id, qr_string:c.qr_string, late_payment:c.late_payment, ...(items ? {items} : {})};
}
