import assert from "node:assert/strict";
import test from "node:test";
import { parseVoiceCharge } from "../src/lib/voice-amount";

const cases: [string, number, string][] = [
  ["150", 15000, ""],
  ["150.50", 15050, ""],
  ["$1,200", 120000, ""],
  ["cobra $1,200.50 diseño de uñas", 120050, "diseño de uñas"],
  ["Cóbrale ciento cincuenta pesos Corte de cabello", 15000, "Corte de cabello"],
  ["son mil doscientos varos reparación", 120000, "reparación"],
  ["es doscientos cincuenta y cinco", 25500, ""],
  ["treinta y cinco pesos con cincuenta centavos manicure", 3550, "manicure"],
  ["ciento cincuenta pesos cincuenta centavos", 15050, ""],
  ["150 con 5 centavos", 15005, ""],
  ["cero pesos con un centavo prueba", 1, "prueba"],
  ["cincuenta centavos", 50, ""],
  ["veintidós pesos mexicanos café", 2200, "café"],
  ["novecientos noventa y nueve mil novecientos noventa y nueve", 99999900, ""],
  ["cobra: 150 pesos, corte y lavado.", 15000, "corte y lavado"],
  ["¿Son 150 pesos por 2 cafés?", 15000, "por 2 cafés"],
  ["150 pesos con diseño francés", 15000, "con diseño francés"],
  ["0.01 prueba", 1, "prueba"],
  ["150 - corte", 15000, "corte"],
  ["90071992547409.91", Number.MAX_SAFE_INTEGER, ""],
];
for (const [text, amountCents, concept] of cases) {
  test(`voice amount: ${text}`, () => assert.deepEqual(parseVoiceCharge(text), { amountCents, concept }));
}

test("rejects malformed, unsafe, negative and ambiguous amounts without partial parsing", () => {
  for (const text of [
    "", "corte de cabello", "cobra", "cero", "0", "0.00", "cero centavos", "-150 corte",
    "cobra -150", "$-150", "menos ciento cincuenta", "+150", "−150",
    "150.500", "150.005", "1,20", "150,50", "12,34,567", "1.200,50", "1,200.500",
    "150 50", "150 pesos 50", "150, 50", "150 y cinco", "150 - 50", "150 menos cinco",
    "cien cincuenta", "ciento", "treinta cinco", "veinte y cinco", "ciento cero", "dos mil cero",
    "dos cientos cincuenta", "150 punto cincuenta", "ciento cincuenta coma cinco",
    "uno mil", "mil mil", "dos millones mil", "2 millones mil", "dos billones", "150 millones",
    "150 pesos con cien centavos", "150.50 pesos con cinco centavos", "150 pesos con cincuenta",
    "90071992547409.92", "99999999999999999999999999999999999999999999999999999999999999999999999",
  ]) assert.equal(parseVoiceCharge(text), null, text);
});

test("concept keeps accents and internal numbers, collapses whitespace and is bounded", () => {
  assert.deepEqual(parseVoiceCharge("150 pesos,  Diseño   francés de 2 uñas. "), { amountCents: 15000, concept: "Diseño francés de 2 uñas" });
  const result = parseVoiceCharge(`150 pesos ${"á".repeat(140)}`);
  assert.equal(result?.concept, "á".repeat(100));
});

test("amounts above merchant limit remain exact for existing form validation", () => {
  assert.deepEqual(parseVoiceCharge("10000 pesos anticipo"), { amountCents: 1000000, concept: "anticipo" });
});

const conceptFirstCases: [string, number, string][] = [
  ["uñas 150", 15000, "uñas"],
  ["manicure por ciento cincuenta pesos", 15000, "manicure"],
  ["corte de cabello cuesta 150.50", 15050, "corte de cabello"],
  ["cobra uñas 150", 15000, "uñas"],
  ["uñas ciento cincuenta", 15000, "uñas"],
  ["reparación mil doscientos pesos", 120000, "reparación"],
  ["manicure treinta y cinco pesos con cincuenta centavos", 3550, "manicure"],
  ["Cóbrale Diseño francés de $1,200.50", 120050, "Diseño francés"],
  ["¿Corte y lavado por 150 pesos?", 15000, "Corte y lavado"],
  ["Reparación 0.01", 1, "Reparación"],
  ["Servicio cincuenta centavos", 50, "Servicio"],
  ["Manicure ciento cincuenta pesos cincuenta centavos", 15050, "Manicure"],
  ["  Diseño   francés cuesta 150 pesos. ", 15000, "Diseño francés"],
  ["servicio por de 150", 15000, "servicio"],
  ["Manicure 150 con 5 centavos", 15005, "Manicure"],
  ["Café veintidós pesos mexicanos", 2200, "Café"],
  ["Anticipo $10,000", 1000000, "Anticipo"],
];
for (const [text, amountCents, concept] of conceptFirstCases) {
  test(`concept-first voice amount: ${text}`, () => assert.deepEqual(parseVoiceCharge(text), { amountCents, concept }));
}

test("concept-first does not guess among quantities, alternatives, phones or negative prices", () => {
  for (const text of [
    "uñas 150 o 200", "manicure 2 por 150", "manicure dos por 150",
    "uñas 150 200", "uñas ciento cincuenta doscientos", "uñas doscientos o ciento cincuenta",
    "Studio Uno 150", "servicio cien por 150", "servicio punto cinco 150",
    "uñas -150", "uñas - 150", "uñas menos 150", "uñas negativo 150", "uñas +150",
    "uñas 0", "uñas cero", "uñas cero centavos", "uñas 150.005", "uñas 150,50",
    "uñas treinta cinco", "uñas cien cincuenta", "uñas dos millones", "uñas 150 pesos con cien centavos",
    "teléfono 5512345678", "servicio 525512345678", "servicio 55 1234 5678", "servicio +52 55 1234 5678",
    "uñas 90071992547409.92", "uñas 150 hoy", "corte de cabello", "150 200", "menos 150",
  ]) assert.equal(parseVoiceCharge(text), null, text);
});

test("amount-first quantity-looking phrases keep the original meaning instead of falling back", () => {
  assert.deepEqual(parseVoiceCharge("2 cafés"), { amountCents: 200, concept: "cafés" });
  assert.deepEqual(parseVoiceCharge("2 cafés de 30"), { amountCents: 200, concept: "cafés de 30" });
  assert.equal(parseVoiceCharge("2 30"), null);
  assert.equal(parseVoiceCharge("dos treinta"), null);
});

test("concept-first retains original accents, collapses whitespace and caps concept length", () => {
  const concept = "á".repeat(140);
  assert.deepEqual(parseVoiceCharge(`${concept} 150`), { amountCents: 15000, concept: "á".repeat(100) });
  assert.deepEqual(parseVoiceCharge("Servicio Élite por 150 pesos"), { amountCents: 15000, concept: "Servicio Élite" });
});
