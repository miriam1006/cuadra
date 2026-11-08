import assert from "node:assert/strict";
import test from "node:test";
import { corteShareText, isValidCorteDate, mexicoCityDate, parseCorteSummary, previousCorteDate } from "../src/lib/corte-date";

test("only canonical real ISO calendar dates through today are accepted", () => {
  const today = "2026-11-08";
  for (const value of ["2026-11-08", "2026-11-07", "2024-02-29", "2000-02-29", "0001-01-01"]) assert.equal(isValidCorteDate(value, today), true, value);
  for (const value of ["2026-02-30", "2026-02-29", "1900-02-29", "2026-04-31", "2026-00-01", "2026-13-01", "2026-01-00", "2026-11-09", "0000-01-01", "2026-1-01", "2026-01-1", " 2026-11-08", "2026-11-08 ", "2026-11-08T00:00:00Z", "11/08/2026", "", null, 20261108]) assert.equal(isValidCorteDate(value, today), false, String(value));
  assert.equal(isValidCorteDate("2026-11-08", "invalid"), false);
});

test("today follows Mexico City at UTC midnight and its own midnight boundary", () => {
  assert.equal(mexicoCityDate(new Date("2026-11-09T00:30:00Z")), "2026-11-08");
  assert.equal(mexicoCityDate(new Date("2026-11-09T05:59:59Z")), "2026-11-08");
  assert.equal(mexicoCityDate(new Date("2026-11-09T06:00:00Z")), "2026-11-09");
  assert.equal(isValidCorteDate("2026-11-09", mexicoCityDate(new Date("2026-11-09T00:30:00Z"))), false);
});

test("yesterday handles month/year/leap boundaries without host timezone dependence", () => {
  assert.equal(previousCorteDate("2026-11-08"), "2026-11-07");
  assert.equal(previousCorteDate("2026-01-01"), "2025-12-31");
  assert.equal(previousCorteDate("2024-03-01"), "2024-02-29");
  assert.equal(previousCorteDate("2026-03-01"), "2026-02-28");
  assert.equal(previousCorteDate("0001-01-01"), null);
  assert.equal(previousCorteDate("2026-02-30"), null);
});

const summary = { date: "2026-11-07", total_paid_cents: 15050, paid_count: 2, pending_count: 1, review_receipt_count: 1, review_amount_cents: 500 };
test("a stale or malformed corte response cannot be attached to a new selected date", () => {
  assert.deepEqual(parseCorteSummary(summary, summary.date), summary);
  assert.equal(parseCorteSummary(summary, "2026-11-08"), null);
  for (const invalid of [{ ...summary, total_paid_cents: "15050" }, { ...summary, total_paid_cents: -1 }, { ...summary, paid_count: 1.5 }, { ...summary, pending_count: Number.MAX_SAFE_INTEGER + 1 }, { ...summary, review_amount_cents: undefined }, null]) assert.equal(parseCorteSummary(invalid, summary.date), null);
});

test("WhatsApp summary uses the exact verified historical date and role scope", () => {
  const text = corteShareText(summary, "Mi café", "admin");
  assert.ok(text.includes("\n2026-11-07\n"));
  assert.ok(text.includes("$150.50"));
  assert.ok(text.includes("No es un cierre guardado"));
  assert.ok(text.startsWith("Corte del negocio · Mi café"));
  assert.ok(corteShareText(summary, "Mi café", "cashier").startsWith("Mi corte · Mi café"));
});
