# Operación (runbook)

Para quien esté de guardia o reciba una queja del tipo "este pedido no está en Odoo".

**Accesos necesarios:** `ADMIN_TOKEN`, hPanel de Hostinger (logs de la app y phpMyAdmin), admin de WordPress/WooCommerce y Odoo.

Para no repetir el token en cada comando:

```bash
export SYNC=https://sync.ecolifescooters.com
export ADMIN="Authorization: Bearer <ADMIN_TOKEN>"
```

---

## Chequeo rápido

```bash
curl -s $SYNC/health                 # {"ok":true,"db":true,...}
curl -s -H "$ADMIN" $SYNC/status     # counts + problems
```

| Señal | Qué significa | Acción |
|---|---|---|
| `/health` → 503, `db:false` | La base de datos no responde | Revisar la BD en hPanel |
| `counts.dead > 0` | Pedidos que necesitan a una persona | [Pedido en `dead`](#pedido-en-dead) |
| `counts.failed` crece | Odoo o WooCommerce fallan temporalmente | Esperar a los reintentos. Si dura más de 1 h, revisar el estado de Odoo y las credenciales |
| `counts.pending` crece y no baja | El cron no corre | [Cron parado](#cron-parado) |
| El pedido no aparece en ninguna cuenta | El webhook no llegó | [Webhook no llega](#webhook-no-llega) |

---

## Pedido en `dead`

1. `GET /status` → busca `order:<id de WooCommerce>` en `problems` y lee `error`.
2. Según el error:

   | Error | Arreglo |
   |---|---|
   | `SKU no encontrado en Odoo: X` | Crear el producto o corregir su Referencia interna en Odoo |
   | `productos sin SKU en WooCommerce` | Poner el SKU en el producto o variante de WooCommerce. **Ojo:** el job lleva el pedido tal como llegó; hay que reenviar el webhook (paso 4) |
   | `sin email de facturación` | Corregir el pedido en WooCommerce y reenviar |
   | `Odoo rechazó las credenciales` | API key revocada o caducada → [Rotar credenciales](#rotar-credenciales) |
   | `Odoo 404 en /json/2/...` | La versión de Odoo es anterior a la 19 → `ODOO_API=jsonrpc` |
   | `Odoo ValidationError/UserError: …` | Leer el mensaje: casi siempre es un dato obligatorio o una regla de Odoo |

3. Reintentar: `curl -s -X POST -H "$ADMIN" $SYNC/jobs/<id>/retry`. Se procesa en el siguiente cron (≤ 5 min) o al llegar otro webhook.
4. Si el error estaba en los datos del pedido, el reintento usa la copia antigua. En ese caso, en el admin de WooCommerce cambia el estado del pedido (por ejemplo, de *Procesando* a *Completado*): eso dispara un webhook nuevo con los datos actuales.

Historial completo del pedido (phpMyAdmin):

```sql
SELECT created_at, level, message FROM sync_log
WHERE entity_key = 'order:<id>' ORDER BY id;
```

## Total distinto entre Odoo y WooCommerce

Aparece como `warn` en `sync_log` (`Total distinto: Odoo X vs WooCommerce Y`). El pedido **sí se creó**. Revisa los impuestos del producto en Odoo (deben ser "no incluidos") y corrige el pedido en Odoo a mano. Si se repite, ver la nota de impuestos en [DESPLIEGUE.md](DESPLIEGUE.md#1-preparar-odoo-subtareas-1-y-2).

## Webhook no llega

1. WooCommerce → *Ajustes → Avanzado → Webhooks*: el estado debe ser *Activo*. WooCommerce **desactiva el webhook solo** tras varias entregas fallidas seguidas.
2. Abre el webhook y revisa los registros de entrega: el código de respuesta y el cuerpo.
3. Un 401 significa que el secreto no coincide con `WOO_WEBHOOK_SECRET`.
4. Si estaba desactivado: reactivarlo y, para los pedidos perdidos, cambiar su estado en WooCommerce (dispara el webhook) o cargarlos a mano.

## Cron parado

hPanel → *Cron Jobs*: comprobar que el comando existe y que el token es el actual. Prueba manual:

```bash
curl -s -X POST -H "Authorization: Bearer <JOBS_TOKEN>" $SYNC/jobs/run
```

## Stock

- Solo funciona si `STOCK_SYNC_ENABLED=true`. El resultado aparece en la respuesta de `/jobs/run` (`stock.updated`, `stock.notInWoo`).
- **No activar con `ODOO_CONFIRM_ORDERS=false`.** Odoo solo reserva stock al confirmar el pedido. Con presupuestos, el `free_qty` de Odoo no descuenta las ventas web y la tienda volvería a mostrar como disponibles unidades ya vendidas.
- SKU en `notInWoo`: existen en Odoo con stock pero no en WooCommerce. Normalmente no pasa nada.
- Para forzar una resincronización desde una fecha:
  ```sql
  UPDATE sync_state SET value = '2026-11-20T00:00:00.000Z' WHERE `key` = 'stock.cursor';
  ```

---

## Apagar la sincronización (vuelta atrás)

Si la integración está causando problemas en plena venta:

1. WooCommerce → desactiva los dos webhooks. **La tienda sigue vendiendo con normalidad**: el cobro no depende de esta app.
2. (Opcional) Pausa el cron en hPanel.
3. Después: corrige el problema, reactiva los webhooks y carga los pedidos del periodo (cambiándoles el estado para que se reenvíen, o a mano). Los anti-duplicados evitan crear dos veces los que ya entraron.

## Rotar credenciales

1. Genera la nueva credencial (API key de Odoo, claves REST de WooCommerce o token propio).
2. Actualiza la variable en hPanel y redespliega.
3. Comprueba `/health` y lanza un `/jobs/run`.
4. Revoca la credencial anterior.

Si cambias `WOO_WEBHOOK_SECRET`, actualízalo también en los dos webhooks de WooCommerce.

---

## Guardia de Black Friday (27–30 nov 2026)

- **24 nov, salida a producción:** revisa uno por uno los primeros 10 pedidos reales en Odoo (cliente, líneas, envío, total, nota con la pasarela).
- **Cada mañana del 27 al 30:** `GET /status` → `dead = 0` y `failed` sin acumularse. Revisa los `warn` del día:
  ```sql
  SELECT created_at, entity_key, message FROM sync_log
  WHERE level <> 'info' AND created_at > UTC_TIMESTAMP() - INTERVAL 1 DAY ORDER BY id;
  ```
- **Meta:** 0 pedidos perdidos y 0 duplicados.
- **Escalado:** pedidos en `dead` → equipo The Lamb (responsable técnico de la integración). Problemas de datos en Odoo (productos, impuestos) → responsable de la configuración de Odoo. Pagos y conciliación → contabilidad.

> Las alertas por email aún no existen (subtarea 10): hoy un `dead` solo queda en el log de la app y en `/status`. Mientras no estén, la revisión manual de `/status` es obligatoria.
