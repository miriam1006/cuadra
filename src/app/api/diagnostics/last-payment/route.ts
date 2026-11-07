import { NextResponse } from "next/server";
import { z } from "zod";
import { owner, fail, ApiError } from "@/lib/api";
import { getPeyQrTransactions, PeyError } from "@/lib/pey";
import { pesosToCents } from "@/lib/payment-validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Owner-only diagnostic, deliberately unable to reconcile or mark a payment paid. */
export async function GET(request: Request) {
  try {
    const { merchant, admin } = await owner();
    if (!merchant) throw new ApiError(404, "No hay un comercio configurado.");
    const requestedId = new URL(request.url).searchParams.get("charge_id");
    if (requestedId && !z.uuid().safeParse(requestedId).success) {
      throw new ApiError(400, "Identificador de cobro inválido.");
    }
    let query = admin.from("charges")
      .select("id,amount_cents,status,pey_ref,num_ref,created_at,payment_status,failure_code")
      .eq("merchant_id", merchant.id);
    if (requestedId) query = query.eq("id", requestedId);
    const { data: charge, error } = await query.order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (error) throw new ApiError(503, "No se pudo consultar el cobro.");
    if (!charge) throw new ApiError(404, "No hay cobros para diagnosticar.");

    // Provider-event tables have no browser grants. Scope every service-role query
    // to this owner's merchant key AND this exact QR (or never-reused reference).
    const events = () => {
      let q = admin.from("webhook_events")
        .select("processed_at,outcome,error", { count: "exact" })
        .eq("payload->>apiKeyId", merchant.pey_api_key_id)
        .eq("payload->>type", "codi.qr.payment_received");
      q = charge.pey_ref ? q.eq("payload->>codiQrId", charge.pey_ref) : q.eq("payload->>numRef", charge.num_ref);
      return q;
    };
    const [eventRows, processedRows, pendingRows] = await Promise.all([
      events().order("received_at", { ascending: false }).limit(100),
      events().not("processed_at", "is", null).limit(0),
      events().is("processed_at", null).limit(0),
    ]);
    if (eventRows.error || processedRows.error || pendingRows.error) {
      throw new ApiError(503, "No se pudo consultar el historial de notificaciones.");
    }
    const outcomes: Record<string, number> = {};
    const errors: Record<string, number> = {};
    // Only known internal classifications are exposed, never stored payloads/errors.
    const allowedOutcomes = new Set(["paid", "paid_late", "review", "duplicate", "duplicate_transaction", "transaction_conflict", "unmatched"]);
    const allowedErrors = new Set(["charge_not_found_or_key_mismatch", "transaction_conflict"]);
    for (const event of eventRows.data || []) {
      const label = allowedOutcomes.has(event.outcome) ? event.outcome : "unclassified";
      outcomes[label] = (outcomes[label] || 0) + 1;
      if (event.error) {
        const label = allowedErrors.has(event.error) ? event.error : "processing_error";
        errors[label] = (errors[label] || 0) + 1;
      }
    }

    let provider: Record<string, unknown> = { checked: false, reason: "missing_qr_reference" };
    if (charge.pey_ref) {
      try {
        const result = await getPeyQrTransactions(charge.pey_ref);
        const paid = result.items.filter(item => item.status === "PAID");
        provider = {
          checked: true,
          transaction_count: result.items.length,
          confirmed_count: paid.length,
          matching_amount_count: paid.filter(item => {
            try { return pesosToCents(item.amount) === charge.amount_cents && (!item.currency || item.currency === "MXN"); }
            catch { return false; }
          }).length,
          transaction_statuses: result.items.map(item => item.status),
          confirmed_folios: paid.map(item => item.id.slice(-6)),
          latest_paid_at: paid.filter(item => item.datePaid).map(item => item.datePaid!).sort((a,b) => b-a)[0] || null,
          truncated: result.hasMore,
        };
      } catch (e) {
        provider = { checked: false, reason: e instanceof PeyError ? e.code : "unavailable", http_status: e instanceof PeyError ? e.httpStatus || null : null };
      }
    }
    const appUrl = process.env.APP_URL;
    return NextResponse.json({
      checked_at: new Date().toISOString(),
      read_only: true,
      charge,
      configuration: {
        expected_webhook_url: appUrl ? new URL("/api/webhooks/pey", appUrl).toString() : null,
        webhook_secret_configured: Boolean(process.env.PEY_WEBHOOK_SECRET),
        api_key_configured: Boolean(process.env.PEY_API_KEY),
        merchant_key_matches_environment: merchant.pey_api_key_id === process.env.PEY_API_KEY_ID,
      },
      webhook: {
        event_count: eventRows.count || 0,
        processed_count: processedRows.count || 0,
        pending_count: pendingRows.count || 0,
        outcomes,
        errors,
        outcomes_sample_truncated: (eventRows.count || 0) > 100,
        note: "Solo incluye eventos con firma válida que alcanzaron el procesamiento en la base de datos.",
      },
      provider,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) { return fail(e); }
}
