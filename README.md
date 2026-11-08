# Cuadra

Caja móvil para cobrar con CoDi a través de Pey: QR por venta, confirmación verificada con voz, historial y corte para compartir por WhatsApp.

**Demo:** [cuadra-gray.vercel.app](https://cuadra-gray.vercel.app). Requiere un usuario autorizado del negocio; las pruebas reales de esta entrega se realizan únicamente por centavos.

Incluye monto libre y dictado, catálogo con carga CSV y códigos de barras, canasta de productos, accesos de administrador/cajero, avisos de voz configurables y cortes por fecha. Construido con Next.js, Supabase y Pey, desplegado en Vercel. La entrega pasó 76 pruebas automatizadas, TypeScript y compilación, además de las verificaciones de integración descritas abajo.

## Acceso de evaluación

Abre la [demo de Cuadra](https://cuadra-gray.vercel.app/) e inicia sesión con la cuenta compartida de evaluación:

| Campo | Valor |
| --- | --- |
| Correo | `demo@cuadra.example` |
| Contraseña | `MielconLimon1234` |
| Rol | Administrador |

Estas credenciales son públicas y exclusivas de la demo. El acceso permite revisar catálogo, carga CSV, cobros, historial, usuarios y cortes. Conserva la contraseña para que los demás evaluadores puedan entrar y utiliza únicamente datos de prueba.

**Los pagos son reales: realiza las pruebas únicamente con montos de centavos.** La cuenta receptora es la cuenta de pruebas configurada con Pey.

El código funcional entregado corresponde al commit [`8284346`](https://github.com/miriam1006/cuadra/commit/82843464d2f9e631ddb8f38a7768d5087c778aa7). Esta sección añade únicamente las instrucciones de acceso para la evaluación; no modifica la aplicación.

## Estado real

Implementación inicial para un comercio, con administradores y cajeros. Cada usuario pertenece a un solo comercio en este piloto. No contiene pagos simulados, credenciales ni datos bancarios. Es una base para un piloto supervisado: requiere configurar Supabase/Pey/Vercel y verificar el flujo completo antes de abrirlo a otros negocios. Las pruebas locales y las consultas a Pey no sustituyen una prueba completa de webhook, pantalla, voz y corte.

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
2. En un proyecto nuevo de Supabase, ejecutar las migraciones en orden: `202611070001_initial.sql`, `202611070002_verified_reconciliation.sql` y `202611080003_catalog_and_team.sql`. Aplicar solo las migraciones pendientes; si ya existen 001 y 002, ejecutar solo 003. En un proyecto con tablas ajenas homónimas, revisar la migración antes de aplicarla.
3. En un proyecto de prueba, ejecutar `supabase/tests/payment_flow.sql`, `supabase/tests/reconciliation_flow.sql` y `supabase/tests/catalog_team_flow.sql`. Cada archivo se ejecuta en transacción y finaliza con ROLLBACK. Ver `docs/database.md`.
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
| `OWNER_EMAIL` | Correo autorizado únicamente para crear el primer comercio; después el acceso se determina por membresías y roles |
| `APP_URL` | Origen del despliegue; local: `http://localhost:3000` |
| `PEY_API_KEY` | Clave secreta de producción vinculada a la cuenta de pruebas |
| `PEY_API_KEY_ID` | **Identificador** de esa API key en Pey (campo `apiKeyId`), no el nombre visible ni el texto `sk_live_...` |
| `PEY_WEBHOOK_SECRET` | Secreto de Standard Webhooks mostrado al crear el webhook |

Compatibilidad: el servidor también acepta `NEXT_PUBLIC_SUPABASE_ANON_KEY` y `SUPABASE_SERVICE_ROLE_KEY` si los nombres nuevos no están configurados. No hace falta volver a capturar claves ya guardadas. Una clave privada nunca debe tener prefijo `NEXT_PUBLIC_`.

Cuando cambies de API key, actualiza **tanto el secreto como el identificador y el secreto de webhook**, redespliega y verifica la cuenta receptora antes de cobrar. Una vez creado el comercio, su `pey_api_key_id` queda vinculado al identificador anterior: un cambio posterior requiere migración administrativa revisada, no solo cambiar variables. No reutilizar QR anteriores con otra cuenta.

Para encontrar `apiKeyId`, abrir Pey → Desarrollador → engrane de la clave → **Webhook Logs** y consultar ese campo en el payload de una entrega real. El nombre visible y el alias bancario son datos distintos. El valor de ejemplo de la documentación no identifica tu clave. Si aún no hay entregas, consultar a Pey cómo obtenerlo antes de configurar el comercio.

## Alcance implementado

- Inicio de sesión con correo y contraseña de Supabase y sesión en cookies HttpOnly; membresías activas con roles administrador/cajero verificadas por el servidor.
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

## Productos, canasta y usuarios

En **Cobrar** se puede elegir **Monto libre** (teclado, Enter y voz existentes) o **Productos**. Un administrador da de alta nombre, precio en centavos y código opcional en **Productos**. Archivar conserva el artículo y sus ventas anteriores. Cada comercio mantiene su propio catálogo y sus propios precios.

El teclado en pantalla se despliega con **Mostrar teclado** cuando se necesite. El campo de monto también admite el teclado de la computadora o el teclado nativo del celular; Enter conserva la generación del QR tras la validación existente.

En **Productos para cobrar**, seleccionar un artículo o escanear su código en el campo dedicado agrega una unidad. Las cantidades admiten de 1 a 999 unidades, hasta 50 artículos distintos. El lector físico debe funcionar como teclado y terminar con Enter; ese Enter agrega un artículo y no genera el QR. La canasta conserva sus cantidades al cambiar de pestaña. Su total es una vista previa: el servidor calcula el precio autorizado al reservar y guarda el detalle de la venta con nombre, precio y cantidades originales. Revisar el importe del QR antes de pagarlo.

La misma clave de idempotencia y canasta reanudan el cobro existente aunque después cambien los precios o se archive un producto. Una creación incierta se revisa en Historial antes de empezar otra. No hay decrementos de existencias ni lectura por cámara en esta versión. Los códigos son texto para conservar ceros iniciales. El catálogo cargado está limitado a 1,000 artículos.

En **Productos → Importar CSV**, descargar la plantilla, completar `nombre,precio,codigo` y seleccionar el archivo para revisar la vista previa. `codigo` es opcional y debe conservarse como texto en Excel para no perder ceros iniciales. `precio` está en pesos, con hasta dos decimales y sin separadores de miles. Admite CSV UTF-8 con comas o punto y coma, hasta 100 productos y 256 KB por archivo. Solo **Importar** guarda los productos; seleccionar un archivo no escribe datos.

La carga agrega productos y omite códigos existentes, incluso archivados, sin actualizar precios ni reactivar registros. Sin código, omite un nombre/precio ya registrado para evitar duplicados. Los errores se muestran por fila; corregirlos antes de importar. Las filas se guardan una por una, no como una transacción única: si se interrumpe o falla una petición, se detiene y conserva lo guardado. Revisar el catálogo y preparar otra vista previa antes de continuar; nunca reintenta automáticamente un alta de resultado incierto. No permite cargas que superen el límite de 1,000 artículos o si no puede consultar el catálogo completo.

En **Usuarios**, un administrador puede crear accesos con contraseña temporal de al menos 12 caracteres o vincular un usuario existente sin cambiar su contraseña. Los accesos nuevos deben elegir una contraseña personal antes de usar la caja. Si el alta de Auth termina pero la vinculación falla, reintentar con **Vincular usuario existente**; el usuario sin membresía no tiene acceso al negocio. Las contraseñas no se guardan en tablas de Cuadra ni en bitácoras.

Los administradores gestionan catálogo/usuarios y consultan el corte del negocio. Los cajeros leen productos activos, crean cobros y consultan/cancelan/verifican sus propios cobros; su corte incluye únicamente sus pagos. Los permisos se comprueban en rutas y funciones de base de datos, además de RLS. La desactivación de un acceso se revisa en cada petición. El administrador principal no puede desactivarse ni perder su rol.

En **Corte del día**, elegir **Fecha del corte**, **Hoy** o **Ayer** para consultar días anteriores y compartir el resumen de la fecha seleccionada. La tarjeta **Tu caja de hoy** sigue mostrando exclusivamente hoy. Todas las fechas corresponden a Ciudad de México; no se aceptan fechas futuras o inexistentes. Los permisos por rol se conservan para cualquier fecha. Estos cortes se calculan desde los recibos actuales, según la fecha del pago: pueden cambiar al conciliar pagos antiguos y no constituyen cierres contables guardados.

## Cobro por voz

El interruptor **Avisos de voz** en la caja activa o silencia los anuncios de pagos recibidos, el sonido y la vibración. Al silenciar, cancela la voz en curso; recuerda la elección en este navegador para la próxima apertura. El dictado del monto es una función independiente y sigue pidiendo permiso de micrófono cuando se usa. Los avisos no modifican la confirmación visual ni el estado de los pagos.

En **Nuevo cobro**, pulsa **Dictar cobro** y di, por ejemplo, “ciento cincuenta uñas”, “uñas 150” o “manicure por treinta y cinco pesos con cincuenta centavos”. Admite monto primero o concepto seguido de un único monto claro al final; si hay varias cantidades, usa monto primero o escribe el formulario. El dictado solo llena monto y concepto: revisa ambos y pulsa **Generar QR**. La voz nunca genera cobros por su cuenta. El teclado físico, el teclado de monto y Enter conservan su comportamiento. Los montos por encima del límite del comercio se llenan y muestran el error existente.

El botón aparece únicamente si el navegador expone `SpeechRecognition` o `webkitSpeechRecognition`. Chrome y Edge compatibles admiten la función; Safari tiene soporte parcial y depende de la versión/permisos. Firefox no es una opción de compatibilidad general: MDN indica soporte de escritorio desde la versión 160, mientras Firefox para Android no lo admite. Consulta la [compatibilidad actual de MDN](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition#browser_compatibility). Usa HTTPS o localhost y permite el micrófono.

En Chrome, el reconocimiento remoto procesa el audio en servidores de Google y normalmente requiere conexión; esta implementación no activa el reconocimiento local experimental. Cuadra usa el texto reconocido para llenar el formulario. Véase [SpeechRecognition en MDN](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition). Puedes cancelar el dictado, seguir escribiendo o reintentar si falta permiso o no se entiende el monto.

La política HTTP permite el micrófono solo al propio sitio (`microphone=(self)`); el permiso personal del navegador sigue siendo necesario. El límite de escucha comienza al abrirse el micrófono, después del aviso de permiso. Si no aparece un aviso y el acceso está bloqueado, abrir los controles del sitio junto a la dirección, permitir Micrófono y recargar. Si persiste, revisar los permisos del sistema operativo y abrir Cuadra directamente en Chrome o Edge. La aplicación no cambia esos permisos ni activa el micrófono al cargar la página.

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
- Confirmar límites, reintentos y condiciones comerciales de Pey para incorporar comercios de terceros. El esquema aísla comercios y usuarios; este piloto mantiene una API key por comercio y un comercio por usuario.
- Configurar correo de producción de Supabase y controles de abuso apropiados. Sus límites de autenticación se mantienen activos.

Links de pago, inventario avanzado, lectura por cámara, catálogos externos, reembolsos y administración multicomercio quedan fuera de esta entrega. El manifiesto de instalación se incluye; no hay caché offline de pagos ni promesa de confirmación sin conexión.

## Referencias

- [Pey OpenAPI](https://docs.pey.mx/openapi.json)
- [Configurar webhooks](https://docs.pey.mx/docs/tutorials/getting-started/set-up-webhooks/)
- [Activación de cuentas y pruebas](https://docs.pey.mx/docs/tutorials/getting-started/create-an-api-key/)
