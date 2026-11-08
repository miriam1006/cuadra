"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { PRODUCT_CSV_MAX_BYTES, PRODUCT_CSV_TEMPLATE, parseProductCsv, previewProductCsv, type ExistingCsvProduct, type ProductCsvRow, type ProductCsvPreview } from "@/lib/product-csv";

type Status = ProductCsvPreview["status"] | "importing" | "imported" | "uncertain" | "stopped";
type Row = Omit<ProductCsvPreview, "status"> & { status: Status };
type Props = { disabled: boolean; tryAcquireLock: () => boolean; releaseLock: () => void; onChanged: () => Promise<void> };
type Ledger = { fileName: string; imported: number; skipped: number; uncertain: number; failed: number; updatedAt: string };
const STORAGE_KEY = "cuadra.product-csv.progress.v1";
const labels: Record<Status, string> = { ready: "Por importar", skipped: "Omitido", error: "Error", importing: "Importando", imported: "Importado", uncertain: "Revisar catálogo", stopped: "Sin intentar" };
const money = (cents: number) => new Intl.NumberFormat("es-MX", {style: "currency", currency: "MXN"}).format(cents / 100);

class ImportError extends Error { constructor(message: string, public ambiguous = false) { super(message); } }

export default function ProductCsvImport({ disabled, tryAcquireLock, releaseLock, onChanged }: Props) {
  const [fileName, setFileName] = useState("");
  const [sourceRows, setSourceRows] = useState<ProductCsvRow[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [reading, setReading] = useState(false);
  const [running, setRunning] = useState(false);
  const [requiresPreview, setRequiresPreview] = useState(false);
  const [lastRun, setLastRun] = useState<Ledger | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const mounted = useRef(false);
  const active = useRef(false);
  const stop = useRef(false);
  const generation = useRef(0);
  const request = useRef<AbortController | null>(null);
  const progress = useRef<Row[]>([]);
  const selectedName = useRef("");
  const callbacks = useRef({ tryAcquireLock, releaseLock, onChanged });
  useEffect(() => { callbacks.current = {tryAcquireLock, releaseLock, onChanged}; }, [tryAcquireLock, releaseLock, onChanged]);

  function persist(next: Row[]) {
    const counts = {fileName: selectedName.current, updatedAt: new Date().toISOString(), imported: next.filter(row => row.status === "imported").length, skipped: next.filter(row => row.status === "skipped").length, uncertain: next.filter(row => row.status === "uncertain" || row.status === "importing").length, failed: next.filter(row => row.status === "error").length};
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify({...counts, rows: next.map(row => ({rowNumber: row.rowNumber, status: row.status === "importing" ? "uncertain" : row.status}))})); } catch { /* The visible progress remains usable if storage is unavailable. */ }
  }
  function publish(next: Row[]) { progress.current = next; persist(next); if (mounted.current) setRows(next); }
  function mark(rowNumber: number, status: Status, reason: string) { publish(progress.current.map(row => row.rowNumber === rowNumber ? {...row, status, reason} : row)); }

  useEffect(() => {
    mounted.current = true;
    try { const raw = sessionStorage.getItem(STORAGE_KEY); const saved = raw && JSON.parse(raw); if (saved && typeof saved.fileName === "string" && [saved.imported,saved.skipped,saved.uncertain,saved.failed].every(Number.isSafeInteger)) setLastRun(saved as Ledger); } catch { /* No stored progress. */ }
    const beforeUnload = (event: BeforeUnloadEvent) => { if (active.current) { event.preventDefault(); event.returnValue = ""; } };
    const navigation = (event: MouseEvent) => {
      if (!active.current || !(event.target instanceof Element) || container.current?.contains(event.target)) return;
      if (!event.target.closest("a,button,[role=tab]")) return;
      event.preventDefault(); event.stopPropagation(); stop.current = true;
      if (mounted.current) setMessage("Esperando a que termine el producto en curso antes de salir. Después podrás cambiar de sección.");
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", navigation, true);
    return () => {
      mounted.current = false; stop.current = true; generation.current++;
      request.current?.abort();
      if (active.current) persist(progress.current);
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", navigation, true);
    };
  }, []);

  async function api(path: string, options?: RequestInit) {
    const controller = new AbortController(); request.current = controller;
    const timer = setTimeout(() => controller.abort(), 15000);
    const mutation = options?.method === "POST";
    try {
      const response = await fetch(path, {...options, cache: "no-store", signal: controller.signal, headers: {"Content-Type": "application/json"}});
      let data;
      try { data = await response.json(); } catch { throw new ImportError("La respuesta no pudo verificarse. Actualiza y revisa el catálogo antes de continuar.", mutation); }
      if (!response.ok) throw new ImportError(data.error || "No pudimos completar la operación. Revisa el catálogo.", mutation && response.status >= 500);
      return data;
    } catch (error) {
      if (error instanceof ImportError) throw error;
      throw new ImportError(controller.signal.aborted ? "La petición se interrumpió o tardó demasiado. El producto podría haberse guardado; actualiza y revisa el catálogo." : "Se perdió la conexión. Actualiza y revisa el catálogo antes de continuar.", mutation);
    } finally { clearTimeout(timer); if (request.current === controller) request.current = null; }
  }
  async function freshCatalog(): Promise<ExistingCsvProduct[]> {
    const data = await api("/api/products?include_inactive=true");
    if (data.truncated === true) throw new ImportError("El catálogo está limitado. La importación se bloqueó porque no podemos comprobar todos los códigos existentes.");
    if (!Array.isArray(data.products) || data.products.some((product: ExistingCsvProduct) => typeof product?.name !== "string" || !Number.isSafeInteger(product.price_cents) || (product.barcode !== null && typeof product.barcode !== "string"))) throw new ImportError("No pudimos verificar el catálogo completo. Actualiza antes de importar.");
    return data.products;
  }
  async function makePreview(parsed: ProductCsvRow[], token: number) {
    setReading(true); setErrors([]); setMessage("");
    try {
      const existing = await freshCatalog();
      if (!mounted.current || token !== generation.current) return;
      const planned = previewProductCsv(parsed, existing); publish(planned);
      if (existing.length + planned.filter(row => row.status === "ready").length > 1000) throw new ImportError("Esta carga superaría el límite de 1,000 productos del catálogo en esta versión. Reduce el archivo antes de importar.");
      setRequiresPreview(false);
      setMessage("Vista previa lista. No se ha guardado ningún producto.");
    } catch (e) { if (mounted.current && token === generation.current) { setErrors([(e as Error).message]); setRequiresPreview(true); } }
    finally { if (mounted.current && token === generation.current) setReading(false); }
  }
  async function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    if (active.current) return;
    const file = event.target.files?.[0]; if (!file) return;
    const token = ++generation.current; request.current?.abort();
    setFileName(file.name); selectedName.current = file.name; setLastRun(null); setRows([]); progress.current = []; setSourceRows([]); setErrors([]); setMessage(""); setRequiresPreview(true); setReading(true);
    if (file.size > PRODUCT_CSV_MAX_BYTES) { setErrors(["El archivo supera 256 KB."]); setReading(false); return; }
    try {
      const text = await file.text();
      if (!mounted.current || token !== generation.current) return;
      const parsed = parseProductCsv(text); setSourceRows(parsed.rows);
      if (parsed.errors.length) { setErrors(parsed.errors); setReading(false); return; }
      await makePreview(parsed.rows, token);
    } catch { if (mounted.current && token === generation.current) { setErrors(["No pudimos leer el archivo. Vuelve a seleccionarlo."]); setReading(false); } }
  }
  async function importProducts() {
    if (active.current || disabled || reading || requiresPreview || errors.length || rows.some(row => row.status === "error") || !rows.some(row => row.status === "ready")) return;
    if (!callbacks.current.tryAcquireLock()) { setMessage("Espera a que termine la edición de productos antes de importar."); return; }
    active.current = true; stop.current = false; setRunning(true); setMessage("Comprobando el catálogo antes de importar…"); setRequiresPreview(true);
    const token = ++generation.current;
    let changed = false;
    try {
      const existing = await freshCatalog();
      if (!mounted.current || token !== generation.current) return;
      const planned = previewProductCsv(sourceRows, existing); publish(planned);
      if (existing.length + planned.filter(row => row.status === "ready").length > 1000) throw new ImportError("Esta carga superaría el límite de 1,000 productos del catálogo en esta versión. No se ha importado ninguna fila.");
      if (progress.current.some(row => row.status === "error")) throw new ImportError("Corrige los errores del archivo antes de importar.");
      for (const row of [...progress.current]) {
        if (row.status !== "ready") continue;
        if (stop.current || !mounted.current || token !== generation.current) break;
        mark(row.rowNumber, "importing", "Esperando respuesta del servidor. No cierres esta sección.");
        try {
          const data = await api("/api/products", {method: "POST", body: JSON.stringify({name: row.name, price_cents: row.priceCents, barcode: row.barcode, active: true})});
          if (!data.product?.id || data.product.name !== row.name || data.product.price_cents !== row.priceCents || (data.product.barcode || null) !== row.barcode) throw new ImportError("La respuesta del producto no coincide. Revisa el catálogo antes de volver a intentarlo.", true);
          mark(row.rowNumber, "imported", "Guardado en el catálogo."); changed = true;
        } catch (error) {
          const ambiguous = !(error instanceof ImportError) || error.ambiguous;
          mark(row.rowNumber, ambiguous ? "uncertain" : "error", (error as Error).message);
          stop.current = true;
          if (mounted.current) setMessage("Importación detenida. No reintentaremos este producto automáticamente. Actualiza y revisa el catálogo antes de preparar otra vista previa.");
          break;
        }
      }
      publish(progress.current.map(row => row.status === "ready" ? {...row, status: "stopped", reason: "No se intentó importar. Prepara otra vista previa para continuar."} : row));
      if (mounted.current && !stop.current) setMessage("Carga terminada. Los productos existentes se omitieron; no se sobrescribió ningún registro.");
      else if (mounted.current && !progress.current.some(row => ["error","uncertain"].includes(row.status))) setMessage("Carga detenida después de la petición en curso. Los productos ya importados se conservan.");
    } catch (e) { if (mounted.current) { setErrors([(e as Error).message]); setMessage("No se iniciarán más escrituras. Actualiza y revisa el catálogo."); } }
    finally {
      // Keep the parent lock until the pending request and its refresh have settled.
      try { if (mounted.current && (changed || progress.current.some(row => row.status === "uncertain"))) await callbacks.current.onChanged(); }
      catch { if (mounted.current) setMessage("El progreso se conservó, pero falta actualizar el catálogo. Revísalo antes de volver a importar."); }
      finally { active.current = false; callbacks.current.releaseLock(); if (mounted.current) setRunning(false); }
    }
  }
  function template() {
    const url = URL.createObjectURL(new Blob([PRODUCT_CSV_TEMPLATE], {type: "text/csv;charset=utf-8"}));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = "cuadra-productos.csv"; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const counts = {ready: rows.filter(row => row.status === "ready").length, imported: rows.filter(row => row.status === "imported").length, skipped: rows.filter(row => row.status === "skipped").length, errors: rows.filter(row => ["error","uncertain"].includes(row.status)).length};
  return <div ref={container} className="csv-import csv-import-polished"><details className="csv-disclosure">
    <summary className="csv-disclosure-summary" onClick={event => { if (running) event.preventDefault(); }}><span className="csv-disclosure-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5" /></svg></span><span className="csv-disclosure-title"><strong>Importar CSV</strong><span>{running ? "Importación en curso" : "Carga varios productos desde tu hoja de cálculo"}</span></span><span className="csv-disclosure-chevron" aria-hidden="true">⌄</span></summary>
    <div className="csv-import-body">
      <div className="csv-upload-area"><div className="csv-upload-file"><span className="csv-file-badge" aria-hidden="true">CSV</span><div><strong id="csv-selected-file">{fileName || "Selecciona tu archivo"}</strong><span>{fileName ? "Revisa la vista previa antes de importar" : "Hasta 100 productos · máximo 256 KB"}</span></div></div><button type="button" className="secondary csv-choose-file" disabled={disabled || running || reading} aria-describedby="csv-selected-file" onClick={() => input.current?.click()}>{fileName ? "Cambiar archivo" : "Elegir archivo CSV"}</button></div>
      <input ref={input} id="csv-products-file" type="file" accept=".csv,text/csv" hidden aria-label="Elegir archivo CSV de productos" disabled={disabled || running || reading} onChange={chooseFile} />
      <div className="csv-utility-row"><button type="button" className="csv-template-button" disabled={running} onClick={template}><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4" /></svg>Descargar plantilla</button><span>Elegir un archivo no guarda productos.</span></div>
      <details className="csv-format"><summary>Formato del archivo</summary><div><p>Columnas <strong>nombre</strong>, <strong>precio</strong> y <strong>codigo</strong> (opcional). Admite coma o punto y coma.</p><pre aria-label="Ejemplo de archivo CSV">{"nombre,precio,codigo\nAgua natural,15.00,00123\nPan dulce,12.50,"}</pre><ul><li>Precio en pesos, mayor a cero y con hasta dos decimales. Sin separadores de miles.</li><li>Guarda los códigos como texto en tu hoja para conservar los ceros iniciales.</li><li>Hasta 100 productos y 256 KB. Los existentes se omiten, nunca se sobrescriben.</li></ul></div></details>
      {reading && <p className="csv-loading-status" role="status">Preparando vista previa con el catálogo actual…</p>}
      {errors.map((error, index) => <p className="error" role="alert" key={index}>{error}</p>)}
      {!!rows.length && <><div className="csv-preview-heading"><h4>Vista previa</h4><span>{rows.length} filas</span></div><div className="csv-counter-chips" aria-label="Resumen de la carga" aria-live="polite"><span><strong>{counts.ready}</strong> por importar</span>{counts.imported > 0 && <span className="csv-chip-imported"><strong>{counts.imported}</strong> importados</span>}{counts.skipped > 0 && <span><strong>{counts.skipped}</strong> omitidos</span>}{counts.errors > 0 && <span className="csv-chip-error"><strong>{counts.errors}</strong> por corregir o revisar</span>}</div><div className="csv-preview csv-preview-compact" role="region" tabIndex={0} aria-label="Filas del archivo CSV; desplázate para revisar todos los productos">{rows.map(row => <div key={row.rowNumber} className={`csv-row csv-${row.status}`}><div className="csv-row-heading"><strong><span className="csv-row-number">{row.rowNumber}</span>{row.name || "Sin nombre"}</strong><span>{labels[row.status]}</span></div><p>{row.priceCents === null ? "Precio inválido" : money(row.priceCents)} · {row.barcode ? `Código: ${row.barcode}` : "Sin código"}</p>{!["ready", "imported"].includes(row.status) && <p className="csv-row-reason">{row.reason}</p>}</div>)}</div></>}
      {counts.errors > 0 && !running && <p className="csv-correction-note">{rows.some(row => row.error) ? "Corrige las filas señaladas en tu CSV y vuelve a elegir el archivo." : "Revisa los productos señalados en el catálogo y actualiza la vista previa antes de continuar."}</p>}
      {!!rows.length && rows.every(row => row.status === "skipped") && !reading && <p className="csv-complete-note">Todos estos productos ya existen. No hay filas nuevas para importar.</p>}
      {message && <p className="csv-message" role="status" aria-live="polite">{message}</p>}
      {(running || sourceRows.length > 0) && <div className="csv-actions">{!running && <>{counts.ready > 0 && !counts.errors && !errors.length && <button type="button" className="primary" disabled={disabled || reading || requiresPreview || !!errors.length || !!counts.errors || !counts.ready} onClick={importProducts}>Importar {counts.ready} {counts.ready === 1 ? "producto" : "productos"}</button>}{!!sourceRows.length && <button type="button" className="secondary" disabled={disabled || reading} onClick={() => { const token = ++generation.current; request.current?.abort(); void makePreview(sourceRows, token); }}>Actualizar vista previa</button>}</>}{running && <button type="button" className="secondary" onClick={() => { stop.current = true; setMessage("Esperando a que termine el producto en curso. No se importarán más filas."); }}>Detener después del producto actual</button>}</div>}
      {lastRun && <details className="csv-previous-run"><summary>Última carga en esta pestaña</summary><p>{lastRun.fileName} · {lastRun.imported} importados, {lastRun.skipped} omitidos, {lastRun.uncertain} por revisar y {lastRun.failed} con error. No se reanuda automáticamente.</p></details>}
    </div>
  </details>
  </div>;
}
