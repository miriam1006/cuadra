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
