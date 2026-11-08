import assert from "node:assert/strict";
import test from "node:test";
import { productInputSchema, chargeInputSchema, cartChargeSchema, canAccessCharge, catalogRpcFailure } from "../src/lib/catalog-validation";

const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";

test("catalog prices remain integer centavos and names/barcodes are normalized", () => {
  assert.deepEqual(productInputSchema.parse({ name: "  Café con leche  ", price_cents: 1, barcode: " 000123  " }), { name: "Café con leche", price_cents: 1, barcode: "000123", active: true });
  assert.equal(productInputSchema.parse({ name: "Café", price_cents: 2500, barcode: " " }).barcode, null);
  assert.equal(productInputSchema.parse({ name: "Café", price_cents: 2500 }).barcode, null);
  assert.equal(productInputSchema.parse({ name: "Café", price_cents: 2500, barcode: "SKU 012-A", active: false }).active, false);
  for (const bad of [
    { name: "", price_cents: 1 }, { name: "A".repeat(101), price_cents: 1 },
    { name: "A\nB", price_cents: 1 }, { name: "Café", price_cents: 0 },
    { name: "Café", price_cents: 1.2 }, { name: "Café", price_cents: "2500" },
    { name: "Café", price_cents: 100_000_001 }, { name: "Café", price_cents: 1, barcode: "A".repeat(65) },
    { name: "Café", price_cents: 1, barcode: "A\nB" }, { name: "Café", price_cents: 1, active: "true" },
    { name: "Café", price_cents: 1, merchant_id: first },
  ]) assert.equal(productInputSchema.safeParse(bad).success, false);
});

test("manual and cart inputs cannot mix or inject client prices", () => {
  assert.equal(chargeInputSchema.safeParse({ amount_cents: 1, concept: " Venta " }).success, true);
  assert.equal(chargeInputSchema.safeParse({ items: [{ product_id: first, quantity: 2 }] }).success, true);
  for (const bad of [
    { amount_cents: 1, items: [{ product_id: first, quantity: 1 }] },
    { items: [{ product_id: first, quantity: 1, price_cents: 1 }] },
    { items: [{ product_id: first, quantity: 1 }], amount_cents: 1 },
    { items: [{ product_id: first, quantity: 1 }], concept: "Override" },
    { amount_cents: 1, status: "paid" }, { items: [{ product_id: first, quantity: "1" }] },
  ]) assert.equal(chargeInputSchema.safeParse(bad).success, false);
});

test("cart rejects duplicate products, malformed IDs and unbounded quantities", () => {
  assert.equal(cartChargeSchema.safeParse({ items: [{ product_id: first, quantity: 999 }, { product_id: second, quantity: 1 }] }).success, true);
  for (const bad of [
    { items: [] }, { items: [{ product_id: first, quantity: 1 }, { product_id: first, quantity: 2 }] },
    { items: [{ product_id: "a1111111-1111-4111-8111-111111111111", quantity: 1 }, { product_id: "A1111111-1111-4111-8111-111111111111", quantity: 2 }] },
    { items: [{ product_id: "not-a-uuid", quantity: 1 }] }, { items: [{ product_id: first, quantity: 0 }] },
    { items: [{ product_id: first, quantity: 1000 }] }, { items: [{ product_id: first, quantity: 1.5 }] },
    { items: Array.from({ length: 51 }, (_, n) => ({ product_id: `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`, quantity: 1 })) },
  ]) assert.equal(cartChargeSchema.safeParse(bad).success, false);
});

test("cashiers access only their charges while verified admins access their merchant", () => {
  assert.equal(canAccessCharge("cashier", "cashier-a", "cashier-a"), true);
  assert.equal(canAccessCharge("cashier", "cashier-a", "cashier-b"), false);
  assert.equal(canAccessCharge("admin", "admin", "cashier-b"), true);
  assert.equal(canAccessCharge("cashier", "", ""), false);
});

test("DB permission, scope and conflict errors do not become service errors or leak details", () => {
  for (const [message, status] of [["admin_required", 403], ["merchant_not_found", 404], ["product_not_found", 404], ["charge_not_found", 404], ["idempotency_conflict", 409], ["rate_limited", 429], ["cart_product_unavailable", 400], ["invalid_cart", 400], ["duplicate_cart_product", 400]] as const) {
    const failure = catalogRpcFailure({ message });
    assert.equal(failure.status, status);
    assert.equal(failure.message.includes(message), false);
  }
  assert.equal(catalogRpcFailure({ code: "23505", message: "private SQL detail" }).status, 409);
  assert.equal(catalogRpcFailure({ message: "private SQL detail" }).status, 503);
});
