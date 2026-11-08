export const PRODUCT_CSV_MAX_BYTES = 256 * 1024;
export const PRODUCT_CSV_MAX_ROWS = 100;
export type ProductCsvRow = { rowNumber: number; name: string; priceCents: number | null; barcode: string | null; error: string | null };
export type ProductCsvResult = { rows: ProductCsvRow[]; errors: string[]; delimiter: "," | ";" };
export type ExistingCsvProduct = { name: string; price_cents: number; barcode: string | null };
export type ProductCsvPreview = ProductCsvRow & { status: "ready" | "skipped" | "error"; reason: string };
export const PRODUCT_CSV_TEMPLATE = '\uFEFFnombre,precio,codigo\r\nAgua natural,15.00,001234567890\r\nPan dulce,12.50,\r\n';

function delimiterFor(text: string): "," | ";" {
  let quoted = false, commas = 0, semicolons = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') { if (quoted && text[i + 1] === '"') i++; else quoted = !quoted; }
    else if (!quoted && (char === "\r" || char === "\n")) break;
    else if (!quoted && char === ",") commas++;
    else if (!quoted && char === ";") semicolons++;
  }
  return semicolons > commas ? ";" : ",";
}
export function csvPriceInCents(text: string): number | null {
  const value = text.trim().replace(",", ".");
  if (!/^\d{1,8}(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, decimals = ""] = value.split(".");
  const cents = Number(whole) * 100 + Number(decimals.padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents > 0 && cents <= 100_000_000 ? cents : null;
}
const normalizeName = (name: string) => name.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("es-MX");

export function parseProductCsv(input: string): ProductCsvResult {
  const delimiter = delimiterFor(input.replace(/^\uFEFF/, ""));
  const failure = (message: string): ProductCsvResult => ({ rows: [], errors: [message], delimiter });
  if (new TextEncoder().encode(input).byteLength > PRODUCT_CSV_MAX_BYTES) return failure("El archivo supera 256 KB.");
  const text = input.replace(/^\uFEFF/, "");
  const records: { fields: string[]; line: number }[] = [];
  let fields: string[] = [], field = "", quoted = false, afterQuote = false, line = 1, recordLine = 1;
  const pushRecord = () => {
    fields.push(field);
    if (fields.some(value => value.trim())) records.push({ fields, line: recordLine });
    fields = []; field = ""; afterQuote = false;
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; afterQuote = true; } }
      else if (char === "\r" || char === "\n") { if (char === "\r" && text[i + 1] === "\n") i++; field += "\n"; line++; }
      else field += char;
      continue;
    }
    if (char === delimiter) { fields.push(field); field = ""; afterQuote = false; if (fields.length > 3) return failure(`Demasiadas columnas en la fila ${recordLine}.`); }
    else if (char === "\r" || char === "\n") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      pushRecord(); line++; recordLine = line;
      if (records.length > PRODUCT_CSV_MAX_ROWS + 1) return failure("El archivo puede contener como máximo 100 productos.");
    } else if (afterQuote) { if (char !== " " && char !== "\t") return failure(`Texto después de una comilla de cierre en la fila ${line}.`); }
    else if (char === '"') { if (field !== "") return failure(`Comillas inválidas en la fila ${line}.`); quoted = true; }
    else field += char;
  }
  if (quoted) return failure(`Falta cerrar una comilla en la fila ${recordLine}.`);
  if (field || fields.length || afterQuote) pushRecord();
  if (!records.length) return failure("El archivo está vacío. Usa la plantilla con nombre y precio.");
  if (records.length > PRODUCT_CSV_MAX_ROWS + 1) return failure("El archivo puede contener como máximo 100 productos.");
  const headers = records[0].fields.map(value => value.trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase());
  if (!headers.includes("nombre") || !headers.includes("precio") || headers.some(header => !["nombre", "precio", "codigo"].includes(header)) || new Set(headers).size !== headers.length) return failure("Usa las columnas nombre,precio,codigo. La columna codigo es opcional; no se admiten columnas repetidas o desconocidas.");
  if (records.length === 1) return failure("El archivo no contiene productos.");
  const rows = records.slice(1).map(record => {
    const reasons: string[] = [];
    if (record.fields.length !== headers.length) reasons.push("La cantidad de columnas no coincide con el encabezado.");
    const get = (name: string) => record.fields[headers.indexOf(name)] || "";
    const name = get("nombre").trim().replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ");
    const barcode = get("codigo").trim() || null;
    const priceCents = csvPriceInCents(get("precio"));
    if (!name || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) reasons.push("El nombre debe tener entre 1 y 100 caracteres válidos.");
    if (priceCents === null) reasons.push("Precio en pesos mayor a 0 y hasta 1,000,000, con máximo 2 decimales; no uses separadores de miles.");
    if (barcode && (barcode.length > 64 || /[\u0000-\u001f\u007f]/.test(barcode))) reasons.push("El código debe tener hasta 64 caracteres, sin saltos de línea.");
    return { rowNumber: record.line, name, priceCents, barcode, error: reasons.join(" ") || null };
  });
  const byCode = new Map<string, ProductCsvRow[]>();
  for (const row of rows) if (row.barcode) byCode.set(row.barcode, [...(byCode.get(row.barcode) || []), row]);
  for (const duplicates of byCode.values()) if (duplicates.length > 1) for (const row of duplicates) row.error = `${row.error ? row.error + " " : ""}Código repetido dentro del CSV.`;
  return { rows, errors: [], delimiter };
}

export function previewProductCsv(rows: ProductCsvRow[], existing: ExistingCsvProduct[]): ProductCsvPreview[] {
  const codes = new Set(existing.map(product => product.barcode).filter((code): code is string => Boolean(code)));
  const namesAndPrices = new Set(existing.map(product => `${normalizeName(product.name)}\u0000${product.price_cents}`));
  return rows.map(row => {
    if (row.error) return { ...row, status: "error", reason: row.error };
    const signature = `${normalizeName(row.name)}\u0000${row.priceCents}`;
    if (row.barcode && codes.has(row.barcode)) return { ...row, status: "skipped", reason: "Código ya registrado; no se sobrescribe." };
    if (!row.barcode && namesAndPrices.has(signature)) return { ...row, status: "skipped", reason: "Nombre y precio ya registrados; se omite para evitar duplicados." };
    if (row.barcode) codes.add(row.barcode);
    namesAndPrices.add(signature);
    return { ...row, status: "ready", reason: "Listo para importar." };
  });
}
