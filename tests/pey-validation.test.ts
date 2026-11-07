import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { peyQrInputSchema, peyQrPaymentSchema, pesosToCents, verifyPeyWebhook } from "../src/lib/payment-validation";

test("signature accepts untouched body and rejects tampering and stale delivery", () => {
  const key = Buffer.from("test-only-webhook-signing-key-32-bytes");
  const secret = `whsec_${key.toString("base64")}`;
  const body = '{"type":"test","amount":1}';
  const id = "test-webhook";
  const sign = (time: number) => ({
    "webhook-id": id, "webhook-timestamp": String(time),
    "webhook-signature": `v1,${createHmac("sha256", key).update(`${id}.${time}.${body}`).digest("base64")}`,
  });
  const now = Math.floor(Date.now() / 1000);
  assert.deepEqual(verifyPeyWebhook(body, secret, sign(now)), { type: "test", amount: 1 });
  assert.throws(() => verifyPeyWebhook(body.replace('1}', '2}'), secret, sign(now)));
  assert.throws(() => verifyPeyWebhook(body, secret, sign(now - 601)));
  assert.throws(() => verifyPeyWebhook(body, secret, sign(now + 601)));
});

test("MXN conversion preserves centavos and tolerates binary floating point", () => {
  assert.equal(pesosToCents(0.01), 1);
  assert.equal(pesosToCents(150), 15000);
  assert.equal(pesosToCents(0.29), 29);
  for (const amount of [0, -1, 0.001, 1.999, NaN, Infinity]) {
    assert.throws(() => pesosToCents(amount));
  }
});

test("QR references preserve leading zeros and reject invalid input", () => {
  const base = { amountCents: 1, concept: "Prueba", numRef: "0000123" };
  assert.equal(peyQrInputSchema.parse(base).numRef, "0000123");
  for (const numRef of ["12345678", "12a", "", "-1"]) {
    assert.equal(peyQrInputSchema.safeParse({ ...base, numRef }).success, false);
  }
  assert.equal(peyQrInputSchema.safeParse({ ...base, amountCents: 0.5 }).success, false);
});

test("payment parser strips bank metadata and rejects unrepresentable amounts", () => {
  const payload = { type: "codi.qr.payment_received", amount: 0.01, apiKeyId: "api-key-id",
    codiQrId: "qr-id", concept: "Prueba", datePaid: 1790724818,
    numRef: "1", transactionId: "txn-id", metadata: { clabe: "sensitive" } };
  assert.equal("metadata" in peyQrPaymentSchema.parse(payload), false);
  assert.equal(peyQrPaymentSchema.safeParse({ ...payload, amount: 0.001 }).success, false);
  assert.equal(peyQrPaymentSchema.safeParse({ ...payload, type: "unknown" }).success, false);
});
