"use client";

import { useEffect, useId, useRef, useState } from "react";
import { parseVoiceCharge } from "@/lib/voice-amount";

type VoiceCharge = { amountCents: number; concept: string };
type Props = { onRecognized: (value: VoiceCharge) => void; disabled?: boolean };
type Result = { readonly isFinal: boolean; readonly [index: number]: { readonly transcript: string } };
type ResultEvent = { readonly resultIndex: number; readonly results: { readonly [index: number]: Result } };
type Recognition = {
  lang: string; continuous: boolean; interimResults: boolean; maxAlternatives: number;
  onresult: ((event: ResultEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onstart: (() => void) | null;
  onnomatch: (() => void) | null; onend: (() => void) | null;
  start: () => void; abort: () => void;
};
type Constructor = new () => Recognition;
type VoiceWindow = Window & { SpeechRecognition?: Constructor; webkitSpeechRecognition?: Constructor };
type Session = { recognition: Recognition; timer: ReturnType<typeof setTimeout> | null };
const NOT_UNDERSTOOD = "No entendí el monto, intenta de nuevo o escríbelo";
const ERRORS: Record<string, string> = {
  "no-speech": NOT_UNDERSTOOD,
  "not-allowed": "El acceso al micrófono está bloqueado. Abre los controles del sitio junto a la dirección, permite el micrófono y recarga Cuadra.",
  "service-not-allowed": "Tu navegador no permite el reconocimiento de voz. Puedes escribir el cobro.",
  "audio-capture": "No pudimos acceder al micrófono. Revisa que esté disponible o escribe el cobro.",
  network: "No pudimos conectar el reconocimiento de voz. Revisa tu conexión o escribe el cobro.",
  "language-not-supported": "Tu navegador no admite dictado en español de México. Puedes escribir el cobro.",
  aborted: "La escucha se canceló. Puedes volver a intentar o escribir el cobro.",
};

export default function VoiceChargeButton({ onRecognized, disabled = false }: Props) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [starting, setStarting] = useState(false);
  const [message, setMessage] = useState("");
  const [transcript, setTranscript] = useState("");
  const mounted = useRef(false);
  const disabledRef = useRef(disabled);
  const callback = useRef(onRecognized);
  const active = useRef<Session | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const helpId = useId();
  useEffect(() => { callback.current = onRecognized; }, [onRecognized]);

  function end(session: Session, update = true) {
    if (active.current !== session) return;
    active.current = null;
    if (session.timer) clearTimeout(session.timer);
    session.recognition.onresult = null;
    session.recognition.onstart = null;
    session.recognition.onerror = null;
    session.recognition.onnomatch = null;
    session.recognition.onend = null;
    try { session.recognition.abort(); } catch { /* Recognition may have already ended. */ }
    if (mounted.current && update) { setListening(false); setStarting(false); }
  }

  useEffect(() => {
    mounted.current = true;
    const browser = window as VoiceWindow;
    setSupported(Boolean(browser.SpeechRecognition || browser.webkitSpeechRecognition));
    // Manual input wins. These listeners never prevent default or synthesize keys.
    const outsideInteraction = (event: Event) => {
      const session = active.current;
      if (!session) return;
      const outside = event.target instanceof Node && !container.current?.contains(event.target);
      const editingKey = event instanceof KeyboardEvent && !["Enter", " ", "Tab", "Shift", "Control", "Alt", "Meta"].includes(event.key);
      if (outside || editingKey) {
        end(session);
        if (mounted.current) setMessage("Dictado cancelado. Puedes seguir escribiendo el cobro.");
      }
    };
    const hidden = () => { if (document.visibilityState === "hidden" && active.current) end(active.current); };
    document.addEventListener("pointerdown", outsideInteraction, true);
    document.addEventListener("focusin", outsideInteraction, true);
    document.addEventListener("input", outsideInteraction, true);
    document.addEventListener("keydown", outsideInteraction, true);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      mounted.current = false;
      document.removeEventListener("pointerdown", outsideInteraction, true);
      document.removeEventListener("focusin", outsideInteraction, true);
      document.removeEventListener("input", outsideInteraction, true);
      document.removeEventListener("keydown", outsideInteraction, true);
      document.removeEventListener("visibilitychange", hidden);
      if (active.current) end(active.current, false);
    };
  }, []);
  useEffect(() => {
    disabledRef.current = disabled;
    if (disabled && active.current) end(active.current);
  }, [disabled]);

  function handleClick() {
    if (disabled || !mounted.current) return;
    if (active.current) {
      end(active.current); setMessage("Escucha cancelada. Puedes volver a intentar o escribir el cobro."); return;
    }
    const browser = window as VoiceWindow;
    const Recognition = browser.SpeechRecognition || browser.webkitSpeechRecognition;
    if (!Recognition) return;
    setMessage(""); setTranscript("");
    let recognition: Recognition;
    try { recognition = new Recognition(); }
    catch { setMessage("No se pudo iniciar el micrófono. Puedes escribir el cobro."); return; }
    recognition.lang = "es-MX";
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    const session: Session = { recognition, timer: null };
    active.current = session;
    const isCurrent = () => mounted.current && !disabledRef.current && active.current === session;
    const fail = (text: string) => {
      if (!isCurrent()) return;
      end(session); setMessage(text);
    };
    recognition.onstart = () => {
      if (!isCurrent()) return;
      if (session.timer) clearTimeout(session.timer);
      setStarting(false); setListening(true);
      session.timer = setTimeout(() => fail(NOT_UNDERSTOOD), 12000);
    };
    recognition.onresult = event => {
      if (!isCurrent()) return;
      const result = event.results[event.resultIndex || 0];
      if (!result?.isFinal) return;
      const heard = result[0]?.transcript?.trim() || "";
      let value: VoiceCharge | null = null;
      try { value = parseVoiceCharge(heard); } catch { /* Leave the form unchanged when parsing fails. */ }
      end(session);
      if (!mounted.current || disabledRef.current) return;
      setTranscript(heard);
      if (!value || !Number.isSafeInteger(value.amountCents) || value.amountCents <= 0 || typeof value.concept !== "string") {
        setMessage(NOT_UNDERSTOOD); return;
      }
      setMessage("");
      callback.current(value);
    };
    recognition.onerror = event => fail(ERRORS[event.error] || "No se pudo reconocer la voz. Intenta de nuevo o escribe el cobro.");
    recognition.onnomatch = () => fail(NOT_UNDERSTOOD);
    recognition.onend = () => fail(NOT_UNDERSTOOD);
    // Give the permission prompt time; the phrase timeout begins only after capture starts.
    session.timer = setTimeout(() => fail("No pudimos abrir el micrófono. Revisa el permiso en los controles del sitio junto a la dirección y vuelve a intentar."), 45000);
    setStarting(true);
    try { recognition.start(); }
    catch (error) {
      const name = error instanceof Error ? error.name : "";
      fail(name === "NotAllowedError" || name === "SecurityError" ? ERRORS["not-allowed"] : "No se pudo iniciar el dictado. Intenta de nuevo o escribe el cobro.");
    }
  }

  if (!supported) return null;
  return <div ref={container} className="voice-charge">
    <button type="button" className={`voice-charge-button${listening || starting ? " is-listening" : ""}`} onClick={handleClick} disabled={disabled} aria-label={listening || starting ? "Cancelar dictado del cobro" : "Dictar monto y concepto del cobro"} aria-pressed={listening || starting} aria-describedby={helpId}>
      <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" /></svg>
      <span>{starting ? "Abriendo micrófono… toca para cancelar" : listening ? "Escuchando… toca para cancelar" : "Dictar cobro"}</span>
      {listening && <span className="voice-charge-indicator" aria-hidden="true" />}
    </button>
    <details className="voice-charge-tips"><summary id={helpId}>Ejemplo de dictado</summary><p className="voice-charge-help">“Uñas 150 pesos” o “150 pesos por uñas”.</p></details>
    <div className="voice-charge-feedback" aria-live="polite" aria-atomic="true">
      {transcript && <p className="voice-charge-transcript">Escuché: “{transcript}”</p>}
      {message && <p className="voice-charge-message">{message}</p>}
    </div>
  </div>;
}
