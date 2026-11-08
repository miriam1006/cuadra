import assert from "node:assert/strict";
import test from "node:test";
import { parseProductCsv, previewProductCsv, csvPriceInCents, PRODUCT_CSV_TEMPLATE } from "../src/lib/product-csv";

test("plantilla BOM, códigos con ceros y precio en pesos exactos", () => {
  const parsed = parseProductCsv(PRODUCT_CSV_TEMPLATE);
  assert.deepEqual(parsed.errors, []); assert.equal(parsed.rows[0].barcode, "001234567890");
  assert.equal(parsed.rows[0].priceCents, 1500); assert.equal(parsed.rows[1].barcode, null);
});
test("punto y coma, decimal coma, comillas escapadas y campo multilínea", () => {
  const parsed = parseProductCsv('nombre;precio;codigo\r\n"Agua; \"\"mineral\"\"\nfría";15,50;00001\r\n');
  assert.deepEqual(parsed.errors, []); assert.equal(parsed.delimiter, ";");
  assert.equal(parsed.rows[0].name, 'Agua; "mineral" fría'); assert.equal(parsed.rows[0].priceCents, 1550); assert.equal(parsed.rows[0].error, null);
});
test("columnas opcionales y reordenadas", () => {
  assert.equal(parseProductCsv("precio,nombre\n0.01,Pan").rows[0].priceCents, 1);
  assert.equal(parseProductCsv("codigo,precio,nombre\n0001,1.20,Pan").rows[0].barcode, "0001");
});
test("no acepta importes ambiguos, redondeados o fuera de límite", () => {
  for (const value of ["0", "-1", "1.001", "1,000.50", "1.000,50", "1e3", "NaN", "1000000.01"]) assert.equal(csvPriceInCents(value), null, value);
  assert.equal(csvPriceInCents("1000000.00"), 100000000); assert.equal(csvPriceInCents("15,5"), 1550);
});
test("duplicados de código marcan ambas filas y preservan texto", () => {
  const parsed = parseProductCsv("nombre,precio,codigo\nA,1,0001\nB,2,0001");
  assert.ok(parsed.rows.every(row => row.error?.includes("Código repetido")));
});
test("sintaxis rota, headers inválidos, columnas extra y límites", () => {
  for (const csv of ['nombre,precio\n"Pan,2', 'nombre,precio\n"Pan"basura,2', "nombre,nombre\nA,B", "nombre,precio,inventario\nA,1,2", "", "nombre,precio"]) assert.ok(parseProductCsv(csv).errors.length, csv);
  assert.ok(parseProductCsv("nombre,precio\nA,1,extra").rows[0].error);
  assert.ok(parseProductCsv("nombre,precio\n" + Array(101).fill("A,1").join("\n")).errors.length);
  assert.ok(parseProductCsv("a".repeat(256 * 1024 + 1)).errors.length);
  assert.ok(parseProductCsv("á".repeat(140000)).errors.length);
  assert.equal(parseProductCsv("nombre,precio\n" + Array(100).fill("A,1").join("\n")).rows.length, 100);
});
test("nombres, controles y código inválido se señalan por fila", () => {
  assert.ok(parseProductCsv('nombre,precio,codigo\nPan,1,"uno\ndos"').rows[0].error);
  assert.ok(parseProductCsv(`nombre,precio\n${"x".repeat(101)},1`).rows[0].error);
  assert.ok(parseProductCsv("nombre,precio\nPan\u0000,1").rows[0].error);
});
test("repetir carga omite códigos existentes y nombre/precio sin código, incluidos archivados", () => {
  const parsed = parseProductCsv("nombre,precio,codigo\nNombre nuevo,99,001\nPAN,2,\nAgua,3,\nAgua,3,");
  const planned = previewProductCsv(parsed.rows, [{name:"Otro",price_cents:100,barcode:"001"},{name:"Pan",price_cents:200,barcode:null}]);
  assert.deepEqual(planned.map(row => row.status), ["skipped", "skipped", "ready", "skipped"]);
  assert.ok(planned[0].reason.includes("no se sobrescribe"));
});
