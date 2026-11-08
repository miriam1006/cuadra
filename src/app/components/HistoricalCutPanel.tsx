"use client";

import { useEffect, useRef, useState } from "react";
import { corteShareText, isValidCorteDate, parseCorteSummary, previousCorteDate, type CorteSummary } from "@/lib/corte-date";

type View = { date: string; status: "loading" | "ready" | "error"; summary: CorteSummary | null; error: string };
type Props = { merchantName: string; role: "admin" | "cashier"; today: string; online: boolean; todayRevision: string };
const money = (cents: number) => new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(cents / 100);
const dateLabel = (date: string) => new Intl.DateTimeFormat("es-MX", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));

export default function HistoricalCutPanel({ merchantName, role, today, online, todayRevision }: Props) {
  const [chosenDate, setChosenDate] = useState(today);
  const [followToday, setFollowToday] = useState(true);
  const [reload, setReload] = useState(0);
  const selectedDate = followToday ? today : chosenDate;
  const [view, setView] = useState<View>({ date: today, status: "loading", summary: null, error: "" });
  const sequence = useRef(0);
  const request = useRef<AbortController | null>(null);
  const liveRevision = selectedDate === today ? todayRevision : "";

  useEffect(() => {
    const current = ++sequence.current;
    const controller = new AbortController();
    request.current = controller;
    let disposed = false;
    let timedOut = false;
    setView({ date: selectedDate, status: "loading", summary: null, error: "" });
    if (!isValidCorteDate(selectedDate, today) || !online) {
      setView({ date: selectedDate, status: "error", summary: null, error: online ? "Elige una fecha válida, hasta hoy en Ciudad de México." : "Sin conexión. No pudimos consultar el corte de esta fecha." });
      return () => { disposed = true; controller.abort(); };
    }
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 15000);
    void (async () => {
      try {
        const response = await fetch(`/api/corte?date=${encodeURIComponent(selectedDate)}`, { signal: controller.signal, cache: "no-store", headers: { Accept: "application/json" } });
        if (disposed || current !== sequence.current) return;
        if (response.status === 401) { window.location.assign("/login"); throw new Error("Inicia sesión para consultar el corte."); }
        const data: unknown = await response.json();
        if (disposed || current !== sequence.current) return;
        if (!response.ok) throw new Error(data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error : "No se pudo consultar el corte.");
        const summary = parseCorteSummary(data, selectedDate);
        if (!summary) throw new Error("El corte recibido no corresponde a esta fecha o contiene un total inválido. Vuelve a consultar.");
        setView({ date: selectedDate, status: "ready", summary, error: "" });
      } catch (error) {
        if (disposed || current !== sequence.current) return;
        setView({ date: selectedDate, status: "error", summary: null, error: timedOut ? "La consulta tardó demasiado. Vuelve a intentar." : (error as Error).message });
      } finally {
        clearTimeout(timeout);
        if (request.current === controller) request.current = null;
      }
    })();
    return () => { disposed = true; clearTimeout(timeout); controller.abort(); };
  }, [selectedDate, today, online, reload, liveRevision, merchantName, role]);

  function choose(date: string, followsToday: boolean) {
    // Invalidate synchronously, even before React runs the next effect cleanup.
    sequence.current += 1;
    request.current?.abort();
    setView({ date, status: "loading", summary: null, error: "" });
    setChosenDate(date); setFollowToday(followsToday); setReload(value => value + 1);
  }
  const currentView = view.date === selectedDate ? view : null;
  const summary = currentView?.status === "ready" ? currentView.summary : null;
  const loading = !currentView || currentView.status === "loading";
  const valid = isValidCorteDate(selectedDate, today);
  const yesterday = previousCorteDate(today);

  return <section className="cut-card historical-cut" aria-labelledby="historical-cut-title">
    <span className="eyebrow">{merchantName} · {valid ? dateLabel(selectedDate) : "Elige una fecha"}</span>
    <h2 id="historical-cut-title">{role === "admin" ? "Corte del negocio" : "Mi corte"}</h2>
    <div className="cut-date-controls">
      <div className="cut-date-field"><label htmlFor="cut-date">Fecha del corte</label><input id="cut-date" type="date" min="0001-01-01" max={today} value={selectedDate} onChange={event => choose(event.target.value, event.target.value === today)} /></div>
      <div className="cut-date-shortcuts"><button className="secondary" type="button" aria-pressed={selectedDate === today} onClick={() => choose(today, true)}>Hoy</button><button className="secondary" type="button" disabled={!yesterday} aria-pressed={selectedDate === yesterday} onClick={() => { if (yesterday) choose(yesterday, false); }}>Ayer</button></div>
    </div>
    <button className="text-button" type="button" onClick={() => choose(selectedDate, followToday)} disabled={loading || !online || !valid}>{loading ? "Consultando…" : "Actualizar corte"}</button>
    <div aria-live="polite" aria-busy={loading}>
      {currentView?.status === "error" ? <p className="error" role="alert">{currentView.error}</p> : null}
      <span className="total-label">TOTAL RECIBIDO</span><div className="cut-total">{summary ? money(summary.total_paid_cents) : loading ? "Consultando…" : "No disponible"}</div>
      <p>{summary ? `${summary.paid_count} ${summary.paid_count === 1 ? "pago confirmado" : "pagos confirmados"}` : loading ? "Consultando el resumen de esta fecha…" : "Vuelve a consultar para ver y compartir este corte."}</p>
      <div className="cut-details"><div><span>Cobros pendientes</span><strong>{summary?.pending_count ?? "—"}</strong></div><div><span>Necesitan revisión</span><strong>{summary?.review_receipt_count ?? "—"}</strong></div><div><span>Monto por revisar</span><strong>{summary ? money(summary.review_amount_cents) : "—"}</strong></div><div><span>Zona horaria</span><strong>Ciudad de México</strong></div></div>
    </div>
    <button className="primary" type="button" disabled={!summary || loading} onClick={() => { if (!summary || summary.date !== selectedDate) return; window.open(`https://wa.me/?text=${encodeURIComponent(corteShareText(summary, merchantName, role))}`, "_blank", "noopener,noreferrer"); }}>Compartir corte por WhatsApp <span aria-hidden="true">↗</span></button>
    <p className="fine-print">Resumen actual de los pagos recibidos en la fecha elegida, según la hora de Ciudad de México. Puede cambiar si se registran o revisan pagos después; no es un cierre guardado.</p>
  </section>;
}
