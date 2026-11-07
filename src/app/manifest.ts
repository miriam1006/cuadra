import type { MetadataRoute } from 'next';
export default function manifest():MetadataRoute.Manifest { return {name:'Cuadra',short_name:'Cuadra',description:'Tu caja con confirmación de pagos CoDi por voz.',start_url:'/',display:'standalone',background_color:'#f7f7f1',theme_color:'#17644b',lang:'es-MX',icons:[{src:'/icon.svg',sizes:'any',type:'image/svg+xml',purpose:'any'}]}; }
