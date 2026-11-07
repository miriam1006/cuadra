import assert from "node:assert/strict";
import test from "node:test";
import { reconciliationRequestSchema, reconciliationScopeAllowed, parseReconciliationProof } from "../src/lib/reconciliation-validation";

const now = 1_800_000_000;
const paid = { id: "transaction-1", status: "PAID", amount: 0.01, currency: "MXN", paymentMethod: "CODI", datePaid: now - 10 };
const page = (items: unknown[], hasMore = false) => ({ items, hasMore });

test("browser supplies no payment proof or amount", () => {
  assert.equal(reconciliationRequestSchema.safeParse({}).success, true);
  for (const body of [{ amount: 0.01 }, { status: "PAID" }, { transaction_id: "fake" }, null]) {
    assert.equal(reconciliationRequestSchema.safeParse(body).success, false);
  }
});

test("reconciliation scope requires exact owner, merchant, key and existing QR", () => {
  const scope = { userId: "owner", merchantId: "merchant", merchantOwnerId: "owner", merchantApiKeyId: "key", expectedApiKeyId: "key", chargeMerchantId: "merchant", qrId: "qr" };
  assert.equal(reconciliationScopeAllowed(scope), true);
  for (const patch of [{ userId: "other" }, { chargeMerchantId: "other" }, { expectedApiKeyId: "other" }, { expectedApiKeyId: undefined }, { qrId: null }]) {
    assert.equal(reconciliationScopeAllowed({ ...scope, ...patch }), false);
  }
});

test("authenticated proof retains mismatches and extra payments as actual receipts", () => {
  const proof = parseReconciliationProof(page([paid, { ...paid, id: "transaction-2", amount: 0.02, datePaid: now - 20 }]), now);
  assert.equal(proof.checkedCount, 2);
  assert.deepEqual(proof.confirmed.map(item => [item.transactionId, item.amountCents]), [["transaction-2", 2], ["transaction-1", 1]]);
  assert.equal(proof.confirmed[0].paidAt, new Date((now - 20) * 1000).toISOString());
  assert.deepEqual(parseReconciliationProof(page([{ ...paid, status: "PENDING", datePaid: undefined }]), now).confirmed, []);
});

test("incomplete or truncated provider evidence fails closed before any write", () => {
  for (const invalid of [
    page([paid], true), page([paid, { ...paid, id: "transaction-2", currency: undefined }]),
    page([{ ...paid, currency: "USD" }]), page([{ ...paid, paymentMethod: undefined }]),
    page([{ ...paid, paymentMethod: "CARD" }]), page([{ ...paid, datePaid: undefined }]),
    page([{ ...paid, datePaid: now + 301 }]), page([{ ...paid, datePaid: (now - 10) * 1000 }]),
    page([{ ...paid, datePaid: now - 0.5 }]), page([{ ...paid, datePaid: 1 }]), page([{ ...paid, amount: 0.001 }]),
    page([{ ...paid, amount: 0 }]), page([{ ...paid, amount: 30_000_000 }]),
    page([{ ...paid, id: "" }]), page([paid, paid]),
  ]) assert.throws(() => parseReconciliationProof(invalid, now));
});
