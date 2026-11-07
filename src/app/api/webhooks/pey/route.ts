import { createAdminClient } from "@/lib/supabase/admin";
import { peyQrPaymentSchema, pesosToCents, verifyPeyWebhook } from "@/lib/payment-validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 128 * 1024;
const respond = (status: number, body: Record<string, unknown>) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

async function readLimitedBody(request: Request): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error("body_too_large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function POST(request: Request) {
  const secret = process.env.PEY_WEBHOOK_SECRET;
  const expectedApiKeyId = process.env.PEY_API_KEY_ID;
  if (!secret || !expectedApiKeyId) {
    console.error("pey_webhook_rejected", { reason: "configuration_missing", status: 503 });
    return respond(503, { error: "Webhook sin configurar." });
  }

  const id = request.headers.get("webhook-id");
  const timestamp = request.headers.get("webhook-timestamp");
  const signature = request.headers.get("webhook-signature");
  console.info("pey_webhook_received", { webhookId: id?.slice(0, 256), hasTimestamp: Boolean(timestamp), hasSignature: Boolean(signature) });
  if (!id || id.length > 256 || !timestamp || !signature) {
    console.warn("pey_webhook_rejected", { reason: "headers_missing_or_invalid", status: 401 });
    return respond(401, { error: "Firma inválida." });
  }
  let rawBody: string;
  try { rawBody = await readLimitedBody(request); }
  catch { console.warn("pey_webhook_rejected", { reason: "body_too_large", status: 413 }); return respond(413, { error: "Solicitud demasiado grande." }); }

  let verifiedPayload: unknown;
  try {
    // Library verifies signature and the default five-minute timestamp tolerance.
    // Never JSON.parse or reserialize before verification.
    verifiedPayload = verifyPeyWebhook(rawBody, secret, {
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": signature,
    });
  } catch { console.warn("pey_webhook_rejected", { webhookId: id, reason: "signature_or_timestamp_invalid", status: 401 }); return respond(401, { error: "Firma inválida." }); }

  if (typeof verifiedPayload !== "object" || verifiedPayload === null) {
    console.warn("pey_webhook_rejected", { webhookId: id, reason: "invalid_event", status: 400 });
    return respond(400, { error: "Evento inválido." });
  }
  if ((verifiedPayload as { type?: unknown }).type !== "codi.qr.payment_received") {
    // This MVP only handles QR payments. Other signed events cannot change charges.
    console.info("pey_webhook_ignored", { webhookId: id, reason: "unsupported_event_type" });
    return respond(200, { received: true, ignored: true });
  }
  const parsed = peyQrPaymentSchema.safeParse(verifiedPayload);
  if (!parsed.success) {
    console.warn("pey_webhook_rejected", { webhookId: id, reason: "payment_contract_invalid", fields: parsed.error.issues.map(issue => issue.path.join(".")).slice(0, 12), status: 400 });
    return respond(400, { error: "Evento de pago inválido." });
  }
  const payment = parsed.data;
  if (payment.apiKeyId !== expectedApiKeyId) {
    console.warn("pey_webhook_rejected", { webhookId: id, reason: "api_key_id_mismatch", status: 401 });
    return respond(401, { error: "Cuenta no autorizada." });
  }

  try {
    const { data, error } = await createAdminClient().rpc("process_pey_payment", {
      p_webhook_id: id,
      p_payload: payment,
      p_pey_api_key_id: payment.apiKeyId,
      p_pey_ref: payment.codiQrId,
      p_transaction_id: payment.transactionId,
      p_amount_cents: pesosToCents(payment.amount),
      p_paid_at: new Date(payment.datePaid * 1000).toISOString(),
    });
    if (error || !data || data.retry) {
      // A failed database call or unmatched charge is never acknowledged as processed.
      // A later delivery can retry the durable event. No raw payload in logs.
      console.error("pey_webhook_processing_pending", { webhookId: id, code: error?.code, outcome: data?.outcome });
      return respond(503, { error: "Pago pendiente de procesamiento." });
    }
    console.info("pey_webhook_processed", { webhookId: id, outcome: data.outcome });
    return respond(200, { received: true });
  } catch {
    console.error("pey_webhook_processing_failed", { webhookId: id });
    return respond(503, { error: "No se pudo procesar el pago." });
  }
}
