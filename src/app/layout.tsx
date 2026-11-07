import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { title: 'Cuadra', description: 'Tu caja, con confirmación de pago por voz.' };
// This authenticated register is rendered per request, including error pages.
export const dynamic = 'force-dynamic';
export default function Layout({ children }: { children: React.ReactNode }) { return <html lang="es-MX"><body>{children}</body></html>; }
