# Cuadra

Caja móvil para cobrar con CoDi a través de Pey: QR por venta, confirmación verificada con voz, historial y corte para compartir por WhatsApp.

## Estado real

Implementación inicial para un solo comercio y un usuario administrador. No contiene pagos simulados, credenciales ni datos bancarios. Es una base para un piloto supervisado: requiere configurar Supabase/Pey/Vercel y verificar el flujo completo antes de abrirlo a otros negocios. Las pruebas locales y las consultas a Pey no sustituyen una prueba completa de webhook, pantalla, voz y corte.

## Ejecutar

Requiere Node.js 22 y npm.

```powershell
npm ci
Copy-Item .env.example .env.local
# Completar .env.local directamente en tu editor; nunca subirlo a GitHub.
npm run dev
```

Abrir http://localhost:3000/login. El webhook real necesita HTTPS público: usar el despliegue de Vercel para la prueba completa.

## Configuración y despliegue

1. Crear un repositorio **privado** `miriam1006/cuadra` y subir esta carpeta como raíz del repositorio (no node_modules ni .next).
2. En un proyecto nuevo de Supabase, ejecutar las migraciones en orden: `202611070001_initial.sql` y `202611070002_verified_reconciliation.sql`. Si la primera ya está aplicada, ejecutar solamente la segunda. En un proyecto con tablas ajenas homónimas, revisar la migración antes de aplicarla.
3. En un proyecto de prueba, ejecutar `supabase/tests/payment_flow.sql` y `supabase/tests/reconciliation_flow.sql`. Cada archivo se ejecuta en transacción y finaliza con ROLLBACK. Ver `docs/database.md`.
4. En Vercel, importar `miriam1006/cuadra`, seleccionar Next.js y Node.js 22. No hay directorio raíz anidado si se subió esta carpeta.
5. Agregar las variables indicadas abajo. Crear un primer despliegue y copiar su dominio estable, por ejemplo `https://cuadra-....vercel.app`.
6. Actualizar `APP_URL` a ese origen HTTPS **sin barra final**, configurar en Supabase Auth la Site URL con ese origen y autorizar el redirect exacto `https://TU-DOMINIO/auth/callback`. Redesplegar después de cambiar variables.
7. En Pey → Desarrollador → engrane de la API key, pegar `https://TU-DOMINIO/api/webhooks/pey` y pulsar Crear Secreto de Webhook. Confirmar que Pey guardó la URL para esa API key. Guardar el secreto generado por Pey en `PEY_WEBHOOK_SECRET` de Vercel y redesplegar. Guardar una variable de entorno por sí solo no registra el webhook en Pey.
8. Asegurar que Pey pueda acceder al webhook sin un login de Vercel. La autenticación del endpoint es su firma, no la sesión del dueño. Revisar Deployment Protection o usar el dominio de producción según tu configuración.
9. Crear un usuario con correo y contraseña en Supabase Authentication → Users y marcarlo confirmado para este piloto. Configurar OWNER_EMAIL con ese correo. Iniciar sesión en `/login`, crear el comercio y abrir caja.
10. Cobrar **$0.01 MXN** utilizando la cuenta de pruebas de Pey. Pagar con CoDi desde otro dispositivo, esperar el aviso, revisar el folio/corte y comprobar el movimiento en Pey. Los centavos enviados a la cuenta de prueba pueden no devolverse; el usuario ya confirmó esta condición.

No se requiere configurar una cuenta Stripe para el alcance QR de este MVP.

### Variables

| Variable | Origen y uso |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | URL de tu proyecto Supabase |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Clave pública `sb_publishable_...`; tipo Config en Vercel |
| `SUPABASE_SECRET_KEY` | Clave privada `sb_secret_...`; tipo Secret en Vercel, solo servidor |
| `OWNER_EMAIL` | Correo exacto autorizado para administrar este piloto |
| `APP_URL` | Origen del despliegue; local: `http://localhost:3000` |
| `PEY_API_KEY` | Clave secreta de producción vinculada a la cuenta de pruebas |
| `PEY_API_KEY_ID` | **Identificador** de esa API key en Pey (campo `apiKeyId`), no el nombre visible ni el texto `sk_live_...` |
| `PEY_WEBHOOK_SECRET` | Secreto de Standard Webhooks mostrado al crear el webhook |

Compatibilidad: el servidor también acepta `NEXT_PUBLIC_SUPABASE_ANON_KEY` y `SUPABASE_SERVICE_ROLE_KEY` si los nombres nuevos no están configurados. No hace falta volver a capturar claves ya guardadas. Una clave privada nunca debe tener prefijo `NEXT_PUBLIC_`.

Cuando cambies de API key, actualiza **tanto el secreto como el identificador y el secreto de webhook**, redespliega y verifica la cuenta receptora antes de cobrar. Una vez creado el comercio, su `pey_api_key_id` queda vinculado al identificador anterior: un cambio posterior requiere migración administrativa revisada, no solo cambiar variables. No reutilizar QR anteriores con otra cuenta.

Para encontrar `apiKeyId`, abrir Pey → Desarrollador → engrane de la clave → **Webhook Logs** y consultar ese campo en el payload de una entrega real. El nombre visible y el alias bancario son datos distintos. El valor de ejemplo de la documentación no identifica tu clave. Si aún no hay entregas, consultar a Pey cómo obtenerlo antes de configurar el comercio.

## Alcance implementado

- Inicio de sesión con correo y contraseña de Supabase y sesión en cookies HttpOnly; sin modo empleado.
- Un comercio vinculado a la API key configurada en el servidor.
- Montos enteros en centavos, límite por comercio, 10 creaciones por minuto y referencia única.
- Solicitud con UUID idempotente y una sola llamada a Pey por cobro; un timeout no provoca un segundo QR automático.
- QR con expiración de diez minutos, consulta de estado y cancelación local.
- Webhook sobre body crudo, firma/timestamp, aislamiento por API-key ID y procesamiento transaccional.
- Registro de pagos tardíos, diferencias de monto y pagos adicionales para revisión.
- Recuperación de notificaciones perdidas mediante consulta autenticada a Pey por QR, con procedencia `api_reconciliation`, fecha original, auditoría e idempotencia compartida con el webhook. Disponible con **Verificar pago** y una comprobación acotada del cobro seleccionado al recuperar conexión.
- Voz/sonido/vibración disponibles según navegador con la caja abierta; Wake Lock cuando el dispositivo lo admite.
- Corte calculado en la base de datos desde recibos, por fecha de Ciudad de México. Pagos en revisión se muestran aparte. Historial limitado a 1000 filas; el corte agrega todos los recibos del día.

Cancelar en Cuadra no invalida un QR en Pey: cualquier dinero recibido después se registra. La expiración local es conservadora y empieza al reservar el cobro, antes de la respuesta de Pey. El webhook firmado es la vía principal; la conciliación consulta el QR desde el servidor y solo confirma transacciones `PAID`, CoDi y MXN verificadas. Una diferencia de monto o un pago adicional pasa a revisión. Ningún dato de pago enviado por el navegador sirve como comprobante.

## Validación

```powershell
npm run typecheck
npm test
npm run build
```

Las pruebas automatizadas cubren firma auténtica/manipulada, timestamp vencido/futuro, precisión de montos, contratos y rechazo de evidencia incompleta o alterada. Las pruebas SQL cubren duplicados entre webhook y conciliación, montos distintos, pago tardío, recuperación por referencia, permisos/RLS, procedencia y corte. No confundir pruebas unitarias aprobadas con una prueba real de banco a banco.

## Antes de abrirlo a otros negocios

Para investigar un pago pendiente sin volver a cobrar, el usuario administrador puede abrir `/api/diagnostics/last-payment` en el navegador donde inició sesión. Es una consulta de solo lectura: compara el cobro local, los eventos verificados y las transacciones de Pey para su QR. No modifica estados ni devuelve claves, datos bancarios o payloads completos. El parámetro opcional `charge_id` permite seleccionar un cobro anterior.

**Verificar pago** envía `POST /api/charges/{id}/reconcile` con cuerpo `{}`. El servidor comprueba usuario, comercio, API key y QR; consulta la API de Pey y valida toda la página antes de registrar recibos. Si Pey no confirma, falla o la página está truncada, conserva el estado sin confirmarlo. Cada escritura es idempotente; una interrupción durante varios recibos puede requerir repetir la verificación para completarla. La conciliación no crea eventos de webhook ficticios. Un QR sin referencia guardada requiere resolver su creación antes de conciliar.

- Ejecutar la migración y fixtures SQL, probar login/QR/pago real y confirmar el abono y destinatario.
- Definir recuperación operativa de eventos no procesados, manejo de páginas de más de 20 transacciones y límites de consultas por comercio. La recuperación actual es manual o al reconectar el cobro seleccionado; no hay barrido programado ni cron.
- Añadir monitoreo y alertas, procedimientos de respaldo/restauración y resolución de pagos en revisión.
- Probar Android real: volumen, cambios de pestaña, señal interrumpida, batería y reconexión. La voz sigue el cobro seleccionado; no es un servicio de avisos en segundo plano para todos los QR.
- Confirmar límites, reintentos y condiciones comerciales de Pey para incorporar comercios de terceros. El esquema ya aísla comercios; el piloto autoriza solo OWNER_EMAIL y una API key.
- Configurar correo de producción de Supabase y controles de abuso apropiados. Sus límites de autenticación se mantienen activos.

Links de pago, empleados y administración multicomercio quedan fuera de esta primera entrega. El manifiesto de instalación se incluye; no hay caché offline de pagos ni promesa de confirmación sin conexión.

## Referencias

- [Pey OpenAPI](https://docs.pey.mx/openapi.json)
- [Configurar webhooks](https://docs.pey.mx/docs/tutorials/getting-started/set-up-webhooks/)
- [Activación de cuentas y pruebas](https://docs.pey.mx/docs/tutorials/getting-started/create-an-api-key/)
