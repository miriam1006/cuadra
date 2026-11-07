'use client';
import { useEffect, useState, type FormEvent } from 'react';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (new URLSearchParams(window.location.search).has('error')) {
      setError('No se pudo completar el acceso. Inicia sesión con tu correo y contraseña.');
    }
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }), signal: AbortSignal.timeout(20_000),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'No se pudo iniciar sesión.');
      setPassword('');
      window.location.assign('/');
    } catch (e) {
      setError(e instanceof Error && e.name === 'TimeoutError'
        ? 'La conexión tardó demasiado. Vuelve a intentar.'
        : e instanceof Error ? e.message : 'No se pudo iniciar sesión.');
      setBusy(false);
    }
  }

  return <main className="entry"><section className="entry-card">
    <a className="brand" href="/">Cuadra<span className="brand-dot">.</span></a>
    <p className="eyebrow">EL MOSTRADOR DE TU NEGOCIO</p>
    <h1>Tu caja.<br />Tu tranquilidad.</h1>
    <p>Inicia sesión para empezar a cobrar.</p>
    <form onSubmit={submit} className="login-form" aria-busy={busy}>
      <div>
        <label className="field-label" htmlFor="email">Correo electrónico</label>
        <input id="email" name="email" type="email" autoComplete="username" inputMode="email"
          autoCapitalize="none" spellCheck={false} required maxLength={254} disabled={busy}
          value={email} onChange={e => setEmail(e.target.value)} placeholder="tu@negocio.mx" />
      </div>
      <div>
        <label className="field-label" htmlFor="password">Contraseña</label>
        <div className="password-field">
          <input id="password" name="password" type={showPassword ? 'text' : 'password'}
            autoComplete="current-password" required maxLength={256} disabled={busy}
            value={password} onChange={e => setPassword(e.target.value)} placeholder="Tu contraseña" />
          <button type="button" className="password-toggle" aria-controls="password"
            aria-pressed={showPassword} disabled={busy} onClick={() => setShowPassword(value => !value)}>
            {showPassword ? 'Ocultar' : 'Mostrar'}
          </button>
        </div>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="primary" disabled={busy} type="submit">
        {busy ? 'Entrando…' : 'Iniciar sesión'}<span aria-hidden="true">↗</span>
      </button>
    </form>
    <p className="fine-print">Los cobros llegan a la cuenta vinculada en Pey. Mantén la caja abierta para escuchar los avisos.</p>
  </section></main>;
}
