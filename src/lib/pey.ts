import "server-only";
import { z } from "zod";
import { peyQrInputSchema, peyQrResponseSchema } from "./payment-validation";

export class PeyError extends Error {
  constructor(public readonly code: "configuration" | "network" | "rejected" | "invalid_response",
    public readonly httpStatus?: number) {
    super("No se pudo completar la solicitud con Pey.");
    this.name = "PeyError";
  }
}

/** https://docs.pey.mx/openapi.json — amount MXN; expiration seconds. */
export async function createPeyQr(input: z.input<typeof peyQrInputSchema>) {
  const data = peyQrInputSchema.parse(input);
  const apiKey = process.env.PEY_API_KEY;
  if (!apiKey) throw new PeyError("configuration");

  let response: Response;
  try {
    response = await fetch("https://api.pey.mx/codi/qr", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: data.amountCents / 100,
        concept: data.concept,
        expiration: 600,
        numRef: data.numRef,
        generateImage: false,
        ...(data.bankAccountId ? { bankAccountId: data.bankAccountId } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
      redirect: "error",
    });
  } catch {
    // Do not retry automatically: Pey may have created the QR before a timeout.
    throw new PeyError("network");
  }
  if (!response.ok) throw new PeyError("rejected", response.status);
  try {
    return peyQrResponseSchema.parse(await response.json());
  } catch {
    throw new PeyError("invalid_response", response.status);
  }
}

const qrTransactionsSchema = z.object({
  items: z.array(z.object({
    id: z.string().min(1).max(128),
    status: z.enum(["PENDING", "PAID"]),
    amount: z.number().finite().nonnegative(),
    currency: z.string().max(10).optional(),
    paymentMethod: z.literal("CODI").optional(),
    datePaid: z.number().int().nonnegative().optional(),
  })).max(20),
  nextToken: z.string().nullable().optional(),
});

/** Read-only, first-page diagnostic. Never creates a payment or changes local state.
 * https://docs.pey.mx/docs/api/get-co-di-qr-transactions/
 * Response validation strips all metadata, including bank-account information.
 */
export async function getPeyQrTransactions(qrId: string) {
  const id = z.string().min(1).max(128).parse(qrId);
  const apiKey = process.env.PEY_API_KEY;
  if (!apiKey) throw new PeyError("configuration");
  const signal = AbortSignal.timeout(8_000);
  let response: Response;
  try {
    response = await fetch(`https://api.pey.mx/transaction/codi/qr/${encodeURIComponent(id)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal,
      cache: "no-store",
      redirect: "error",
    });
  } catch { throw new PeyError("network"); }
  if (!response.ok) throw new PeyError("rejected", response.status);
  try {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("empty_response");
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 128 * 1024) { await reader.cancel(); throw new Error("response_too_large"); }
      chunks.push(value);
    }
    const parsed = qrTransactionsSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    return { items: parsed.items, hasMore: Boolean(parsed.nextToken) };
  } catch { throw new PeyError("invalid_response", response.status); }
}
