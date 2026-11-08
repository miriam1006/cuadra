import { NextResponse } from "next/server";
import { z } from "zod";
import { access, fail, sameOrigin, jsonBody, ApiError, publicCharge } from "@/lib/api";
import { CHARGE_WITH_ITEMS, catalogRpcFailure } from "@/lib/catalog-validation";
import { getPeyQrTransactions, PeyError } from "@/lib/pey";
import { reconciliationRequestSchema, reconciliationScopeAllowed, parseReconciliationProof } from "@/lib/reconciliation-validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    sameOrigin(request);
    const { user, merchant, role, admin } = await access();
    if (!merchant) throw new ApiError(404, "No hay un comercio configurado.");
    const { id } = await params;
    if (!z.uuid().safeParse(id).success) throw new ApiError(400, "Identificador de cobro inválido.");
    if (!reconciliationRequestSchema.safeParse(await jsonBody(request)).success) {
      throw new ApiError(400, "La verificación no acepta montos ni datos de pago del navegador.");
    }
    const scoped = () => {
      let query = admin.from("charges").select(CHARGE_WITH_ITEMS).eq("id", id).eq("merchant_id", merchant.id);
      if (role === "cashier") query = query.eq("created_by", user.id);
      return query;
    };
    const { data: charge, error } = await scoped().maybeSingle();
    if (error) throw new ApiError(503, "No se pudo consultar el cobro.");
    if (!charge) throw new ApiError(404, "Cobro no encontrado.");
    if (!charge.pey_ref) throw new ApiError(409, "Este cobro no tiene una referencia de Pey disponible para verificar.");
    if (!reconciliationScopeAllowed({
      userId: user.id, merchantId: merchant.id, merchantOwnerId: merchant.owner_user_id,
      merchantApiKeyId: merchant.pey_api_key_id, expectedApiKeyId: process.env.PEY_API_KEY_ID,
      chargeMerchantId: charge.merchant_id, qrId: charge.pey_ref,
      role, chargeCreatedBy: charge.created_by,
    })) throw new ApiError(403, "La cuenta de Pey no coincide con este comercio. Revisa la configuración.");

    let proof: ReturnType<typeof parseReconciliationProof>;
    try {
      proof = parseReconciliationProof(await getPeyQrTransactions(charge.pey_ref));
    } catch (e) {
      if (e instanceof PeyError && e.httpStatus === 404) {
        throw new ApiError(409, "Pey no encuentra este QR bajo la cuenta configurada. No se cambió el cobro.");
      }
      throw new ApiError(503, "Pey no devolvió una confirmación completa y verificable. Intenta de nuevo; no se cambió el cobro.");
    }

    // No RPC occurs until every transaction in the complete page is validated.
    // Persist actual mismatches/extras too; the database classifies them as review.
    for (const payment of proof.confirmed) {
      const { data, error: processingError } = await admin.rpc("reconcile_pey_payment", {
        p_merchant_id: merchant.id,
        p_owner_user_id: user.id,
        p_charge_id: charge.id,
        p_pey_api_key_id: merchant.pey_api_key_id,
        p_pey_ref: charge.pey_ref,
        p_transaction_id: payment.transactionId,
        p_amount_cents: payment.amountCents,
        p_paid_at: payment.paidAt,
      });
      if (processingError) {
        const failure = catalogRpcFailure(processingError);
        if (failure.status === 403 || failure.status === 404) throw new ApiError(failure.status, failure.message);
        throw new ApiError(503, "La verificación quedó incompleta. Vuelve a verificar para terminar sin duplicar pagos.");
      }
      if (!data || data.retry !== false) {
        // Per-transaction writes are idempotent. A retry safely resumes an
        // interrupted batch; never claim no data changed after a partial write.
        throw new ApiError(503, "La verificación quedó incompleta. Vuelve a verificar para terminar sin duplicar pagos.");
      }
      if (data.outcome === "transaction_conflict") {
        // The RPC retains an audit entry. An earlier paid charge must never
        // disguise a conflicting provider transaction as a successful check.
        throw new ApiError(409, "Pey devolvió una transacción que no coincide con el registro guardado. Requiere revisión; no repitas el pago.");
      }
      if (!["paid", "paid_late", "review", "duplicate_transaction"].includes(data.outcome)
        || data.charge_id !== charge.id) {
        throw new ApiError(503, "La verificación quedó incompleta. Vuelve a verificar para terminar sin duplicar pagos.");
      }
    }

    const { data: updated, error: refreshError } = await scoped().single();
    if (refreshError || !updated) throw new ApiError(503, "No se pudo consultar el resultado. Vuelve a verificar sin repetir el pago.");
    const outcome = proof.confirmed.length === 0 ? "no_payment"
      : updated.payment_status === "review" ? "review"
      : updated.payment_status === "paid" ? (updated.late_payment ? "paid_late" : "paid")
      : "review";
    return NextResponse.json({
      charge: publicCharge(updated),
      reconciliation: { outcome, checked_count: proof.checkedCount, confirmed_count: proof.confirmed.length },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) { return fail(e); }
}
