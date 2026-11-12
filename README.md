# ecolife-sync

Integración **WooCommerce → Odoo Online** para ecolifescooters.com, en una app Node propia, desplegada en un subdominio de Hostinger Business (`sync.ecolifescooters.com`).

- Cada pedido pagado de la web se crea en Odoo como pedido de venta (con su cliente), **una sola vez**.
- Opcional: el stock de Odoo vuelve a WooCommerce.
- Arquitectura **núcleo + adaptadores**: sumar Zoho u otro destino es añadir un adaptador, sin tocar el núcleo.

Spec y tareas: Notion → *Ecolife Project* → **Instalar y configurar Node app integración**.

---

## Cómo funciona

```
WooCommerce ──webhook firmado──▶ POST /webhooks/woo ──▶ cola (MySQL)
                                                          │  procesa enseguida
Cron hPanel (cada 5 min) ──▶ POST /jobs/run ──────────────┤  + reintentos
                                                          ▼
                                    núcleo (modelo común) ──▶ adaptador Odoo ──▶ API de Odoo
                                                          ▲
                                    stock (opcional) ◀────┘
```

**Restricción de Hostinger:** la app se detiene tras un rato sin tráfico. No hay procesos en segundo plano: todo lo dispara un webhook o el cron. Por eso existe `/jobs/run`.

**Garantías**

| Riesgo | Cómo se evita |
|---|---|
| Webhook falso | Firma HMAC-SHA256 verificada sobre el cuerpo crudo (`X-WC-Webhook-Signature`) |
| Pedido duplicado | 1) cola con `dedupe_key` única (pedido + estado) · 2) tabla `id_map` · 3) búsqueda en Odoo por `client_order_ref` antes de crear |
| Odoo caído | El job queda en `failed` y se reintenta: 5 min, 15 min, 1 h, 3 h, 6 h. Tras `JOBS_MAX_ATTEMPTS` pasa a `dead` |
| Dato incorrecto (SKU inexistente) | Error permanente: no crea nada a medias, pasa a `dead` y genera alerta |
| Total distinto al cobrado | Aviso en `sync_log` si Odoo y WooCommerce difieren más de 0,01 € |

---

## Estructura

```
src/
  server.ts            entrada (Hostinger: dist/server.js)
  app.ts               Fastify + rutas
  container.ts         arma las piezas reales a partir de la config
  config.ts            variables de entorno validadas (zod)
  core/                NO conoce WooCommerce ni Odoo
    model.ts           modelo común: Order, Customer, StockLevel…
    target.ts          contrato TargetAdapter que cumple cada destino
    processor.ts       procesa la cola: reintentos, dead, alertas
    queue.ts           cola sobre MySQL/MariaDB
    store.ts           id_map, sync_log, sync_state
    validate.ts        reglas comunes (SKU obligatorio…)
    notifier.ts        alertas (hoy: log · TODO: email)
  sources/woo/         fuente WooCommerce: firma, esquema, mapper, cliente REST
  targets/
    index.ts           registro de destinos (TARGET=odoo)
    odoo/              transporte JSON-2 / JSON-RPC + adaptador
  jobs/stock-sync.ts   stock Odoo → WooCommerce
  http/                rutas y auth
  db/                  pool y migraciones
migrations/            SQL versionado (se aplica solo al arrancar)
test/                  vitest (sin red ni base de datos)
```

---

## Desarrollo local

Requisitos: Node 22 (ver `.nvmrc`) y Docker.

```bash
cp .env.example .env          # y completa credenciales de prueba
docker compose up -d          # MariaDB local (publica ${DB_PORT:-3306})
npm install
npm run dev                   # http://localhost:3000/health
```

> Si `docker compose up -d` falla con `Bind for 0.0.0.0:3306 failed: port is already
> allocated`, ya hay otro MySQL/MariaDB ocupando el puerto. Pon `DB_PORT=3307` en `.env`
> y vuelve a levantar: compose publica ese puerto y la app se conecta al mismo.

| Comando | Qué hace |
|---|---|
| `npm run dev` | Servidor con recarga automática |
| `npm test` | Tests |
| `npm run lint` / `lint:fix` | Biome (formato + lint) |
| `npm run typecheck` | TypeScript sin compilar |
| `npm run build` | Compila a `dist/` |
| `npm run migrate` | Aplica migraciones a mano |

Para probar webhooks reales en local: exponer el puerto con un túnel (ngrok, cloudflared) y crear un webhook de prueba en WooCommerce apuntando a él.

---

## Requisitos en Odoo (antes de activar)

1. **Versión de Odoo** → define `ODOO_API`: `json2` para Odoo 19+, `jsonrpc` para 18 o anterior.
2. **Usuario técnico** (ej. `integracion@ecolifescooters.com`) con permisos de Ventas, Contactos e Inventario. Generar su API key en *Preferencias → Seguridad de la cuenta → Nueva clave API*.
3. **SKU = Referencia interna** en cada producto y variante. Si falta uno, el pedido no entra y se alerta.
4. **Producto de servicio "Envío"** con referencia interna `ENVIO` (o la de `ODOO_SHIPPING_PRODUCT_SKU`). Igual para cargos extra (`CARGO`) si se usan.
5. **Impuestos**: la app envía precios **sin IVA**; Odoo aplica el impuesto del producto (IVA 21 % *no incluido en el precio*). Si los impuestos de Odoo están configurados como "incluidos", los totales no cuadrarán (verás el aviso en `sync_log`).
6. Si hay diferencias de céntimos por cantidades > 1, subir la precisión decimal *Precio de producto* a 4 en Odoo.

---

## Despliegue en Hostinger (subtarea 3)

1. Subir este repo a GitHub (privado).
2. hPanel → **Websites → Add Website → Node.js Apps → Import Git Repository** → elegir el repo, rama `main`.
3. Ajustes de build:
   - Build command: `npm run build`
   - Entry file: `dist/server.js`
   - Node: 22
4. Asignar el subdominio `sync.ecolifescooters.com` y activar SSL.
5. **Base de datos**: hPanel → Bases de datos → crear MySQL. Copiar host, usuario, contraseña y nombre a las variables `DB_*`.
6. **Variables de entorno**: cargar todas las de `.env.example` en la configuración de la Web App. Generar `JOBS_TOKEN`, `ADMIN_TOKEN` y `WOO_WEBHOOK_SECRET` largos y aleatorios, por ejemplo:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
7. Desplegar y comprobar: `https://sync.ecolifescooters.com/health` → `{"ok":true,"db":true}`. Las migraciones se aplican solas al arrancar (`RUN_MIGRATIONS_ON_START=true`).

> `typescript` y `@types/node` están en `dependencies` a propósito: así el build funciona aunque Hostinger instale solo dependencias de producción.

### Cron en hPanel

hPanel → **Avanzado → Cron Jobs** → cada 5 minutos, comando personalizado:

```bash
curl -s -X POST -H "Authorization: Bearer TU_JOBS_TOKEN" https://sync.ecolifescooters.com/jobs/run
```

### Webhooks en WooCommerce

WooCommerce → **Ajustes → Avanzado → Webhooks → Añadir**. Crear dos:

| Nombre | Tema | URL de entrega |
|---|---|---|
| Odoo · pedido creado | Pedido creado | `https://sync.ecolifescooters.com/webhooks/woo` |
| Odoo · pedido actualizado | Pedido actualizado | `https://sync.ecolifescooters.com/webhooks/woo` |

Estado *Activo*, versión API **v3**, y en **Secreto** el mismo valor que `WOO_WEBHOOK_SECRET`.

Las claves REST (`WOO_CONSUMER_KEY/SECRET`) se crean en *Ajustes → Avanzado → REST API* con permiso **Lectura/Escritura**.

---

## Endpoints

| Método | Ruta | Auth | Uso |
|---|---|---|---|
| GET | `/health` | — | Estado de la app y de la base de datos |
| POST | `/webhooks/woo` | Firma HMAC | Recibe pedidos de WooCommerce |
| POST | `/jobs/run` | `Bearer JOBS_TOKEN` | Cron: procesa cola, reintentos y stock |
| GET | `/status` | `Bearer ADMIN_TOKEN` | Conteo por estado y últimos fallos |
| POST | `/jobs/:id/retry` | `Bearer ADMIN_TOKEN` | Reintento manual |

---

## Operación (runbook corto)

**Un pedido no aparece en Odoo**
1. `GET /status` con el token de admin → buscar `order:<id de WooCommerce>` en `problems`.
2. Leer `error`. Lo más habitual: *SKU no encontrado* → crear o corregir el SKU en Odoo.
3. `POST /jobs/<id>/retry`.
4. Historial completo en la tabla `sync_log` (filtrar por `entity_key = 'order:<id>'`).

**Apagar la sincronización (plan de vuelta atrás)**
Desactivar los dos webhooks en WooCommerce. La tienda sigue vendiendo con normalidad; los pedidos se pueden cargar después reactivando los webhooks y reenviándolos, o a mano.

**Rotar credenciales**
Generar la nueva clave (Odoo o WooCommerce), actualizar la variable en hPanel, redesplegar y revocar la anterior.

---

## Mapeo WooCommerce → Odoo

| WooCommerce | Odoo (`sale.order`) |
|---|---|
| `number` | `client_order_ref` = `WEB-<número>` · `origin` = `WooCommerce #<número>` |
| `date_created_gmt` | `date_order` |
| `billing.email` | Cliente (`res.partner`) buscado por email; se crea si no existe |
| `billing.*`, NIF (meta `_billing_nif`…) | Datos del cliente (solo al crearlo; nunca se sobrescriben datos editados en Odoo) |
| `shipping.*` (si difiere) | Dirección de entrega (`type = delivery`) |
| `line_items[].sku` | `product_id` por Referencia interna |
| `line_items[].total / quantity` | `price_unit` (sin IVA, con descuentos aplicados) |
| `shipping_lines` | Línea con el producto `ENVIO` |
| `fee_lines` | Línea con el producto `CARGO` |
| `payment_method`, `transaction_id`, cupones, nota | `note` del pedido (para conciliación) |
| — | ID de Odoo guardado en el pedido de WooCommerce como meta `_odoo_id` |

---

## Añadir un destino nuevo (ej. Zoho Books)

1. Crear `src/targets/zoho-books/adapter.ts` que implemente `TargetAdapter` (`ping`, `upsertOrder` idempotente y, si aplica, `fetchStockChanges`).
2. Añadir `'zoho-books'` al enum `TARGET` en `config.ts` y sus variables.
3. Añadir el `case` en `src/targets/index.ts`.
4. Tests con un transporte falso, como `test/odoo-adapter.test.ts`.

El núcleo, la cola, los webhooks y el panel no cambian.

---

## Pendientes conocidos

- **Alertas por email** (subtarea 10): hoy `LogNotifier` solo escribe en el log. Implementar `EmailNotifier` con el SMTP de Hostinger.
- **Stock** (subtarea 9, desactivado por defecto):
  - Usa `free_qty` (disponible = a mano − reservado). Si los pedidos entran en Odoo como **presupuesto** (`ODOO_CONFIRM_ORDERS=false`), Odoo no reserva y el stock de la web podría subir de nuevo tras una venta. Activar el stock **solo con pedidos confirmados**.
  - Validar en la tienda real que `GET /products?sku=` devuelve también variaciones (vinilos). Si no, construir un índice SKU→id.
  - Los quants que Odoo borra al llegar a 0 no se detectan como cambio. Añadir una sincronización completa nocturna.
- **Cancelaciones y reembolsos**: v1 no los replica (se gestionan a mano en Odoo).
- **Pedidos históricos**: no se importan; solo entran los pedidos a partir de la activación.
- **Pasarelas → diarios de Odoo**: hoy la pasarela va en la nota; mapear Stripe / ViaBill / BBVA a diarios cuando se automatice el registro de pagos.
