import { NextResponse } from "next/server";
import { z } from "zod";
import { access, fail, sameOrigin, jsonBody, ApiError, publicCharge } from "@/lib/api";
import { createPeyQr, PeyError } from "@/lib/pey";
import { chargeInputSchema, catalogRpcFailure, CHARGE_WITH_ITEMS } from "@/lib/catalog-validation";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const { user, merchant, role, admin } = await access();
    if (!merchant) throw new ApiError(409, "Primero crea tu comercio.");
    const input = chargeInputSchema.safeParse(await jsonBody(request));
    if (!input.success) throw new ApiError(400, "Revisa el monto o los productos y sus cantidades.");
    const key = request.headers.get("idempotency-key");
    if (!key || !z.uuid().safeParse(key).success) throw new ApiError(400, "Falta una referencia única para el cobro.");
    const readCharge = async (id: string) => {
      let query = admin.from("charges").select(CHARGE_WITH_ITEMS).eq("id", id).eq("merchant_id", merchant.id);
      if (role === "cashier") query = query.eq("created_by", user.id);
      const { data, error } = await query.single();
      if (error || !data) throw new ApiError(503, "No se pudo consultar el cobro reservado. Revisa el historial antes de repetirlo.");
      return data;
    };
    const reservation = "items" in input.data
      ? await admin.rpc("reserve_product_charge", {
        p_merchant_id: merchant.id, p_actor_user_id: user.id,
        p_items: [...input.data.items].sort((a, b) => a.product_id.localeCompare(b.product_id)), p_idempotency_key: key,
      })
      : await admin.rpc("reserve_charge", {
        p_merchant_id: merchant.id, p_owner_user_id: user.id, p_amount_cents: input.data.amount_cents,
        p_concept: input.data.concept || "Venta", p_idempotency_key: key,
      });
    if (reservation.error) { const failure = catalogRpcFailure(reservation.error); throw new ApiError(failure.status, failure.message); }
    const c = Array.isArray(reservation.data) ? reservation.data[0] : reservation.data;
    if (!c?.id) throw new ApiError(503, "No se pudo reservar el cobro.");
    if (c.status !== "creating") return NextResponse.json({ charge: publicCharge(await readCharge(c.id)) });
    const { data: claimed, error: claimError } = await admin.rpc("claim_charge_creation", { p_charge_id: c.id });
    if (claimError) throw new ApiError(503, "No se pudo iniciar el cobro.");
    const claim = Array.isArray(claimed) ? claimed[0] : claimed;
    if (!claim?.id) return NextResponse.json({ charge: publicCharge(await readCharge(c.id)) }, { status: 202 });
    try {
      const qr = await createPeyQr({ amountCents: c.amount_cents, concept: c.concept, numRef: c.num_ref });
      const args = { p_charge_id: c.id, p_pey_ref: qr.id, p_qr_string: qr.qrString };
      let finalized = await admin.rpc("finalize_charge", args);
      // Same DB operation and provider ID are safe to retry. Never retry Pey creation.
      if (finalized.error) finalized = await admin.rpc("finalize_charge", args);
      if (finalized.error) throw new ApiError(503, "Pey respondió, pero falta guardar el cobro. Requiere revisión; no lo vuelvas a crear.");
      return NextResponse.json({ charge: publicCharge(await readCharge(c.id)) }, { status: 201 });
    } catch (e) {
      const code = e instanceof PeyError ? e.code : "finalization";
      await admin.from("charges").update({ status: code === "rejected" ? "failed" : "creating", failure_code: code })
        .eq("id", c.id).eq("merchant_id", merchant.id).eq("created_by", user.id).eq("status", "creating");
      if (e instanceof ApiError) throw e;
      throw new ApiError(503, "No se pudo confirmar la creación con Pey. Revisa el historial antes de volver a cobrar.");
    }
  } catch (e) { return fail(e); }
}

export async function GET(request: Request) {
  try {
    const { merchant, role, user, admin } = await access();
    if (!merchant) return NextResponse.json({ charges: [], truncated: false });
    const date = new URL(request.url).searchParams.get("date");
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ApiError(400, "Fecha inválida.");
    const start = new Date(`${date}T00:00:00-06:00`);
    if (!Number.isFinite(start.getTime()) || start.toISOString().slice(0, 10) !== date) throw new ApiError(400, "Fecha inválida.");
    const end = new Date(start.getTime() + 86400000);
    const range = `and(created_at.gte.${start.toISOString()},created_at.lt.${end.toISOString()}),and(paid_at.gte.${start.toISOString()},paid_at.lt.${end.toISOString()})`;
    let query = admin.from("charges").select(CHARGE_WITH_ITEMS).eq("merchant_id", merchant.id);
    if (role === "cashier") query = query.eq("created_by", user.id);
    const { data, error } = await query.or(range).order("created_at", { ascending: false }).limit(1001);
    if (error) throw new ApiError(503, "No se pudo consultar el historial.");
    return NextResponse.json({ charges: data.slice(0, 1000).map(publicCharge), truncated: data.length > 1000 });
  } catch (e) { return fail(e); }
}
