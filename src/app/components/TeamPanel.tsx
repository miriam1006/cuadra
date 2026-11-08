"use client";
import { useCallback,useEffect,useState,type FormEvent } from 'react';
import { clientApi } from '@/lib/client-api';
type Member={user_id:string;email:string;display_name:string;role:'admin'|'cashier';active:boolean;is_owner:boolean};
export default function TeamPanel(){
  const [members,setMembers]=useState<Member[]>([]);
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [mode,setMode]=useState<'create'|'existing'>('create');
  const [editing,setEditing]=useState<Member|null>(null);
  const [name,setName]=useState('');
  const [email,setEmail]=useState('');
  const [password,setPassword]=useState('');
  const [role,setRole]=useState<'admin'|'cashier'>('cashier');
  const [active,setActive]=useState(true);
  const load=useCallback(async()=>{setLoading(true);try{const data=await clientApi('/api/team');setMembers(data.members||[]);}catch(e){setError((e as Error).message);}finally{setLoading(false);}},[]);
  useEffect(()=>{void load();},[load]);
  function reset(){setEditing(null);setName('');setEmail('');setPassword('');setRole('cashier');setActive(true);}
  function edit(member:Member){setEditing(member);setName(member.display_name);setEmail(member.email);setRole(member.role);setActive(member.active);setPassword('');setError('');setNotice('');}
  async function submit(event:FormEvent){
    event.preventDefault();setBusy(true);setError('');setNotice('');
    try{
      if(editing){await clientApi('/api/team/'+editing.user_id,{method:'PATCH',body:JSON.stringify({display_name:name.trim(),role,active})});}
      else{const payload=mode==='create'?{mode,email,display_name:name.trim(),role,password}:{mode,email,display_name:name.trim(),role};await clientApi('/api/team',{method:'POST',body:JSON.stringify(payload)});}
      setNotice(editing?'Acceso actualizado.':mode==='create'?'Acceso creado. Comparte la contraseña temporal por un medio privado; deberá cambiarla al iniciar sesión.':'Usuario vinculado al negocio. Su contraseña se conserva.');reset();await load();
    }catch(e){setError((e as Error).message);}
    finally{setBusy(false);}
  }
  return <section className="history-card team-panel"><div className="section-heading"><h2>Usuarios de tu negocio</h2><button type="button" className="text-button" disabled={loading||busy} onClick={()=>{setError('');void load();}}>Actualizar</button></div><p className="team-description">Cada persona inicia sesión con su correo y contraseña. Los cajeros cobran y consultan sus ventas del día; los administradores también gestionan productos y usuarios.</p>{error&&<p className="error" role="alert">{error}</p>}{notice&&<p className="team-notice" role="status">{notice}</p>}<div className="team-layout"><div><h3>{editing?'Editar acceso':'Agregar usuario'}</h3><form className="team-form" onSubmit={submit}>{!editing&&<label className="field-label">Tipo de alta<select value={mode} onChange={e=>{setMode(e.target.value as 'create'|'existing');setPassword('');}} disabled={busy}><option value="create">Crear acceso nuevo</option><option value="existing">Vincular usuario existente</option></select></label>}<label className="field-label" htmlFor="team-name">Nombre</label><input id="team-name" maxLength={100} required value={name} onChange={e=>setName(e.target.value)} disabled={busy}/><label className="field-label" htmlFor="team-email">Correo electrónico</label><input id="team-email" type="email" autoComplete="off" maxLength={254} required value={email} onChange={e=>setEmail(e.target.value)} disabled={busy||Boolean(editing)}/>{!editing&&mode==='create'&&<><label className="field-label" htmlFor="team-password">Contraseña temporal</label><input id="team-password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required value={password} onChange={e=>setPassword(e.target.value)} disabled={busy}/><p className="fine-print">Al menos 12 caracteres. La persona deberá cambiarla al entrar por primera vez.</p></>}<label className="field-label" htmlFor="team-role">Permisos</label><select id="team-role" value={role} onChange={e=>setRole(e.target.value as 'admin'|'cashier')} disabled={busy||editing?.is_owner}><option value="cashier">Cajero</option><option value="admin">Administrador</option></select>{editing&&<label className="team-check"><input type="checkbox" checked={active} onChange={e=>setActive(e.target.checked)} disabled={busy||editing.is_owner}/>Acceso activo</label>}<button className="primary" type="submit" disabled={busy}>{busy?'Guardando…':editing?'Guardar acceso':mode==='create'?'Crear acceso':'Vincular usuario'}</button>{editing&&<button className="secondary" type="button" disabled={busy} onClick={reset}>Cancelar edición</button>}</form></div><div><h3>Equipo</h3>{loading&&<p className="fine-print">Consultando usuarios…</p>}<div className="team-members">{members.map(member=><div className="team-member" key={member.user_id}><div><strong>{member.display_name}</strong><span>{member.email}</span><small>{member.role==='admin'?'Administrador':'Cajero'} · {member.active?'Activo':'Desactivado'}{member.is_owner?' · Principal':''}</small></div><button type="button" className="text-button" aria-label={'Editar acceso de '+member.display_name} disabled={busy} onClick={()=>edit(member)}>Editar</button></div>)}</div></div></div></section>;
}
