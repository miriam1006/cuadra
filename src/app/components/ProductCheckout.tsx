"use client";

import { useEffect, useRef, useState } from "react";

type Product = { id: string; name: string; price_cents: number; barcode: string | null; active: boolean };
export type CartItem = { product_id: string; quantity: number };
type Props = {
  onCheckout: (items: CartItem[]) => Promise<void>;
  disabled: boolean;
  maxAmountCents: number;
  isAdmin?: boolean;
  onManageProducts?: () => void;
};
const money = (cents: number) => new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(cents / 100);

export default function ProductCheckout({ onCheckout, disabled, maxAmountCents, isAdmin = false, onManageProducts }: Props) {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [barcode, setBarcode] = useState("");
  const [items, setItems] = useState<CartItem[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const scanner = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const checkoutLock = useRef(false);
  const wasDisabled = useRef(disabled);
  const locked = disabled || submitting;

  async function loadProducts() {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setLoading(true); setLoadError("");
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch("/api/products", { cache: "no-store", signal: controller.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "No pudimos cargar los productos.");
      if (mounted.current && request.current === controller) {
        setProducts((data.products as Product[]).filter(product => product.active));
        setTruncated(data.truncated === true);
      }
    } catch (e) {
      if (mounted.current && request.current === controller) setLoadError(controller.signal.aborted ? "La consulta de productos tardó demasiado. Vuelve a intentar." : (e as Error).message);
    } finally { clearTimeout(timer); if (mounted.current && request.current === controller) setLoading(false); }
  }
  useEffect(() => { mounted.current = true; void loadProducts(); return () => { mounted.current = false; request.current?.abort(); }; }, []);
  useEffect(() => {
    const reenabled = wasDisabled.current && !disabled;
    wasDisabled.current = disabled;
    if (reenabled) void loadProducts();
  }, [disabled]);

  function add(product: Product) {
    if (locked) return;
    const existing = items.find(item => item.product_id === product.id);
    if (existing && existing.quantity >= 999) { setError("El máximo es 999 unidades por producto."); return; }
    if (!existing && items.length >= 50) { setError("Puedes agregar hasta 50 productos diferentes por cobro."); return; }
    setItems(previous => {
      const line = previous.find(item => item.product_id === product.id);
      if (line) return line.quantity >= 999 ? previous : previous.map(item => item.product_id === product.id ? { ...item, quantity: item.quantity + 1 } : item);
      return previous.length >= 50 ? previous : [...previous, { product_id: product.id, quantity: 1 }];
    });
    setError(""); setNotice(`${product.name} agregado al carrito.`);
  }
  function scan(value: string) {
    if (locked) return;
    const exact = value.trim();
    if (!exact) return;
    const found = products.find(product => product.barcode === exact);
    setBarcode("");
    if (scanner.current) scanner.current.value = "";
    if (found) add(found);
    else { setNotice(""); setError(isAdmin ? `No hay un producto activo con el código ${exact}. Regístralo en Productos.` : `No hay un producto activo con el código ${exact}. Pide al administrador que lo registre.`); }
    scanner.current?.focus();
  }
  function changeQuantity(id: string, delta: number) {
    if (locked) return;
    const current = items.find(item => item.product_id === id);
    if (!current) return;
    const quantity = current.quantity + delta;
    if (quantity > 999) { setError("El máximo es 999 unidades por producto."); return; }
    setItems(previous => quantity <= 0 ? previous.filter(item => item.product_id !== id) : previous.map(item => item.product_id === id ? { ...item, quantity } : item));
    setError(""); setNotice("");
  }
  const byId = new Map(products.map(product => [product.id, product]));
  const unavailable = items.some(item => !byId.has(item.product_id));
  const total = items.reduce((sum, item) => sum + (byId.get(item.product_id)?.price_cents || 0) * item.quantity, 0);
  const visible = products.filter(product => `${product.name} ${product.barcode || ""}`.toLocaleLowerCase("es-MX").includes(query.toLocaleLowerCase("es-MX"))).sort((a, b) => a.name.localeCompare(b.name, "es-MX"));
  async function checkout() {
    if (locked || checkoutLock.current || !items.length || unavailable || total <= 0 || total > maxAmountCents) return;
    checkoutLock.current = true; setSubmitting(true); setError("");
    try { await onCheckout(items.map(item => ({ ...item }))); }
    catch (e) { if (mounted.current) setError((e as Error).message || "No se pudo generar el cobro. Conservamos tu carrito para revisarlo o reintentar."); }
    finally { checkoutLock.current = false; if (mounted.current) setSubmitting(false); }
  }
  return <div className="product-checkout">
    <div className="catalog-section-title"><h2>Productos para cobrar</h2><button type="button" className="text-button" disabled={locked || loading} onClick={loadProducts}>Actualizar</button></div>
    {loadError && <p className="error" role="alert">{loadError}</p>}
    <label className="field-label" htmlFor="product-scanner">Lector de código de barras</label>
    <input ref={scanner} id="product-scanner" className="product-scanner" type="text" inputMode="text" autoComplete="off" spellCheck={false} value={barcode} disabled={locked || loading || !!loadError} placeholder="Escanea aquí con tu lector USB o Bluetooth" onChange={event => setBarcode(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); if (!event.repeat) scan(event.currentTarget.value); } }} />
    <p className="catalog-help">El lector debe escribir el código y terminar con Enter. Escanear agrega una unidad; el QR se genera al confirmar el carrito.</p>
    <label className="field-label" htmlFor="product-search">Buscar por nombre o código</label>
    <input id="product-search" value={query} onChange={event => setQuery(event.target.value)} disabled={locked} placeholder="Ej. Agua o 750…" autoComplete="off" />
    {loading ? <p className="catalog-help" role="status">Cargando productos…</p> : <div className="product-quick-list" aria-label="Productos disponibles">{visible.slice(0, 24).map(product => <button type="button" key={product.id} className="product-quick-add" disabled={locked} onClick={() => add(product)}><span>{product.name}</span><strong>{money(product.price_cents)}</strong><span aria-hidden="true">＋</span></button>)}{!visible.length && <p className="catalog-help">{products.length ? "No hay productos que coincidan." : isAdmin ? "Agrega tu primer producto desde Productos." : "Aún no hay productos activos. Pide al administrador que los agregue."}</p>}</div>}
    {(visible.length > 24 || truncated) && <p className="catalog-help">Se muestran hasta 24 coincidencias del catálogo cargado. Usa la búsqueda o el código exacto.{truncated ? " El catálogo recibido está limitado; solicita al administrador revisar los productos faltantes." : ""}</p>}
    {isAdmin && onManageProducts && <button type="button" className="text-button" disabled={locked} onClick={onManageProducts}>Administrar productos</button>}
    <section className="cart-section" aria-label="Carrito de cobro"><h3>Carrito <span>{items.reduce((sum, item) => sum + item.quantity, 0)} unidades</span></h3>
      {!items.length && <p className="catalog-help">Selecciona un producto o escanea su código.</p>}
      {items.map(item => { const product = byId.get(item.product_id); return <div className="cart-line" key={item.product_id}><div className="cart-line-name"><strong>{product?.name || "Producto no disponible"}</strong><span>{product ? `${money(product.price_cents)} por unidad` : "Retíralo del carrito para continuar"}</span></div><div className="cart-quantity"><button type="button" disabled={locked} aria-label={`Quitar una unidad de ${product?.name || "producto"}`} onClick={() => changeQuantity(item.product_id, -1)}>−</button><output aria-label={`Cantidad de ${product?.name || "producto"}`}>{item.quantity}</output><button type="button" disabled={locked || item.quantity >= 999} aria-label={`Agregar una unidad de ${product?.name || "producto"}`} onClick={() => changeQuantity(item.product_id, 1)}>＋</button></div><strong className="cart-line-total">{product ? money(product.price_cents * item.quantity) : "—"}</strong><button type="button" className="cart-remove" disabled={locked} onClick={() => { setItems(previous => previous.filter(line => line.product_id !== item.product_id)); setError(""); }} aria-label={`Eliminar ${product?.name || "producto"} del carrito`}>Quitar</button></div>; })}
      <div className="cart-total"><span>Total del carrito</span><strong>{money(total)}</strong></div>
      <p className="catalog-help">El servidor confirma los precios al generar el cobro.</p>
    </section>
    {total > maxAmountCents && <p className="error" role="alert">El máximo por cobro es {money(maxAmountCents)}.</p>}
    {unavailable && <p className="error" role="alert">Hay productos no disponibles en el carrito. Retíralos antes de cobrar.</p>}
    {error && <p className="error" role="alert">{error}</p>}
    <p className="catalog-status" role="status" aria-live="polite">{notice}</p>
    <button type="button" className="primary generate" disabled={locked || loading || !!loadError || !items.length || unavailable || total <= 0 || total > maxAmountCents} onClick={checkout}>{submitting ? "Generando cobro…" : `Generar QR de ${money(total)}`}</button>
  </div>;
}
