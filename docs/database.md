# Base de datos de Caja CoDi

Ejecuta `supabase/migrations/202611070001_initial.sql` en el SQL Editor de un proyecto Supabase nuevo. La migración es transaccional; no debe aplicarse dos veces. No contiene claves ni datos bancarios.

## Alta del primer comercio

1. Crea el usuario del dueño en Supabase Auth (o completa su primer acceso con enlace mágico).
2. Copia su UUID desde Authentication → Users.
3. En SQL Editor inserta el comercio, sustituyendo los valores de ejemplo:

```sql
insert into public.merchants (owner_user_id, name, pey_api_key_id)
values ('UUID_DEL_USUARIO', 'Mi negocio', 'ID_PUBLICO_DE_API_KEY_EN_PEY');
```

`pey_api_key_id` es el identificador que Pey envía en `apiKeyId`; **no es la API key secreta**. Este MVP permite un comercio por usuario y una API key identificada por comercio. No activar altas públicas de comercios antes de implementar onboarding y asignación de cuentas.

## Contratos del servidor

Solo `service_role` puede ejecutar estas funciones. El servidor debe obtener el usuario mediante una sesión Supabase validada (`getUser`), nunca aceptar `owner_user_id` del navegador.

| RPC | Parámetros | Resultado |
| --- | --- | --- |
| `reserve_charge` | `p_merchant_id uuid`, `p_owner_user_id uuid`, `p_amount_cents integer`, `p_concept text`, `p_idempotency_key uuid` | Fila de `charges`. Repetir la clave devuelve la misma fila; cambiar monto/concepto genera conflicto. |
| `claim_charge_creation` | `p_charge_id uuid` | Fila si consiguió reclamar la llamada a Pey; fila nula si ya se reclamó o no está en `creating`. |
| `finalize_charge` | `p_charge_id uuid`, `p_pey_ref text`, `p_qr_string text` | Fila con QR y estado `pending`. |
| `cancel_charge` | `p_charge_id uuid`, `p_owner_user_id uuid` | Fila cancelada; solo cobros sin pago y pendientes/vencidos. |
| `process_pey_payment` | `p_webhook_id text`, `p_payload jsonb`, `p_pey_api_key_id text`, `p_pey_ref text`, `p_transaction_id text`, `p_amount_cents integer`, `p_paid_at timestamptz` | JSON con `outcome`, `retry`, y cuando corresponde `charge_id`. |
| `daily_corte` | `p_merchant_id uuid`, `p_owner_user_id uuid`, `p_date date` | JSON con `date`, `timezone`, `total_paid_cents`, `paid_count`, `review_receipt_count`, `review_amount_cents`, `pending_count`. Valida el dueño antes de agregar. |

### Creación segura

`reserve_charge` serializa las operaciones por comercio, aplica máximo de monto y diez creaciones por minuto, asigna referencia numérica de 1–7 dígitos y persiste antes de llamar al proveedor. Una referencia agotada genera `reference_exhausted`; no se recicla silenciosamente.

Después de reservar, llama `claim_charge_creation`. Solo el ganador hace POST a Pey. Si otro request obtiene la fila existente `pending`, devuelve su QR almacenado. Si está en `creating` con claim previo, devuelve un estado en preparación; no vuelve a hacer POST a Pey. Un timeout de Pey es ambiguo: no significa que Pey no creó el QR. Se requiere conciliación manual antes de reintentar; todavía no existe un proceso automático para esa situación.

`expires_at` se asigna al reservar con diez minutos, de forma conservadora frente a la latencia del proveedor. Puede mostrarse vencido al consultar sin ejecutar una escritura desde el navegador.

El reloj comienza antes del POST a Pey: si Pey crea el QR quince segundos después, la caja puede dejar de mostrarlo quince segundos antes de su vencimiento real. Se elige esta diferencia conservadora para no prometer validez más allá de lo conocido; no se reinicia el reloj al finalizar, porque el timeout o latencia de respuesta tampoco prueba el instante exacto de creación. Cualquier pago posterior sigue entrando como tardío y queda registrado. Para alinear ambos relojes con precisión se necesita que Pey devuelva la fecha de vencimiento efectiva.

### Recepción segura

La ruta verifica Standard Webhooks **sobre el cuerpo original** antes de llamar `process_pey_payment`. El payload almacenado debe limitarse a campos de pago necesarios; excluir CLABE, nombres del pagador y metadata personal. La base no puede demostrar por sí sola que el servidor verificó la firma: la clave de servicio es una credencial altamente privilegiada.

La función persiste el evento, bloquea el cobro y registra recibo, estado y bitácora en la misma transacción. Un fallo SQL revierte toda la operación y el webhook debe recibir respuesta de error para reintentar. Un evento desconocido permanece recibido pero sin procesar y devuelve `{"outcome":"unmatched","retry":true}`; esto permite reintentarlo cuando el QR ya se haya asociado al cobro. No responder éxito ni ignorarlo únicamente porque el ID del evento exista.

Si el POST a Pey sí creó el QR pero su respuesta o la escritura de finalización fallaron, el webhook firmado puede recuperar la asociación. Se exige `type = codi.qr.payment_received`, `numRef` numérico exacto de 1–7 dígitos, comercio con el mismo `apiKeyId`, `pey_ref IS NULL` y `provider_requested_at IS NOT NULL`. La fila se bloquea, se vincula el identificador recibido y se ejecutan las mismas verificaciones de monto/transacción. Las referencias nunca se reutilizan por comercio. No se usan heurísticas de monto ni hora. Una referencia de proveedor existente jamás se sustituye; cada recuperación genera bitácora. Esto permite confirmar un pago recuperado aunque no se haya podido almacenar `qr_string`; no permite reconstruir un QR no pagado.

- `paid`, `paid_late`: monto exacto y primer pago confirmado.
- `review`: monto distinto o pago adicional; se conserva el recibo real, sin anunciar un pago normal.
- `duplicate`, `duplicate_transaction`: evento o transacción ya procesados; sin sumar otra vez.
- `transaction_conflict`: mismo ID de transacción con datos incompatibles; requiere investigar la bitácora, no crear otro recibo.
- `unmatched`: no coincide referencia + identificador de API key; reintentar y alertar si persiste.

Un pago tras cancelación/vencimiento se conserva con `late_payment = true`. Cancelar localmente no revoca el QR en el banco. Una segunda transacción distinta nunca sobrescribe el folio de la primera: queda en `payment_receipts` y el cobro pasa a revisión.

## Historial y corte

Las tablas tienen RLS; el dueño puede leer solo su comercio. El navegador no tiene privilegios de escritura, ni acceso a `webhook_events`. Los endpoints con cliente administrativo deben restringir siempre `merchant_id`; RLS no protege llamadas con `service_role`.

El corte confirmado se calcula con `daily_corte` directamente sobre `payment_receipts`, filtrando `needs_review = false` y `paid_at` dentro del día de `America/Mexico_City`. No se agrega desde el estado mutable de `charges`: si un segundo pago pone un cobro en revisión, su primer recibo válido continúa incluido en el corte. Los recibos en revisión se cuentan y suman por separado; no deben ocultarse como si el dinero no hubiera llegado. La función devuelve ceros cuando no hay recibos. No sumar los montos de cobros pendientes al dinero recibido.

`pending_count` refleja únicamente solicitudes creadas en el día seleccionado, con estado `pending`, sin pago y todavía vigentes (`expires_at > now()`). Es una fotografía al consultar: un corte de ayer no reconstruye cuántas solicitudes estaban pendientes ayer. El resumen de recibos no reemplaza la conciliación bancaria. El endpoint llama esta RPC con el usuario validado por Supabase, nunca con un UUID de dueño suministrado por el navegador.

## Antes de abrir a clientes

Validar la migración en Supabase y probar dos usuarios aislados, webhook duplicado concurrente, monto distinto, pago tardío, dos pagos del mismo QR y recuperación de evento recibido antes de `finalize_charge`. Implementar alertas/reconciliación, retención de eventos, backups y monitor de cobros atascados en `creating`. No hay empleados ni alta multicomercio automática en esta migración.

## Prueba SQL incluida

En un proyecto de pruebas, después de la migración, ejecuta `supabase/tests/payment_flow.sql` como administrador. Inserta dos usuarios temporales y sus comercios, prueba idempotencia, claim único, webhook anterior al QR, transacción repetida/conflictiva, montos distintos, pago adicional, cancelación/vencimiento, recuperación estricta por referencia firmada (incluidos rechazos por falta de claim, referencia/API key incorrectas y sustitución de referencia existente), corte basado en recibos y pendientes vigentes, aislamiento RLS y bloqueo de escritura/RPC desde el rol del navegador. Todo termina con `ROLLBACK`; cualquier fallo lanza excepción.

La migración y esta prueba pasaron localmente en PostgreSQL mediante PGlite, con roles `anon`, `authenticated`, `service_role BYPASSRLS` y stubs mínimos de `auth.users`/`auth.uid()`. También se verificó que el rollback no dejó usuarios, comercios ni cobros. Esto valida sintaxis SQL, funciones y permisos bajo esos stubs; no sustituye la ejecución en Supabase real. No prueba PostgREST, autenticación por cookies, firma HTTP ni concurrencia entre conexiones.
