export type CorteSummary = {
  date: string;
  total_paid_cents: number;
  paid_count: number;
  review_receipt_count: number;
  review_amount_cents: number;
  pending_count: number;
};

/** Calendar date in the business timezone, independent of browser/server timezone. */
export function mexicoCityDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Mexico_City", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const part = (type: string) => parts.find(item => item.type === type)?.value || "";
  return `${part("year").padStart(4, "0")}-${part("month")}-${part("day")}`;
}

function calendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
}

/** Only real, canonical ISO dates through today's Mexico City business date. */
export function isValidCorteDate(value: unknown, today = mexicoCityDate()): value is string {
  return calendarDate(value) && calendarDate(today) && value <= today;
}

export function previousCorteDate(date: string): string | null {
  if (!calendarDate(date)) return null;
  const previous = new Date(`${date}T12:00:00.000Z`);
  previous.setUTCDate(previous.getUTCDate() - 1);
  const result = previous.toISOString().slice(0, 10);
  return calendarDate(result) ? result : null;
}

/** Bind response data to the date actually requested, never to the latest selector. */
export function parseCorteSummary(value: unknown, requestedDate: string): CorteSummary | null {
  if (!calendarDate(requestedDate) || !value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (input.date !== requestedDate) return null;
  const keys = ["total_paid_cents", "paid_count", "review_receipt_count", "review_amount_cents", "pending_count"] as const;
  if (keys.some(key => typeof input[key] !== "number" || !Number.isSafeInteger(input[key]) || (input[key] as number) < 0)) return null;
  return {
    date: requestedDate,
    total_paid_cents: input.total_paid_cents as number,
    paid_count: input.paid_count as number,
    review_receipt_count: input.review_receipt_count as number,
    review_amount_cents: input.review_amount_cents as number,
    pending_count: input.pending_count as number,
  };
}

export function corteShareText(summary: CorteSummary, merchantName: string, role: "admin" | "cashier"): string {
  const money = (cents: number) => new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(cents / 100);
  return `${role === "admin" ? "Corte del negocio" : "Mi corte"} · ${merchantName}\n${summary.date}\nTotal recibido: ${money(summary.total_paid_cents)} MXN\nPagos confirmados: ${summary.paid_count}\nCobros pendientes: ${summary.pending_count}\nRecibos por revisar: ${summary.review_receipt_count}\nResumen actual por fecha del pago (Ciudad de México). No es un cierre guardado.\nGenerado con Cuadra`;
}
