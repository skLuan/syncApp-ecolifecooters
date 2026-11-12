# Arquitectura

## Contexto y objetivos

ecolifescooters.com vende en España con **WooCommerce** (WordPress + Elementor Pro + tema Bridge), cobra con **Stripe** y **ViaBill**, y el cliente quiere pasar más adelante a una pasarela de **BBVA**. El cliente compró **Odoo Online (SaaS), plan Custom** y quiere gestionar inventario, ventas y contabilidad desde Odoo.

La tienda se queda en WooCommerce (ver [DECISIONES.md](DECISIONES.md#d2)), así que hace falta llevar los pedidos a Odoo sin carga manual.

| Objetivo | Medida |
|---|---|
| Todo pedido pagado llega a Odoo sin intervención | 100 % (mínimo aceptable 98 %) |
| Sin pedidos duplicados ni perdidos | 0 y 0 |
| Pedido visible en Odoo poco después del pago | < 10 min (normalmente segundos) |
| El total en Odoo cuadra con lo cobrado | Diferencia ≤ 0,01 € |
| Sin costo extra para el cliente | Corre en el Hostinger Business existente |

**Restricción que manda en todo el diseño:** en Hostinger Business (compartido) la app Node se **detiene tras un periodo sin tráfico**. No puede haber timers ni workers en segundo plano. Todo trabajo lo dispara una petición HTTP: un webhook de WooCommerce o el cron de hPanel.

---

## Flujo de datos

### Pedido nuevo (camino normal)

```
1. Cliente paga en la web
2. WooCommerce ──POST /webhooks/woo (firma HMAC)──▶ app
3. app: verifica firma → filtra topic y estado → INSERT IGNORE en sync_jobs → responde 200
4. app (setImmediate, sin bloquear la respuesta): processor.run(5)
5. processor: claim → mapper Woo→modelo común → validación → adaptador Odoo
6. adaptador: idempotencia → productos por SKU → cliente → dirección → sale.order
              → (confirmar) → comprobar total
7. processor: guarda _odoo_id en el pedido de WooCommerce → sync_log → job "done"
```

### Si algo falla

```
Error temporal (Odoo caído, timeout, 5xx)  → job "failed", run_after = ahora + backoff
                                             5 min · 15 min · 1 h · 3 h · 6 h
Cron cada 5 min → POST /jobs/run           → vuelve a tomar los jobs listos
Tras JOBS_MAX_ATTEMPTS intentos            → "dead" + alerta
Error de datos (SKU inexistente, sin email) → "dead" directo + alerta, sin reintentar
```

### Stock (opcional, `STOCK_SYNC_ENABLED=true`)

En cada `/jobs/run`: lee de Odoo los `stock.quant` modificados desde el último cursor → lee `free_qty` de esos productos → busca cada SKU en WooCommerce (con caché en `id_map`) → actualiza en lotes (`/products/batch` y `/products/{padre}/variations/batch`) → guarda el cursor en `sync_state`. Solo toca stock, nunca precios.

---

## Componentes

| Capa | Archivo | Responsabilidad |
|---|---|---|
| Entrada | `src/server.ts` | Carga config, logger pino (con secretos ocultos), migraciones, arranca Fastify |
| Cableado | `src/container.ts` | Crea las piezas reales (pool, cola, stores, adaptador, cliente Woo, procesador) |
| Config | `src/config.ts` | Valida todas las variables de entorno con zod; falla al arrancar si falta algo |
| HTTP | `src/app.ts`, `src/http/` | Rutas, auth por bearer (comparación en tiempo constante), manejador de errores |
| Núcleo | `src/core/` | Modelo común, contrato `TargetAdapter`, procesador, cola, stores, validación, alertas |
| Fuente | `src/sources/woo/` | Firma HMAC, esquema zod del pedido, mapper al modelo común, cliente REST v3 |
| Destino | `src/targets/odoo/` | Transportes JSON-2 y JSON-RPC, adaptador Odoo |
| Trabajos | `src/jobs/stock-sync.ts` | Stock Odoo → WooCommerce |
| BD | `src/db/`, `migrations/` | Pool mysql2, migraciones SQL versionadas |

### Regla de dependencias

```
http ──▶ core ◀── sources/woo
              ◀── targets/odoo
container.ts es el único que conoce a todos.
```

`src/core/` **no importa nada** de `sources/` ni de `targets/`. El procesador recibe el mapper de WooCommerce inyectado (`parseOrder`) y el destino como `TargetAdapter`. Esto es lo que permite sumar Zoho sin tocar el núcleo.

### Modelo común (`src/core/model.ts`)

`Order`, `Customer`, `Address`, `OrderLine`, `ChargeLine`, `Payment`, `StockLevel`. Importes en euros (no céntimos), redondeados a 2 decimales. Las líneas llevan el total **sin IVA y con descuentos ya aplicados**, que es lo que WooCommerce expone en `line_items[].total`.

### Contrato de destino (`src/core/target.ts`)

```ts
interface TargetAdapter {
  readonly name: string;
  ping(): Promise<void>;
  upsertOrder(order: Order): Promise<UpsertResult>;   // DEBE ser idempotente
  fetchStockChanges?(since: Date): Promise<{ levels: StockLevel[]; cursor: Date }>;
}
```

### Errores

- `RetryableError`: temporal; se reintenta con backoff.
- `PermanentError`: de datos o credenciales; pasa a `dead` sin reintentar.
- Cualquier otro error se trata como temporal hasta agotar los intentos.

Los transportes de Odoo clasifican: 401/403, 404 de JSON-2 y excepciones `ValidationError`, `UserError`, `AccessError`, `AccessDenied`, `MissingError`, `ValueError`, `KeyError` y `TypeError` son permanentes. Red, 429 y 5xx son temporales.

---

## API de Odoo: dos transportes

| `ODOO_API` | Versión de Odoo | Llamada | Auth |
|---|---|---|---|
| `json2` (defecto) | 19+ | `POST /json/2/{modelo}/{método}` con parámetros nombrados; `ids` en el cuerpo | `Authorization: bearer <api key>` + `X-Odoo-Database` |
| `jsonrpc` | ≤ 18 | `POST /jsonrpc` → `execute_kw(db, uid, key, modelo, método, [ids], kwargs)` | `authenticate` una vez para obtener `uid` |

El adaptador siempre llama `call(modelo, método, params, ids?)` y no sabe cuál transporte usa. La API clásica está en proceso de retiro en las versiones nuevas de Odoo.

---

## Garantías anti-duplicados (tres capas)

1. **Cola:** `sync_jobs.dedupe_key` única = `woo:order:<id>:<estado>`. El mismo webhook repetido no se encola dos veces.
2. **`id_map`:** índice único `(entity, source, source_id, target)`. Si el pedido ya tiene ID en Odoo, `upsertOrder` devuelve `alreadyExisted` sin crear nada. Por eso un pedido que pasa de `processing` a `completed` genera un job nuevo, pero no un pedido nuevo.
3. **Odoo:** antes de crear, se busca `sale.order` por `client_order_ref = WEB-<número>`. Cubre el caso de que la app se caiga entre crear en Odoo y guardar el mapeo.

El mapeo se guarda **inmediatamente** después de crear el pedido, antes de confirmarlo o leer el total.

---

## Base de datos

MariaDB en Hostinger (MySQL 8 también sirve). Todas las fechas en UTC (`timezone: 'Z'`, `UTC_TIMESTAMP()`).

| Tabla | Para qué | Claves |
|---|---|---|
| `sync_jobs` | Cola | `uq(dedupe_key)`, `ix(status, run_after)`, `ix(entity_key)`, `ix(locked_by)` |
| `id_map` | Origen ↔ destino (pedidos, clientes, productos) | `uq(entity, source, source_id, target)` |
| `sync_log` | Historial para soporte | `ix(entity_key)`, `ix(created_at)` |
| `sync_state` | Clave/valor (cursor de stock `stock.cursor`) | PK `key` |
| `schema_migrations` | Migraciones aplicadas | PK `name` |

**Estados de un job:** `pending` → `running` → `done` | `failed` (espera reintento) | `dead` (necesita a una persona).

**Cómo se reserva un job sin `SKIP LOCKED`:** un `UPDATE … SET status='running', locked_by=<uuid>, attempts=attempts+1 … ORDER BY id LIMIT n` atómico, seguido de un `SELECT … WHERE locked_by=<uuid>`. Funciona en cualquier versión de MariaDB y MySQL. Si un proceso muere con el job en `running`, la reserva caduca a los 5 minutos y otro lo retoma. Probado con dos reservas simultáneas contra MariaDB 10.11.

`payload` es `LONGTEXT` con JSON serializado, porque el tipo `JSON` de MariaDB y el de MySQL se comportan distinto con mysql2.

---

## Mapeo WooCommerce → Odoo

| WooCommerce | Odoo |
|---|---|
| `number` | `sale.order.client_order_ref` = `WEB-<número>` (prefijo `ODOO_ORDER_REF_PREFIX`) · `origin` = `WooCommerce #<número>` |
| `date_created_gmt` | `date_order` (UTC, `YYYY-MM-DD HH:MM:SS`) |
| `billing.email` (en minúsculas) | `res.partner` buscado por email (`=ilike`, sin padre); se crea si no existe |
| `billing.*`, NIF (meta `_billing_nif`, `billing_nif`, `_billing_vat`, `billing_vat`) | Nombre, empresa, teléfono, `vat`, dirección, país. **Solo al crear**: nunca se sobrescriben datos editados en Odoo |
| `shipping.*` (si difiere de facturación) | Contacto hijo `type = delivery`; se reutiliza si ya existe con la misma calle y CP |
| `line_items[].sku` | `product_id` por **Referencia interna** (`default_code`) |
| `line_items[].total / quantity` | `price_unit` sin IVA, con cupones aplicados. Odoo aplica el impuesto del producto |
| `shipping_lines` | Línea con el producto `ENVIO` (`ODOO_SHIPPING_PRODUCT_SKU`) |
| `fee_lines` | Línea con el producto `CARGO` (`ODOO_FEE_PRODUCT_SKU`) |
| Pasarela, transacción, cupones, nota del cliente | Campo `note`, para la conciliación |
| — | De vuelta en WooCommerce: meta `_odoo_id` con el ID del `sale.order` |

Los cupones no generan línea propia, porque ya están descontados en el total de cada línea.

**Control de totales:** después de crear, se lee `amount_total`. Si difiere más de 0,01 € de lo cobrado, se escribe un aviso en `sync_log`, pero no se bloquea el pedido. Causas típicas: impuestos configurados como "incluidos" en Odoo, una línea sin IVA en WooCommerce cuyo producto en Odoo sí lo tiene, o redondeo de `price_unit` con cantidades mayores que 1.

---

## Seguridad

- Webhooks: HMAC-SHA256 en base64 sobre el **cuerpo crudo** (el scope de webhooks recibe el cuerpo como `Buffer`), comparado en tiempo constante.
- `/jobs/run` y `/status`: tokens bearer distintos (`JOBS_TOKEN`, `ADMIN_TOKEN`), de 16 caracteres como mínimo y comparados en tiempo constante.
- Logs: pino oculta `authorization` y `x-wc-webhook-signature`.
- Secretos solo en variables de entorno; `.env` está en `.gitignore`.
- Odoo: usuario técnico dedicado con permisos mínimos.
- Datos personales de clientes españoles: aplica el RGPD. Hace falta un contrato de encargado de tratamiento con el cliente (pendiente, no es técnico).

---

## Cómo añadir un destino (ej. Zoho Books)

1. `src/targets/zoho-books/adapter.ts` implementa `TargetAdapter`. `upsertOrder` tiene que ser idempotente (usa `id_map` y busca por referencia en el destino antes de crear).
2. Añadir `'zoho-books'` al enum `TARGET` en `src/config.ts`, con sus variables.
3. Añadir el `case` en `src/targets/index.ts`.
4. Tests con un transporte falso, siguiendo `test/odoo-adapter.test.ts`.

El núcleo, la cola, los webhooks y el panel no cambian. "Zoho" puede ser CRM, Books o Inventory: cada uno es un adaptador distinto.

### Hoja de ruta de escalabilidad

| Fase | Qué hay | Infraestructura |
|---|---|---|
| 0. Ahora | Ecolife: Woo → Odoo, una instancia | Hostinger Business |
| 1. Segundo cliente | Adaptador nuevo, una instancia por cliente | Hostinger (el plan admite varias apps Node) |
| 2. Tres o más clientes | Multi-cliente, panel, credenciales cifradas por cliente | VPS o cloud |
| 3. Servicio formal | Onboarding, monitoreo, SLA, facturación mensual | Según volumen |

Regla: no pasar de fase hasta que un cliente real la pague.
