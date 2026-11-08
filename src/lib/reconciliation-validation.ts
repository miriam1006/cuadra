import { z } from "zod";
import { pesosToCents } from "./payment-validation";

// The browser can ask the server to verify; it cannot supply evidence of payment.
export const reconciliationRequestSchema = z.strictObject({});

export function reconciliationScopeAllowed(input: {
  userId: string;
  merchantId: string;
  merchantOwnerId: string;
  merchantApiKeyId: string;
  expectedApiKeyId: string | undefined;
  chargeMerchantId: string;
  qrId: string | null;
  role?: "admin" | "cashier";
  chargeCreatedBy?: string;
}): boolean {
  // Explicit roles come only from access() after active membership verification.
  // The undefined-role path preserves the legacy single-owner caller contract.
  const actorAllowed = input.role === "admin" ? true
    : input.role === "cashier" ? input.userId === input.chargeCreatedBy
    : input.userId === input.merchantOwnerId;
  return Boolean(input.expectedApiKeyId && input.qrId
    && input.userId && actorAllowed
    && input.merchantId === input.chargeMerchantId
    && input.merchantApiKeyId === input.expectedApiKeyId);
}

const pageSchema = z.object({
  hasMore: z.literal(false),
  items: z.array(z.object({
    id: z.string().min(1).max(128),
    status: z.enum(["PENDING", "PAID"]),
    amount: z.number().finite().nonnegative(),
    currency: z.string().optional(),
    paymentMethod: z.string().optional(),
    datePaid: z.number().optional(),
  })).max(20),
});

/** Validate the ENTIRE authenticated provider response before the first DB write.
 * QR identity comes from the server-selected /transaction/codi/qr/{id} endpoint,
 * whose contract only returns transactions for that QR under the current API key.
 */
export function parseReconciliationProof(page: unknown, nowSeconds = Math.floor(Date.now() / 1000)) {
  const parsed = pageSchema.parse(page);
  const seen = new Set<string>();
  const confirmed = [];
  for (const item of parsed.items) {
    if (seen.has(item.id)) throw new Error("duplicate_provider_transaction");
    seen.add(item.id);
    if (item.status !== "PAID") continue;
    if (item.currency !== "MXN" || item.paymentMethod !== "CODI"
      || !Number.isSafeInteger(item.datePaid) || !item.datePaid
      || item.datePaid < 946_684_800 || item.datePaid > nowSeconds + 300) {
      throw new Error("incomplete_provider_payment_proof");
    }
    const amountCents = pesosToCents(item.amount);
    if (amountCents > 2_147_483_647) throw new Error("provider_amount_out_of_range");
    confirmed.push({
      transactionId: item.id,
      amountCents,
      paidAt: new Date(item.datePaid * 1000).toISOString(),
    });
  }
  confirmed.sort((a, b) => a.paidAt.localeCompare(b.paidAt) || a.transactionId.localeCompare(b.transactionId));
  return { checkedCount: parsed.items.length, confirmed };
}
