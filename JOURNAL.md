# Journal

Bitácora del proyecto: qué se intentó, qué se hizo y qué se aprendió, en orden cronológico. **Añade una entrada al final cada vez que trabajes en el proyecto**, también cuando algo no funcione (es lo más útil para quien venga después).

Formato de cada entrada:

```
## AAAA-MM-DD — título corto
**Hecho:** …
**Intentado / descartado:** …
**Aprendido:** …
**Siguiente:** …
```

Las decisiones de diseño con más contexto están en [docs/DECISIONES.md](docs/DECISIONES.md).

---

## 2026-09-29 — Exploración: cómo integrar Odoo con WooCommerce

**Hecho:** inventario de las opciones de integración: conector de Odoo Apps, plugin del lado de WordPress, iPaaS (Zapier, Make, n8n), integración propia por API y CSV manual. Se aclaró la diferencia entre Odoo Online (SaaS), Odoo.sh y on-premise.

**Aprendido:**
- El cliente tiene **Odoo Online, plan Custom**. Casi seguro es Online y no Odoo.sh, que se contrata explícitamente y trae su propio panel. Para confirmarlo, mirar si la URL termina en `.odoo.com`.
- En Online **no se pueden instalar** módulos de terceros: los conectores de Odoo Apps quedan descartados.
- El plan Custom **sí incluye la API externa**, así que la integración desde fuera es viable.
- Pasar a Odoo.sh es posible, pero implica migrar la base, pagar hosting aparte y mantener código → descartado ([D1](docs/DECISIONES.md#d1)).

**Intentado / descartado:** comprar un conector de Odoo Apps (no instalable en Online).

**Siguiente:** elegir entre un plugin de WordPress, n8n/Make o un servicio propio.

## 2026-09-30 — Acceso a la API de Odoo

**Hecho:** se documentó cómo generar la API key: avatar → Mi perfil → Seguridad de la cuenta → Nueva clave API. Se muestra una sola vez.

**Aprendido:** conviene un **usuario técnico** dedicado con permisos mínimos, no la cuenta de una persona. Datos necesarios para conectar: URL, base de datos (el subdominio en Online), login y API key.

## 2026-10-22 — Restricciones reales y decisión de mantener WooCommerce

**Hecho:** se revisaron la web y el hosting.
- Hosting: **Hostinger Business compartido** (PHP y Node, sin VPS).
- La tienda vende en **España** con Stripe y ViaBill; el cliente quiere pasar a una pasarela de **BBVA**.
- Se decidió que **WooCommerce sigue siendo la tienda y Odoo el backoffice** ([D2](docs/DECISIONES.md#d2)).

**Intentado / descartado:**
- **Migrar la tienda al eCommerce de Odoo** (lo pedía el cliente): perdería ViaBill (sin conector y no instalable en Online) y bloquearía BBVA (Redsys no es nativo en Odoo). Solo Stripe es nativo.
- **n8n / Make:** sin VPS para autoalojar n8n y sin presupuesto para costos recurrentes ([D3](docs/DECISIONES.md#d3)).

**Aprendido:** las consideraciones colombianas de mensajes anteriores (DIAN, Wompi, PSE) **no aplican**: el cliente opera en España.

**Siguiente:** elegir entre un plugin de WordPress y una app Node propia en Hostinger.

## 2026-11-10 — Decisión de arquitectura, spec y esqueleto

**Hecho:**
- **App Node en lugar de plugin** ([D4](docs/DECISIONES.md#d4)): el esfuerzo es parecido, no se instala nada en el WordPress del cliente y es reutilizable si otro cliente pide Odoo o Zoho. Diseño núcleo + adaptadores ([D5](docs/DECISIONES.md#d5)) con una hoja de ruta de escalabilidad en 4 fases.
- **Spec (PRD) en Notion** en la tarea *Instalar y configurar Node app integración* (F1 Pre-Black Friday, P0), con 13 subtareas fechadas del 13 al 24 de noviembre.
- **Esqueleto completo:** TypeScript + Fastify 5 + mysql2 + zod 4 + pino, con Vitest y Biome.
  - Webhook con firma HMAC sobre el cuerpo crudo y respuesta al ping de WooCommerce.
  - Cola en MySQL con backoff (5 min → 6 h) y paso a `dead`.
  - Tres capas anti-duplicados (`dedupe_key`, `id_map`, búsqueda por `client_order_ref`).
  - Adaptador Odoo con transportes JSON-2 y JSON-RPC ([D6](docs/DECISIONES.md#d6)), control de totales y stock opcional.
  - `/status` y reintento manual.
- **Verificación:**
  - 29 tests unitarios.
  - Integración contra **MariaDB 10.11 real**: migraciones idempotentes, reservas simultáneas sin solaparse, recuperación de bloqueos caducados.
  - Prueba de punta a punta con la app compilada, un Odoo JSON-2 falso y un WooCommerce falso: webhook → pedido creado y confirmado → `_odoo_id` guardado en WooCommerce → sin duplicados → cron con token → stock.

**Intentado / descartado:**
- `SELECT … FOR UPDATE SKIP LOCKED` para la cola: descartado porque depende de la versión de MariaDB ([D7](docs/DECISIONES.md#d7)).
- Columna `JSON` para el payload: se usa `LONGTEXT` por las diferencias entre MariaDB y MySQL.
- Fijar el impuesto en la línea del pedido: el nombre del campo cambió entre versiones de Odoo; se deja que Odoo use el del producto ([D8](docs/DECISIONES.md#d8)).
- `typescript` como devDependency: se movió a `dependencies` por si Hostinger instala solo producción durante el build.

**Aprendido:**
- En un mock de `fetch`, no se puede reutilizar el mismo objeto `Response` (el cuerpo solo se lee una vez): hay que usar `mockImplementation` que cree uno nuevo en cada llamada.
- Biome 2.6 cambió la clave de configuración `recommended` a `preset`; se corrige con `biome migrate --write`.
- El stock con `free_qty` solo es fiable si los pedidos se **confirman** en Odoo; con presupuestos no hay reserva.

**Siguiente:** subtareas 1 (accesos y decisiones), 2 (auditoría de SKUs) y 3 (subdominio en Hostinger).

## 2026-11-11 — Repositorio en GitHub

**Hecho:** se subió el código a `github.com/skLuan/syncApp-ecolifecooters` (commits `787d074` y `73ebffb`).

## 2026-11-12 — Puerto de MariaDB configurable y documentación

**Hecho:**
- **PR #1** (`7532ee9`): `docker compose up -d` fallaba con `Bind for 0.0.0.0:3306 failed: port is already allocated` porque otro MySQL/MariaDB local ya usaba el 3306. Ahora el puerto publicado sale de `${DB_PORT:-3306}`. Compose y `dotenv` leen el mismo `.env`, así que `DB_PORT=3307` mueve a la vez el puerto publicado y el de conexión. También se invirtió el orden del arranque: crear `.env` antes del `up`.
- **Documentación:**
  - `README.md` reorganizado como punto de entrada.
  - Nuevos en `docs/`: `ARQUITECTURA.md`, `DESPLIEGUE.md` (con la referencia de variables), `OPERACION.md` (runbook y guardia de Black Friday) y `DECISIONES.md` (D1–D10).
  - `CLAUDE.md` y este journal.
  - `.claude/worktrees/` añadido a `.gitignore`.

**Aprendido:** `SYNC_ORDER_STATUSES` vacío significa que no se sincroniza ningún pedido. Hay que rellenarlo siempre (`processing,completed`).

**Siguiente:** las mismas subtareas 1–3. Preguntas abiertas bloqueantes:
- ¿Versión de Odoo (y por tanto `ODOO_API`)?
- ¿El pedido entra como presupuesto o confirmado (`ODOO_CONFIRM_ORDERS`)?
- ¿Qué estado de WooCommerce dispara el envío? Propuesta: *Procesando*.
- ¿Existen en Odoo los productos de servicio (envío, matrícula DGT, taller)?
