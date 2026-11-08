import { z } from "zod";

export const CHARGE_WITH_ITEMS = "*,charge_items(product_id,name,unit_price_cents,quantity,line_total_cents)";
const barcodeSchema = z.string().trim().max(64)
  .refine(value => !/[\u0000-\u001f\u007f]/.test(value), "Código inválido")
  .nullable().optional().transform(value => value || null);

export const productInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(100).refine(value => !/[\u0000-\u001f\u007f]/.test(value)),
  price_cents: z.number().int().positive().max(100_000_000),
  barcode: barcodeSchema,
  active: z.boolean().optional().default(true),
});
export const manualChargeSchema = z.strictObject({
  amount_cents: z.number().int().positive().max(100_000_000),
  concept: z.string().trim().max(100).optional(),
});
export const cartChargeSchema = z.strictObject({
  items: z.array(z.strictObject({ product_id: z.uuid().transform(value => value.toLowerCase()), quantity: z.number().int().min(1).max(999) }))
    .min(1).max(50).refine(items => new Set(items.map(item => item.product_id)).size === items.length,
      "Cada producto debe aparecer una sola vez"),
});
export const chargeInputSchema = z.union([manualChargeSchema, cartChargeSchema]);

export function canAccessCharge(role: "admin" | "cashier", userId: string, createdBy: string): boolean {
  return Boolean(userId) && (role === "admin" || role === "cashier" && userId === createdBy);
}

/** No provider/SQL detail is exposed to the browser. Unknown DB failures stay 503. */
export function catalogRpcFailure(error: { code?: string; message?: string }) {
  const message = error.message || "";
  if (error.code === "42501" || /admin_required|permission_denied|unauthorized|not_authorized|forbidden|membership_required|member_not_active|inactive_member|actor_not_allowed|not_allowed|access_denied/.test(message)) {
    return { status: 403, message: "Tu usuario no tiene permiso para esta operación." };
  }
  if (/charge_not_found|product_not_found|merchant_not_found|reconciliation_charge_not_found/.test(message)) return { status: 404, message: "No se encontró el registro solicitado." };
  if (/rate_limited/.test(message)) return { status: 429, message: "Espera un minuto antes de volver a intentarlo." };
  if (error.code === "23505" || /idempotency_conflict|product_inactive|invalid_charge_state|barcode_conflict/.test(message)) return { status: 409, message: "El registro cambió o el código ya está en uso. Actualiza y revisa antes de continuar." };
  if (/invalid_|duplicate_cart_product|cart_product_unavailable|amount_limit|maximum_amount|cart_total|reference_exhausted|catalog_limit/.test(message)) return { status: 400, message: "Revisa los productos, cantidades y límite de monto." };
  return { status: 503, message: "No se pudo completar la operación. Intenta de nuevo." };
}
