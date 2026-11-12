# Despliegue y configuración

Orden recomendado: **Odoo → Hostinger → WooCommerce → prueba**. Cada paso corresponde a una subtarea de Notion.

---

## 1. Preparar Odoo (subtareas 1 y 2)

1. **Confirmar la versión de Odoo.** Define `ODOO_API`:
   - Odoo 19 o superior → `json2`
   - Odoo 18 o anterior → `jsonrpc`

   Si no está claro, prueba `json2`: un 404 en `/json/2/...` indica que hay que cambiar a `jsonrpc` (el error lo dice explícitamente).
2. **Usuario técnico** (ej. `integracion@ecolifescooters.com`) con permisos de Ventas, Contactos e Inventario (lectura de productos y stock).
3. **API key** de ese usuario: avatar → *Mi perfil / Preferencias* → *Seguridad de la cuenta* → *Nueva clave API*. Se muestra **una sola vez**: guárdala en el gestor de contraseñas, nunca en Notion ni en el repo.
4. **URL y base de datos.** En Odoo Online, la base suele ser el subdominio (`https://<base>.odoo.com`).
5. **SKU = Referencia interna** en cada producto y variante, idéntico al SKU de WooCommerce. Sin esto, el pedido no entra (pasa a `dead` con la lista de SKU que faltan).
6. **Productos de servicio:**
   - `ENVIO`: producto tipo servicio para los gastos de envío.
   - `CARGO`: solo si la web cobra cargos extra (*fees*).
   - Productos como la matrícula DGT o el taller: decidir si existen en Odoo.
7. **Impuestos:** la app envía precios **sin IVA**. Los productos en Odoo deben tener IVA 21 % **no incluido en el precio**. Si hay diferencias de céntimos con cantidades mayores que 1, sube la precisión decimal *Precio de producto* a 4.

## 2. Desplegar en Hostinger (subtarea 3)

1. Repo en GitHub (privado): `skLuan/syncApp-ecolifecooters`.
2. hPanel → **Websites → Add Website → Node.js Apps → Import Git Repository** → repo, rama `main`.
3. Build:

   | Ajuste | Valor |
   |---|---|
   | Build command | `npm run build` |
   | Entry file | `dist/server.js` |
   | Node | 22 |

   `typescript` y `@types/node` están en `dependencies` a propósito, para que el build funcione aunque Hostinger instale solo dependencias de producción.
4. Subdominio `sync.ecolifescooters.com` + SSL.
5. **Base de datos:** hPanel → Bases de datos → crear una MySQL y copiar host, usuario, contraseña y nombre a `DB_*`.
6. **Variables de entorno** (ver la tabla más abajo). Genera los secretos con:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
7. Desplegar y comprobar `https://sync.ecolifescooters.com/health` → `{"ok":true,"db":true}`. Las migraciones se aplican solas (`RUN_MIGRATIONS_ON_START=true`).

### Cron en hPanel

hPanel → **Avanzado → Cron Jobs** → cada 5 minutos, comando personalizado:

```bash
curl -s -X POST -H "Authorization: Bearer TU_JOBS_TOKEN" https://sync.ecolifescooters.com/jobs/run
```

Respuesta esperada: `{"ok":true,"orders":{...},"stock":{...}}`.

## 3. Configurar WooCommerce

**Claves REST:** *WooCommerce → Ajustes → Avanzado → REST API → Añadir clave*, con permiso **Lectura/Escritura**. Van en `WOO_CONSUMER_KEY` y `WOO_CONSUMER_SECRET`.

**Webhooks:** *WooCommerce → Ajustes → Avanzado → Webhooks → Añadir*. Crea dos:

| Nombre | Tema | URL de entrega |
|---|---|---|
| Odoo · pedido creado | Pedido creado | `https://sync.ecolifescooters.com/webhooks/woo` |
| Odoo · pedido actualizado | Pedido actualizado | `https://sync.ecolifescooters.com/webhooks/woo` |

Estado *Activo*, versión de API **v3**, y en **Secreto** el mismo valor que `WOO_WEBHOOK_SECRET`. Al guardar, WooCommerce envía un ping (`webhook_id=N`) que la app responde con 200.

## 4. Prueba antes de abrir el tráfico (subtarea 11)

Casos mínimos: pedido con Stripe, pedido con ViaBill, variante (vinilo) con cupón y envío, cliente nuevo y cliente existente, Odoo caído durante un pedido, 20 pedidos seguidos. Revisa cada uno en Odoo y en `GET /status`. Al terminar, borra los pedidos de prueba de Odoo.

---

## Referencia de variables de entorno

Validadas al arrancar (`src/config.ts`). Si falta una obligatoria, la app no arranca y dice cuál.

| Variable | Defecto | Notas |
|---|---|---|
| `NODE_ENV` | `development` | `production` en Hostinger |
| `PORT` | `3000` | Hostinger lo asigna |
| `LOG_LEVEL` | `info` | |
| `PUBLIC_URL` | `http://localhost:3000` | Informativo |
| `JOBS_TOKEN` | — | ≥ 16 caracteres. Para `/jobs/run` |
| `ADMIN_TOKEN` | — | ≥ 16 caracteres. Para `/status` y reintentos |
| `DB_HOST`, `DB_PORT` | `127.0.0.1`, `3306` | En local, `DB_PORT` también es el puerto publicado por Docker |
| `DB_USER`, `DB_PASSWORD`, `DB_NAME` | — | |
| `RUN_MIGRATIONS_ON_START` | `false` (`.env.example`: `true`) | Recomendado `true` en Hostinger |
| `WOO_URL` | — | `https://ecolifescooters.com` |
| `WOO_CONSUMER_KEY`, `WOO_CONSUMER_SECRET` | — | Lectura/Escritura |
| `WOO_WEBHOOK_SECRET` | — | ≥ 8 caracteres; igual al de los webhooks |
| `SYNC_ORDER_STATUSES` | vacío (`.env.example`: `processing,completed`) | **Obligatorio rellenarlo**: si está vacío, no se sincroniza nada |
| `WOO_VAT_META_KEYS` | vacío | Metas donde el checkout guarda el NIF |
| `TARGET` | `odoo` | Único valor hoy |
| `ODOO_URL`, `ODOO_DB`, `ODOO_LOGIN`, `ODOO_API_KEY` | — | Usuario técnico |
| `ODOO_API` | `json2` | `json2` (19+) o `jsonrpc` (≤ 18) |
| `ODOO_CONFIRM_ORDERS` | `false` | `true` = pedido confirmado; `false` = presupuesto |
| `ODOO_SHIPPING_PRODUCT_SKU` | `ENVIO` | |
| `ODOO_FEE_PRODUCT_SKU` | `CARGO` | |
| `ODOO_ORDER_REF_PREFIX` | `WEB-` | |
| `STOCK_SYNC_ENABLED` | `false` | Activar solo con `ODOO_CONFIRM_ORDERS=true` (ver [OPERACION.md](OPERACION.md#stock)) |
| `ODOO_STOCK_LOCATION_ID` | vacío | Vacío = todas las ubicaciones internas |
| `JOBS_BATCH_SIZE` | `20` | Jobs por ejecución de `/jobs/run` |
| `JOBS_TIME_BUDGET_MS` | `25000` | Tiempo máximo por ejecución |
| `JOBS_MAX_ATTEMPTS` | `5` | Antes de `dead` |
