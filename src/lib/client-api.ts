export async function clientApi(path: string, options: RequestInit = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.method === 'POST' ? 35000 : 15000);
  try {
    const response = await fetch(path,{...options,signal:controller.signal,headers:{'Content-Type':'application/json',...options.headers},cache:'no-store'});
    if(response.status===401){window.location.assign('/login');throw new Error('Inicia sesión para continuar.');}
    const data=await response.json().catch(()=>({}));
    if(!response.ok) throw new Error(typeof data.error==='string'?data.error:'No se pudo completar la operación.');
    return data;
  } catch(error) {
    if(controller.signal.aborted) throw new Error('La consulta tardó demasiado. Vuelve a intentar.');
    throw error;
  } finally {clearTimeout(timeout);}
}
