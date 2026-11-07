"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import QRCode from "qrcode";

type Charge = { id: string; amount_cents: number; concept: string; status: string; expires_at: string | null; created_at: string; paid_at: string | null; transaction_id: string | null; qr_string?: string | null; late_payment?: boolean };
type Merchant = { id: string; name: string; max_amount_cents: number };
type Corte = { total_paid_cents: number; paid_count: number; review_receipt_count: number; review_amount_cents: number; pending_count: number; date: string };
const money = (cents: number) => new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(cents / 100);
const localDate = (value = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City", year: "numeric", month: "2-digit", day: "2-digit" }).format(value);
const hour = (value: string) => new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
const labels: Record<string, string> = { creating: "Generando", pending: "Pendiente", paid: "Pagado", expired: "Vencido", cancelled: "Cancelado", review: "Revisar", failed: "No generado" };
async function api(path: string, options?: RequestInit) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options?.method === "POST" ? 35000 : 15000);
  try {
    const response = await fetch(path, { ...options, signal: options?.signal || controller.signal, headers: { "Content-Type": "application/json", ...options?.headers }, cache: "no-store" });
    if (response.status === 401) { window.location.assign("/login"); throw new Error("Inicia sesión para abrir tu caja."); }
    const data = await response.json();
    if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "No pudimos completar la operación. Intenta de nuevo.");
    return data;
  } catch (e) {
    if (controller.signal.aborted) throw new Error("La consulta tardó demasiado. Revisa tu conexión y vuelve a intentar.");
    throw e;
  } finally { clearTimeout(timeout); }
}
function Icon({ name }: { name: string }) {
  const paths: Record<string, ReactNode> = {
    box: <><path d="M4 8h16v12H4zM3 4h18v4H3zM9 12h6" /></>,
    charge: <><rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" /><rect x="4" y="14" width="6" height="6" rx="1" /><path d="M14 14h3v3h3v3h-6z" /></>,
    history: <><path d="M4 7h16M4 12h16M4 17h10" /><path d="M18 15v5m-2-2h4" /></>,
    chart: <><path d="M4 20h16M6 16v-5m6 5V5m6 11V8" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    sound: <><path d="m4 9 5 0 4-4v14l-4-4H4zM17 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" /></>,
    arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
    back: <><path d="m9 6-6 6 6 6h11V6zM12 10l4 4m0-4-4 4" /></>,
  };
  return <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.box}</svg>;
}

export default function Home() {
  const [merchant, setMerchant] = useState<Merchant | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessionFailed, setSessionFailed] = useState(false);
  const [uncertainCreation, setUncertainCreation] = useState(false);
  const [opened, setOpened] = useState(false);
  const [name, setName] = useState("");
  const [tab, setTab] = useState("charge");
  const [digits, setDigits] = useState("0");
  const [concept, setConcept] = useState("");
  const [charge, setCharge] = useState<Charge | null>(null);
  const [charges, setCharges] = useState<Charge[]>([]);
  const [historyTruncated, setHistoryTruncated] = useState(false);
  const [corte, setCorte] = useState<Corte | null>(null);
  const [corteLoading, setCorteLoading] = useState(true);
  const [corteError, setCorteError] = useState("");
  const [reconciling, setReconciling] = useState(false);
  const [reconciliationMessage, setReconciliationMessage] = useState<{chargeId: string; text: string} | null>(null);
  const [qr, setQr] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [online, setOnline] = useState(true);
  const [now, setNow] = useState(Date.now());
  const [filter, setFilter] = useState("");
  const [audioEnabled, setAudioEnabled] = useState(false);
  const spoken = useRef(new Set<string>());
  const attempt = useRef<{ fingerprint: string; key: string } | null>(null);
  const refreshInFlight = useRef<Promise<void> | null>(null);
  const reconciliationInFlight = useRef(false);
  const selectedCharge = useRef<Charge | null>(null);
  const previousOnline = useRef(true);
  const lastReconnectCheck = useRef(0);
  const audio = useRef<AudioContext | null>(null);
  const lock = useRef<{ release: () => Promise<void> } | null>(null);
  const refresh = useCallback(() => {
    if (refreshInFlight.current) return refreshInFlight.current;
    const date = localDate();
    setCorteLoading(true); setCorteError("");
    const pending = Promise.all([
      api(`/api/charges?date=${date}`).then(data => { setCharges(data.charges || []); setHistoryTruncated(data.truncated === true); }).catch(e => { setError((e as Error).message); }),
      api(`/api/corte?date=${date}`).then(data => {
        if (!Number.isSafeInteger(data.total_paid_cents) || !Number.isSafeInteger(data.paid_count)) throw new Error("El corte no devolvió un total válido. Vuelve a intentar.");
        setCorte(data as Corte);
      }).catch(e => { setCorte(null); setCorteError((e as Error).message); }).finally(() => setCorteLoading(false)),
    ]).then(() => {}).finally(() => { refreshInFlight.current = null; });
    refreshInFlight.current = pending;
    return pending;
  }, []);
  const loadSession = useCallback(async () => {
    setLoading(true); setSessionFailed(false); setError("");
    try { const data = await api("/api/session"); setMerchant(data.merchant); }
    catch (e) { setSessionFailed(true); setError((e as Error).message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => {
    void loadSession();
    const connected = () => setOnline(navigator.onLine);
    connected(); window.addEventListener("online", connected); window.addEventListener("offline", connected);
    return () => { window.removeEventListener("online", connected); window.removeEventListener("offline", connected); void lock.current?.release(); };
  }, [loadSession]);
  useEffect(() => { if (merchant && opened) void refresh(); }, [merchant, opened, tab, refresh]);
  useEffect(() => {
    if (!opened) return;
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      void refresh();
      if ("wakeLock" in navigator) {
        void (async () => { try { await lock.current?.release(); lock.current = await (navigator as unknown as { wakeLock: { request: (type: string) => Promise<{ release: () => Promise<void> }> } }).wakeLock.request("screen"); } catch { /* Device may decline wake lock. */ } })();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [opened, refresh]);
  const announce = useCallback((item: Charge) => {
    if (!audioEnabled) return;
    try {
      const context = audio.current;
      if (context) { void context.resume(); const oscillator = context.createOscillator(); const gain = context.createGain(); oscillator.connect(gain); gain.connect(context.destination); oscillator.frequency.value = 880; gain.gain.setValueAtTime(0.12, context.currentTime); gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.35); oscillator.start(); oscillator.stop(context.currentTime + 0.35); }
      if ("speechSynthesis" in window) { const speech = new SpeechSynthesisUtterance(`Pago recibido. ${item.amount_cents / 100} pesos.`); speech.lang = "es-MX"; const voices = speechSynthesis.getVoices(); speech.voice = voices.find(v => v.lang === "es-MX") || voices.find(v => v.lang.startsWith("es")) || null; speechSynthesis.speak(speech); }
      navigator.vibrate?.([200, 100, 200]);
    } catch { /* Visual confirmation remains available if browser audio is unavailable. */ }
  }, [audioEnabled]);
  useEffect(() => { selectedCharge.current = charge; }, [charge]);
  const reconcile = useCallback(async (chargeId: string, automatic = false) => {
    if (reconciliationInFlight.current) return;
    reconciliationInFlight.current = true; setReconciling(true);
    if (!automatic) setError("");
    setReconciliationMessage({chargeId, text: "Consultando el pago con Pey…"});
    try {
      const data = await api(`/api/charges/${chargeId}/reconcile`, { method: "POST", body: "{}" });
      const next = data.charge as Charge;
      if (!next || next.id !== chargeId) throw new Error("No pudimos identificar el cobro verificado. Vuelve a consultar su estado.");
      setCharge(current => current?.id === chargeId ? { ...current, ...next } : current);
      setCharges(current => current.map(item => item.id === chargeId ? { ...item, ...next } : item));
      const text = data.reconciliation?.outcome === "no_payment"
        ? "Pey todavía no reporta un pago confirmado para este cobro. No se ha marcado como pagado."
        : next.status === "paid" ? "Pago confirmado al consultar directamente con Pey."
        : next.status === "review" ? "Pey reportó una operación que necesita revisión. Revisa el cobro antes de entregar tu producto."
        : "Verificación terminada. Este cobro sigue sin un pago confirmado.";
      setReconciliationMessage({chargeId, text});
      if (next.status === "paid" && selectedCharge.current?.id === chargeId && !spoken.current.has(chargeId)) {
        spoken.current.add(chargeId); announce(next);
      }
      // A refresh that began before reconciliation may contain the old total.
      await refreshInFlight.current;
      await refresh();
    } catch (e) { setReconciliationMessage({chargeId, text: (e as Error).message}); }
    finally { reconciliationInFlight.current = false; setReconciling(false); }
  }, [announce, refresh]);
  useEffect(() => {
    const reconnected = online && !previousOnline.current;
    previousOnline.current = online;
    if (!reconnected || !opened || Date.now() - lastReconnectCheck.current < 60000) return;
    void refresh();
    const current = selectedCharge.current;
    if (current?.qr_string && ["pending", "expired", "cancelled", "failed"].includes(current.status)) {
      lastReconnectCheck.current = Date.now();
      void reconcile(current.id, true);
    }
  }, [online, opened, reconcile, refresh]);
  useEffect(() => {
    if (!charge || !["pending", "creating", "expired", "cancelled"].includes(charge.status) || !online) return;
    let cancelled = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const data = await api(`/api/charges/${charge.id}`);
        if (cancelled) return;
        const next = data.charge as Charge;
        setCharge(previous => {
          if (!previous || previous.id !== next.id) return previous;
          // A poll started before reconciliation must not undo a confirmed payment.
          if (previous.status === "paid" && !["paid", "review"].includes(next.status)) return previous;
          return { ...previous, ...next, qr_string: next.qr_string || previous.qr_string };
        });
        setError("");
        if (next.status === "paid") {
          setReconciliationMessage(current => current?.chargeId === next.id ? null : current);
          if (!spoken.current.has(next.id)) { spoken.current.add(next.id); announce(next); void refresh(); }
        }
        if (["pending", "creating", "expired", "cancelled"].includes(next.status)) timer = setTimeout(poll, ["expired", "cancelled"].includes(next.status) ? 10000 : 2000);
      } catch (e) { if (!cancelled) { setError((e as Error).message); timer = setTimeout(poll, 4000); } }
      finally { inFlight = false; }
    };
    const onVisible = () => { if (document.visibilityState === "visible") { clearTimeout(timer); void poll(); } };
    document.addEventListener("visibilitychange", onVisible);
    timer = setTimeout(poll, ["expired", "cancelled"].includes(charge.status) ? 10000 : 1000);
    return () => { cancelled = true; clearTimeout(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [charge?.id, charge?.status, online, announce, refresh]);
  useEffect(() => {
    setQr(""); let valid = true;
    if (charge?.qr_string) QRCode.toDataURL(charge.qr_string, { width: 600, margin: 2, errorCorrectionLevel: "M", color: { dark: "#122c25", light: "#ffffff" } }).then(value => { if (valid) setQr(value); }).catch(() => setError("No se pudo dibujar el QR. Vuelve a abrir el cobro desde el historial."));
    return () => { valid = false; };
  }, [charge?.qr_string]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  async function openBox() {
    try { if ("speechSynthesis" in window) { const unlock = new SpeechSynthesisUtterance(" "); unlock.lang = "es-MX"; unlock.volume = 0; speechSynthesis.speak(unlock); } } catch { /* Voice support varies by browser. */ }
    try { const Audio = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext; if (Audio) { audio.current ||= new Audio(); await audio.current.resume(); } setAudioEnabled(true); } catch { setAudioEnabled(false); }
    setOpened(true);
    try { if ("wakeLock" in navigator) lock.current = await (navigator as unknown as { wakeLock: { request: (type: string) => Promise<{ release: () => Promise<void> }> } }).wakeLock.request("screen"); } catch { /* Some devices do not support screen wake lock. */ }
  }
  async function setup() { if (!name.trim()) return; setBusy(true); setError(""); try { const data = await api("/api/merchant", { method: "POST", body: JSON.stringify({ name: name.trim() }) }); setMerchant(data.merchant); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  async function create() {
    const input = { amount_cents: Number(digits), concept: concept.trim() || "Venta en mostrador" };
    const fingerprint = JSON.stringify(input);
    if (uncertainCreation && attempt.current && attempt.current.fingerprint !== fingerprint) { setError("Primero revisa el cobro anterior en el historial. Para reintentarlo sin duplicarlo, usa el mismo monto y concepto."); return; }
    setBusy(true); setError("");
    if (!attempt.current || attempt.current.fingerprint !== fingerprint) attempt.current = { fingerprint, key: crypto.randomUUID() };
    try {
      const data = await api("/api/charges", { method: "POST", headers: { "idempotency-key": attempt.current.key }, body: fingerprint });
      setCharge(data.charge); setUncertainCreation(false);
      if (data.charge.status !== "creating") attempt.current = null;
      void refresh();
    } catch (e) { setUncertainCreation(true); setError((e as Error).message); void refresh(); }
    finally { setBusy(false); }
  }
  async function logout() { setBusy(true); try { await api("/api/auth/logout", { method: "POST", body: "{}" }); window.location.assign("/login"); } catch (e) { setError((e as Error).message); setBusy(false); } }
  async function cancel() { if (!charge) return; setBusy(true); setError(""); try { const data = await api(`/api/charges/${charge.id}/cancel`, { method: "POST" }); setCharge(data.charge); void refresh(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  function key(value: string) { if (value === "erase") setDigits(v => v.length > 1 ? v.slice(0, -1) : "0"); else setDigits(v => { const next = (v === "0" ? "" : v) + value; return next.length <= 9 ? next.replace(/^0+(?=\d)/, "") : v; }); }
  const totalLabel = corte ? money(corte.total_paid_cents) : corteLoading ? "Consultando…" : "No disponible";
  const paidCount = corte?.paid_count ?? "—";
  const pending = corte?.pending_count ?? "—";
  const remaining = charge?.expires_at ? Math.max(0, Math.ceil((new Date(charge.expires_at).getTime() - now) / 1000)) : null;
  const invalidAmount = Number(digits) <= 0 || Number(digits) > (merchant?.max_amount_cents || 800000);
  const today = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", day: "numeric", month: "long" }).format(new Date());

  if (loading) return <main className="entry"><div className="brand"><span className="brand-icon"><Icon name="box" /></span>Cuadra<span className="brand-dot">.</span></div><p>Preparando tu caja…</p></main>;
  if (sessionFailed) return <main className="entry"><div className="entry-card"><div className="brand"><span className="brand-icon"><Icon name="box" /></span>Cuadra<span className="brand-dot">.</span></div><h1>Falta conectar<br />tu caja.</h1><p>No pudimos cargar la sesión o la configuración del servidor. Revisa la conexión y las variables de Supabase antes de continuar.</p><p className="error" role="alert">{error}</p><button className="primary" onClick={loadSession}>Volver a intentar</button><a className="secondary" href="/login">Ir a iniciar sesión</a></div></main>;
  if (!merchant) return <main className="entry"><div className="entry-card"><div className="brand"><span className="brand-icon"><Icon name="box" /></span>Cuadra<span className="brand-dot">.</span></div><span className="eyebrow">TU NEGOCIO, LISTO PARA COBRAR</span><h1>Empecemos con<br />tu caja.</h1><p>Elige el nombre que verás al cobrar y al compartir tu corte.</p><label className="field-label" htmlFor="merchant-name">Nombre de tu negocio</label><input id="merchant-name" maxLength={100} value={name} onChange={e => setName(e.target.value)} placeholder="Ej. Abarrotes La Esquina" />{error && <p role="alert" className="error">{error}</p>}<button className="primary" onClick={setup} disabled={busy || !name.trim()}>{busy ? "Creando…" : "Crear mi caja"}<Icon name="arrow" /></button></div></main>;
  if (!opened) return <main className="entry"><div className="entry-card"><div className="brand"><span className="brand-icon"><Icon name="box" /></span>Cuadra<span className="brand-dot">.</span></div><div className="entry-art"><Icon name="sound" /><span className="sound-ring ring-one" /><span className="sound-ring ring-two" /></div><span className="eyebrow">HOLA, {merchant.name.toUpperCase()}</span><h1>Cobra con calma.<br />Escucha tu pago.</h1><p>Abre tu caja para activar los avisos de voz. Mantén esta pantalla abierta mientras cobras.</p><button className="primary" onClick={openBox}>Abrir caja<Icon name="arrow" /></button><p className="fine-print">Los pagos se confirman desde el servidor, después de verificar la confirmación de Pey.</p></div></main>;
  return <div className="app-shell">
    <aside className="sidebar"><a href="/" className="brand"><span className="brand-icon"><Icon name="box" /></span>Cuadra<span className="brand-dot">.</span></a><div className="merchant-card"><span className="avatar">{merchant.name.slice(0, 1).toUpperCase()}</span><div><strong>{merchant.name}</strong><span>Mi negocio</span></div></div><span className="nav-label">TU CAJA</span><nav aria-label="Navegación principal">{[["charge", "charge", "Cobrar"], ["history", "history", "Historial"], ["cut", "chart", "Corte del día"]].map(([id, icon, label]) => <button key={id} className={tab === id ? "nav-item active" : "nav-item"} onClick={() => { setTab(id); setError(""); }} aria-current={tab === id ? "page" : undefined}><Icon name={icon} />{label}{id === "charge" && <span className="nav-arrow">↗</span>}</button>)}</nav><div className="sidebar-bottom"><div className="voice-label"><Icon name="sound" />Voz {audioEnabled ? "activada" : "no disponible"}</div><p>Una confirmación que<br />sí puedes escuchar.</p><span className="powered">Cobros con Pey · CoDi</span></div></aside>
    <main className="workspace"><header className="topbar"><span>MI NEGOCIO <span className="breadcrumb">/ {tab === "charge" ? "Cobrar" : tab === "history" ? "Historial" : "Corte del día"}</span></span><div className="topbar-actions"><button className="logout-button" onClick={logout} disabled={busy}>Salir</button><span className={`connection ${online ? "" : "offline"}`}><i />{online ? "Con conexión" : "Sin conexión"}</span></div></header>
      <div className="content"><div className="page-heading"><div><span className="eyebrow">{tab === "charge" ? "TU MOSTRADOR DIGITAL" : "TODO EN ORDEN"}</span><h1>{tab === "charge" ? "Vamos a cobrar." : tab === "history" ? "Cada cobro, a la vista." : "Así va tu día."}</h1><p>{tab === "charge" ? "Escribe el monto. Muestra el QR. Escucha la confirmación." : tab === "history" ? "Consulta el estado real de tus cobros de hoy." : "Tu dinero recibido, contado sin complicaciones."}</p></div><div className="date-label"><span>HOY</span><strong>{today}</strong></div></div>
      {!online && <div className="offline-banner" role="alert">Sin conexión. No podemos generar cobros ni confirmar pagos. Al volver la señal consultaremos el estado.</div>}{error && <div className="error" role="alert">{error}</div>}{corteError && <div className="error" role="alert">No pudimos actualizar el corte: {corteError} <button className="text-button" disabled={corteLoading} onClick={refresh}>Reintentar corte</button></div>}
      {uncertainCreation && !charge && <div className="offline-banner" role="status"><strong>Falta confirmar si el cobro se creó.</strong><p>Revisa el historial antes de generar otro. Si reintentas con el mismo monto y concepto, usaremos la misma referencia para evitar duplicados.</p><button className="text-button" onClick={() => { setTab("history"); void refresh(); }}>Revisar historial</button><button className="text-button" onClick={() => { attempt.current = null; setUncertainCreation(false); setError(""); setDigits("0"); setConcept(""); }}>Empezar otro cobro</button></div>}{tab === "charge" ? <div className="charge-grid"><section className="register-card">
        {!charge ? <><div className="section-heading"><span className="step">1</span><h2>Nuevo cobro</h2><span className="small-tag">CoDi QR</span></div><div className="amount-area"><label htmlFor="amount">Monto a cobrar</label><div className="amount-line"><span>$</span><input id="amount" aria-label="Monto en pesos" inputMode="decimal" value={(Number(digits) / 100).toFixed(2)} onChange={e => { const value = e.target.value.replace(/[^0-9.]/g, ""); if (/^\d{0,7}(\.\d{0,2})?$/.test(value)) setDigits(String(Math.round(Number(value || 0) * 100))); }} /><span className="currency">MXN</span></div><span className="amount-help">Los últimos dos dígitos son centavos</span></div><div className="concept-field"><label htmlFor="concept">Concepto <span>opcional</span></label><input id="concept" value={concept} onChange={e => setConcept(e.target.value)} maxLength={100} placeholder="¿Qué estás cobrando?" /></div><div className="keypad" aria-label="Teclado de monto">{["1", "2", "3", "4", "5", "6", "7", "8", "9", "00", "0", "erase"].map(k => <button key={k} onClick={() => key(k)} aria-label={k === "erase" ? "Borrar último dígito" : k}>{k === "erase" ? <Icon name="back" /> : k}</button>)}</div><button className="primary generate" onClick={create} disabled={busy || !online || invalidAmount}><Icon name="charge" />{busy ? "Generando cobro…" : "Generar QR de cobro"}<Icon name="arrow" /></button>{Number(digits) > merchant.max_amount_cents && <p className="error">El máximo por cobro es {money(merchant.max_amount_cents)}.</p>}<p className="register-foot">El dinero llega a tu cuenta vinculada en Pey.</p></> : <div className={`charge-screen state-${charge.status}`}>
        {charge.status === "paid" ? <><div className="paid-check"><Icon name="check" /></div><span className="eyebrow">PAGO CONFIRMADO</span><h2 className="paid-title">¡Ya llegó!</h2><div className="result-amount">{money(charge.amount_cents)}</div><p>{charge.concept}</p><div className="receipt-meta"><span>{charge.paid_at && hour(charge.paid_at)}</span><span>Folio {charge.transaction_id?.slice(-6) || "—"}</span></div><p className="verified-note">Confirmado por el servidor</p>{charge.late_payment && <p className="review-note">Pago recibido después del vencimiento o cancelación. El dinero sí fue recibido y está incluido en tu corte.</p>}<button className="secondary" onClick={() => announce(charge)}><Icon name="sound" />Repetir aviso</button><button className="primary" onClick={() => { setCharge(null); attempt.current = null; setUncertainCreation(false); setDigits("0"); setConcept(""); }}>Nuevo cobro<Icon name="arrow" /></button></> : <><span className={`status-tag ${charge.status}`}>{labels[charge.status] || charge.status}</span><h2 className="qr-title">{charge.status === "pending" ? "Escanea y paga" : charge.status === "review" ? "Este pago necesita revisión" : "Detalle del cobro"}</h2><div className="result-amount">{money(charge.amount_cents)}</div><p>{charge.concept}</p>{charge.status === "creating" && <div className="review-note"><strong>Estamos verificando la creación con Pey.</strong><p>Si hubo una interrupción, el QR podría haberse creado. No generes otro cobro para esta venta hasta revisar Pey. Puedes consultar este cobro desde el historial.</p><button className="text-button" onClick={() => { setTab("history"); void refresh(); }}>Ver historial</button></div>}{charge.status === "pending" && qr && <div className="qr-wrap"><img src={qr} width="250" height="250" alt={`QR CoDi para pagar ${money(charge.amount_cents)}`} /></div>}{charge.status === "pending" && <><p className="qr-instruction">Abre CoDi en la app de tu banco<br />y escanea este código.</p><div className="waiting"><span className="pulse" />{online ? "Esperando confirmación del banco" : "Sin conexión para confirmar"}</div>{remaining !== null && <p className="expiry">{remaining > 0 ? `Vence en ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}` : "Tiempo del QR agotado. Consultando estado…"}</p>}<p className="cancellation-note">Cancela esta solicitud en tu caja; un pago posterior seguirá registrándose.</p><button className="text-button" disabled={busy || reconciling || !online} onClick={cancel}>{busy ? "Cancelando…" : "Cancelar cobro"}</button></>}{charge.status === "review" && <p className="review-note">El pago no coincide con lo esperado. Revisa la operación en Pey antes de entregar tu producto.</p>}{!["pending", "creating"].includes(charge.status) && <button className="primary" onClick={() => { setCharge(null); attempt.current = null; setUncertainCreation(false); setDigits("0"); }}>Volver a cobrar<Icon name="arrow" /></button>}</>}
        {["pending", "expired", "cancelled", "failed"].includes(charge.status) && charge.qr_string && <button className="secondary" disabled={reconciling || busy || !online} onClick={() => { void reconcile(charge.id); }}>{reconciling ? "Verificando con Pey…" : "Verificar pago"}</button>}{reconciliationMessage?.chargeId === charge.id && <p className="reconciliation-note" role="status" aria-live="polite">{reconciliationMessage.text}</p>}
        </div>}
      </section><aside className="summary-column"><section className="today-card"><div className="today-top"><span>Tu caja de hoy</span><Icon name="chart" /></div><span className="total-label">TOTAL RECIBIDO</span><div className="today-total">{totalLabel}</div><span className="total-caption">{corteLoading && corte ? "Actualizando el corte…" : "Solo pagos confirmados"}</span><div className="today-stats"><div><strong>{paidCount}</strong><span>pagados</span></div><div><strong>{pending}</strong><span>pendientes</span></div></div><button onClick={() => setTab("cut")} className="summary-link">Ver corte del día<Icon name="arrow" /></button><button className="text-button" disabled={corteLoading} onClick={refresh}>{corteLoading ? "Actualizando corte…" : "Actualizar corte"}</button></section><section className="how-card"><span className="little-spark">✦</span><h3>Tu celular te avisa.</h3><p>Cuando el pago se confirma, escucharás el monto en voz alta.</p><div className="voice-example"><Icon name="sound" /><span>“Pago recibido…”</span></div><p className="small-copy">Mantén la caja abierta y el volumen encendido.</p></section><div className="trust-note"><Icon name="check" /><p>Una captura no es una confirmación.<br /><strong>Espera el aviso de tu caja.</strong></p></div></aside></div> : tab === "history" ? <section className="history-card"><div className="section-heading"><h2>Cobros de hoy</h2><button className="text-button" onClick={refresh}>Actualizar</button></div><input className="search" aria-label="Buscar cobro por monto, concepto, hora o folio" placeholder="Buscar por monto, concepto, hora o folio…" value={filter} onChange={e => setFilter(e.target.value)} />{historyTruncated && <p className="offline-banner" role="status">El historial muestra los 1,000 cobros más recientes de esta fecha. El corte incluye todos los pagos del día.</p>}<div className="transactions">{charges.filter(c => `${c.amount_cents / 100} ${c.concept} ${hour(c.created_at)} ${c.transaction_id || ""}`.toLowerCase().includes(filter.toLowerCase())).map(c => <button className="transaction" key={c.id} onClick={() => { setCharge(c); setTab("charge"); }}><span className={`transaction-icon ${c.status}`}><Icon name={c.status === "paid" ? "check" : "charge"} /></span><span className="transaction-info"><strong>{c.concept}</strong><span>{hour(c.created_at)}{c.transaction_id ? ` · Folio ${c.transaction_id.slice(-6)}` : ""}</span></span><span className="transaction-value"><strong>{money(c.amount_cents)}</strong><span className={`status-text ${c.status}`}>{labels[c.status] || c.status}{c.late_payment ? " · Fuera de tiempo" : ""}</span></span></button>)}{charges.length === 0 && <div className="empty-state"><Icon name="history" /><h3>Tu primer cobro va aquí.</h3><p>Los cobros que generes aparecerán con su estado.</p><button className="secondary" onClick={() => setTab("charge")}>Crear un cobro</button></div>}</div></section> : <section className="cut-card"><span className="eyebrow">{merchant.name} · {today}</span><h2>Tu corte del día</h2><button className="text-button" onClick={refresh} disabled={corteLoading}>{corteLoading ? "Actualizando…" : "Actualizar corte"}</button><span className="total-label">TOTAL RECIBIDO</span><div className="cut-total">{totalLabel}</div><p>{corte ? `${paidCount} ${paidCount === 1 ? "pago confirmado" : "pagos confirmados"}` : corteLoading ? "Actualizando el corte completo…" : "No pudimos consultar el corte. Vuelve a intentar."}</p><div className="cut-details"><div><span>Cobros pendientes</span><strong>{pending}</strong></div><div><span>Necesitan revisión</span><strong>{corte?.review_receipt_count ?? "—"}</strong></div><div><span>Monto por revisar</span><strong>{corte ? money(corte.review_amount_cents) : "—"}</strong></div><div><span>Zona horaria</span><strong>Ciudad de México</strong></div></div><button className="primary" disabled={!corte || corteLoading} onClick={() => { if (!corte) return; const text = `Corte del día · ${merchant.name}\n${corte.date}\nTotal recibido: ${money(corte.total_paid_cents)} MXN\nPagos confirmados: ${corte.paid_count}\nCobros pendientes: ${corte.pending_count}\nRecibos por revisar: ${corte.review_receipt_count}\nGenerado con Cuadra`; window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank", "noopener,noreferrer"); }}>Compartir corte por WhatsApp<Icon name="arrow" /></button><p className="fine-print">Este resumen incluye únicamente los pagos confirmados de hoy. No representa un cierre contable definitivo.</p></section>}
      <footer className="workspace-footer"><span>Cuadra · Menos pendientes. Más tranquilidad.</span><span>Hecho para tu negocio.</span></footer></div>
    </main>
  </div>;
}
