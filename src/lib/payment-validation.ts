import { z } from "zod";
import { Webhook } from "standardwebhooks";

export function verifyPeyWebhook(rawBody: string, secret: string, headers: {
  "webhook-id": string; "webhook-timestamp": string; "webhook-signature": string;
}): unknown {
  return new Webhook(secret).verify(rawBody, headers);
}

/** All internal monetary values are integer centavos. Never silently round payments. */
export function pesosToCents(amount: number): number {
  const cents = Math.round(amount * 100);
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isSafeInteger(cents)
    || Math.abs(amount * 100 - cents) > 0.000001) {
    throw new Error("El monto debe ser positivo y tener como máximo dos decimales.");
  }
  return cents;
}

export const peyQrInputSchema = z.object({
  amountCents: z.number().int().positive().max(2_147_483_647),
  concept: z.string().trim().min(1).max(100),
  numRef: z.string().regex(/^[0-9]{1,7}$/),
  bankAccountId: z.string().min(1).max(128).optional(),
});

export const peyQrResponseSchema = z.object({
  id: z.string().min(1).max(128),
  qrString: z.string().min(1).max(32_768),
});

/** Keep only fields used to identify and validate this payment. The optional
 * bankAccountId and metadata do not route payments in this single-key MVP and
 * are intentionally stripped, including null/empty provider representations.
 * Authorization still requires the signed apiKeyId, server-created QR and amount.
 */
export const peyQrPaymentSchema = z.object({
  type: z.literal("codi.qr.payment_received"),
  amount: z.number().positive().refine((value) => {
    try { pesosToCents(value); return true; } catch { return false; }
  }, "Monto inválido"),
  apiKeyId: z.string().min(1).max(128),
  codiQrId: z.string().min(1).max(128),
  concept: z.string().max(1000),
  datePaid: z.number().int().positive().max(253_402_300_799),
  numRef: z.string().regex(/^[0-9]{1,7}$/),
  transactionId: z.string().min(1).max(128),
});

export type PeyQrPayment = z.infer<typeof peyQrPaymentSchema>;
