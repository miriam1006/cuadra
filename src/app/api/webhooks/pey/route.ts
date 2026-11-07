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
  if (!secret || !expectedApiKeyId) return respond(503, { error: "Webhook sin configurar." });

  const id = request.headers.get("webhook-id");
  const timestamp = request.headers.get("webhook-timestamp");
  const signature = request.headers.get("webhook-signature");
  if (!id || id.length > 256 || !timestamp || !signature) {
    return respond(401, { error: "Firma inválida." });
  }
  let rawBody: string;
  try { rawBody = await readLimitedBody(request); }
  catch { return respond(413, { error: "Solicitud demasiado grande." }); }

  let verifiedPayload: unknown;
  try {
    // Library verifies signature and the default five-minute timestamp tolerance.
    // Never JSON.parse or reserialize before verification.
    verifiedPayload = verifyPeyWebhook(rawBody, secret, {
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": signature,
    });
  } catch { return respond(401, { error: "Firma inválida." }); }

  if (typeof verifiedPayload !== "object" || verifiedPayload === null) {
    return respond(400, { error: "Evento inválido." });
  }
  if ((verifiedPayload as { type?: unknown }).type !== "codi.qr.payment_received") {
    // This MVP only handles QR payments. Other signed events cannot change charges.
    return respond(200, { received: true, ignored: true });
  }
  const parsed = peyQrPaymentSchema.safeParse(verifiedPayload);
  if (!parsed.success) return respond(400, { error: "Evento de pago inválido." });
  const payment = parsed.data;
  if (payment.apiKeyId !== expectedApiKeyId) return respond(401, { error: "Cuenta no autorizada." });

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
      console.error("pey_webhook_processing_pending", { webhookId: id });
      return respond(503, { error: "Pago pendiente de procesamiento." });
    }
    return respond(200, { received: true });
  } catch {
    console.error("pey_webhook_processing_failed", { webhookId: id });
    return respond(503, { error: "No se pudo procesar el pago." });
  }
}
