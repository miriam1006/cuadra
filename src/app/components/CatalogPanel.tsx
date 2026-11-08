"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import ProductCsvImport from "@/app/components/ProductCsvImport";

type Product = { id: string; name: string; price_cents: number; barcode: string | null; active: boolean };
const money = (cents: number) => new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(cents / 100);
function priceInCents(text: string): number | null {
  const value = text.trim().replace(",", ".");
  if (!/^\d{1,8}(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, decimals = ""] = value.split(".");
  const cents = Number(whole) * 100 + Number(decimals.padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents > 0 && cents <= 100000000 ? cents : null;
}
async function request(path: string, options?: RequestInit) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(path, { ...options, cache: "no-store", signal: controller.signal, headers: { "Content-Type": "application/json" } });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "No pudimos guardar el producto.");
    return data;
  } catch (e) { if (controller.signal.aborted) throw new Error("La operación tardó demasiado. Actualiza el catálogo antes de volver a guardar."); throw e; }
  finally { clearTimeout(timer); }
}

export default function CatalogPanel() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [barcode, setBarcode] = useState("");
  const [active, setActive] = useState(true);
  const [search, setSearch] = useState("");
  const mounted = useRef(true);
  const mutationLock = useRef(false);
  const sequence = useRef(0);
  const acquireImportLock = useCallback(() => {
    if (mutationLock.current) return false;
    mutationLock.current = true; setBusy(true); return true;
  }, []);
  const releaseImportLock = useCallback(() => {
    mutationLock.current = false; if (mounted.current) setBusy(false);
  }, []);
  async function load() {
    const current = ++sequence.current; setLoading(true);
    try { const data = await request("/api/products?include_inactive=true"); if (mounted.current && current === sequence.current) { setProducts(data.products || []); setTruncated(data.truncated === true); } }
    catch (e) { if (mounted.current && current === sequence.current) setError((e as Error).message); }
    finally { if (mounted.current && current === sequence.current) setLoading(false); }
  }
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; }; }, []);
  function reset() { setEditing(null); setName(""); setPrice(""); setBarcode(""); setActive(true); }
  function edit(product: Product) { setEditing(product.id); setName(product.name); setPrice((product.price_cents / 100).toFixed(2)); setBarcode(product.barcode || ""); setActive(product.active); setError(""); setNotice(""); }
  async function save(event: FormEvent) {
    event.preventDefault(); if (busy || mutationLock.current) return;
    const cents = priceInCents(price);
    if (!name.trim() || name.trim().length > 100) { setError("Escribe un nombre de hasta 100 caracteres."); return; }
    if (cents === null) { setError("Escribe un precio mayor a cero y de hasta $1,000,000, con máximo dos decimales. No se redondean importes."); return; }
    mutationLock.current = true; setBusy(true); setError(""); setNotice("");
    try {
      await request(editing ? `/api/products/${editing}` : "/api/products", { method: editing ? "PATCH" : "POST", body: JSON.stringify({ name: name.trim(), price_cents: cents, barcode: barcode.trim() || null, active }) });
      if (!mounted.current) return;
      setNotice(editing ? "Producto actualizado." : "Producto agregado."); reset(); await load();
    } catch (e) { if (mounted.current) setError((e as Error).message); }
    finally { mutationLock.current = false; if (mounted.current) setBusy(false); }
  }
  async function toggle(product: Product) {
    if (busy || mutationLock.current) return;
    mutationLock.current = true; setBusy(true); setError(""); setNotice("");
    try {
      await request(`/api/products/${product.id}`, { method: "PATCH", body: JSON.stringify({ name: product.name, price_cents: product.price_cents, barcode: product.barcode, active: !product.active }) });
      if (!mounted.current) return;
      if (editing === product.id) reset();
      setNotice(product.active ? "Producto archivado. Sus cobros anteriores se conservan." : "Producto activado."); await load();
    } catch (e) { if (mounted.current) setError((e as Error).message); }
    finally { mutationLock.current = false; if (mounted.current) setBusy(false); }
  }
  const visible = products.filter(product => `${product.name} ${product.barcode || ""}`.toLocaleLowerCase("es-MX").includes(search.toLocaleLowerCase("es-MX")));
  return <section className="catalog-panel"><div className="catalog-section-title"><div><h2>Catálogo de productos</h2><p className="catalog-help">Los precios se guardan aquí y se confirman en el servidor al cobrar.</p></div><button type="button" className="text-button" disabled={busy || loading} onClick={() => { setError(""); void load(); }}>Actualizar</button></div>
    <ProductCsvImport disabled={busy || loading} tryAcquireLock={acquireImportLock} releaseLock={releaseImportLock} onChanged={load} />
    <form className="catalog-form" onSubmit={save}><h3>{editing ? "Editar producto" : "Agregar producto"}</h3><label>Nombre<input value={name} maxLength={100} onChange={event => setName(event.target.value)} disabled={busy} required placeholder="Ej. Agua natural 600 ml" /></label><div className="catalog-form-pair"><label>Precio en pesos<input type="text" inputMode="decimal" value={price} onChange={event => setPrice(event.target.value)} disabled={busy} required placeholder="15.00" /></label><label>Código de barras o SKU <span>opcional</span><input type="text" value={barcode} maxLength={64} onChange={event => setBarcode(event.target.value)} disabled={busy} placeholder="Conserva ceros iniciales" autoComplete="off" /></label></div><label className="catalog-active"><input type="checkbox" checked={active} disabled={busy} onChange={event => setActive(event.target.checked)} />Disponible para cobrar</label><div className="catalog-form-actions"><button type="submit" className="primary" disabled={busy}>{busy ? "Guardando…" : editing ? "Guardar cambios" : "Agregar producto"}</button>{editing && <button type="button" className="secondary" disabled={busy} onClick={reset}>Cancelar edición</button>}</div></form>
    {error && <p className="error" role="alert">{error}</p>}<p className="catalog-status" role="status" aria-live="polite">{notice}</p>
    <label className="field-label" htmlFor="catalog-search">Buscar producto</label><input id="catalog-search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Nombre o código" />
    {truncated && <p className="catalog-help">El catálogo recibido está limitado. La búsqueda solo incluye los productos cargados.</p>}
    {loading ? <p className="catalog-help" role="status">Cargando catálogo…</p> : <div className="catalog-products">{visible.map(product => <div key={product.id} className={`catalog-product${product.active ? "" : " is-archived"}`}><div className="catalog-product-name"><strong>{product.name}</strong><span>{product.barcode ? `Código: ${product.barcode}` : "Sin código"} · {product.active ? "Activo" : "Archivado"}</span></div><strong>{money(product.price_cents)}</strong><div className="catalog-product-actions"><button type="button" className="text-button" disabled={busy} onClick={() => edit(product)}>Editar</button><button type="button" className="text-button" disabled={busy} onClick={() => { void toggle(product); }}>{product.active ? "Archivar" : "Activar"}</button></div></div>)}{!visible.length && <p className="catalog-help">{products.length ? "No hay coincidencias." : "Todavía no hay productos. Agrega el primero arriba."}</p>}</div>}
  </section>;
}
