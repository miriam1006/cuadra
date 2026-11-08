"use client";
import { useState, type FormEvent } from 'react';
import { clientApi } from '@/lib/client-api';
export default function ChangePasswordCard({onComplete}:{onComplete:()=>void|Promise<void>}){
  const [password,setPassword]=useState('');
  const [confirmation,setConfirmation]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  async function submit(event:FormEvent){
    event.preventDefault();setError('');
    if(password.length<12){setError('Usa al menos 12 caracteres.');return;}
    if(password!==confirmation){setError('Las contraseñas no coinciden.');return;}
    setBusy(true);
    try{await clientApi('/api/auth/password',{method:'POST',body:JSON.stringify({password,confirm_password:confirmation})});setPassword('');setConfirmation('');await onComplete();}
    catch(e){setError((e as Error).message);}
    finally{setBusy(false);}
  }
  return <main className="entry"><section className="entry-card"><div className="brand">Cuadra<span className="brand-dot">.</span></div><span className="eyebrow">TU ACCESO PERSONAL</span><h1>Elige tu contraseña.</h1><p>Reemplaza la contraseña temporal antes de abrir tu caja.</p><form className="team-form" onSubmit={submit}><label className="field-label" htmlFor="new-password">Contraseña nueva</label><input id="new-password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required value={password} onChange={e=>setPassword(e.target.value)} disabled={busy}/><label className="field-label" htmlFor="confirm-password">Confirmar contraseña</label><input id="confirm-password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required value={confirmation} onChange={e=>setConfirmation(e.target.value)} disabled={busy}/>{error&&<p className="error" role="alert">{error}</p>}<button className="primary" type="submit" disabled={busy}>{busy?'Guardando…':'Guardar y continuar'}</button></form></section></main>;
}
