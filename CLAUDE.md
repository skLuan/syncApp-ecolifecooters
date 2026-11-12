# CLAUDE.md

Instrucciones para trabajar en este repositorio con Claude Code.

## Qué es

`ecolife-sync`: app Node que lleva los pedidos pagados de WooCommerce (ecolifescooters.com, tienda en España) a **Odoo Online** (plan Custom, solo API externa) y, opcionalmente, devuelve el stock. Se despliega como Node.js App en **Hostinger Business compartido**, en `sync.ecolifescooters.com`. Agencia: The Lamb. Plazo: producción el 24 de noviembre de 2026, antes de Black Friday.

Antes de proponer cambios grandes, lee:
- [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md): flujo, componentes, BD y mapeo.
- [docs/DECISIONES.md](docs/DECISIONES.md): qué se descartó y por qué. **No vuelvas a proponer lo descartado** (plugin de WP, n8n/Make, migrar a Odoo.sh, eCommerce de Odoo) sin un hecho nuevo que cambie el contexto.
- [JOURNAL.md](JOURNAL.md): estado actual y próximos pasos.

## Comandos

```bash
npm run dev          # servidor local (requiere .env y `docker compose up -d`)
npm test             # vitest; sin red ni BD
npm run typecheck    # tsc --noEmit
npm run lint         # biome check .   (lint:fix para corregir)
npm run build        # tsc → dist/
npm run migrate      # migraciones a mano
```

**Antes de dar un cambio por terminado:** `npm run typecheck && npm run lint && npm test` en verde.

## Reglas de arquitectura (no romper)

1. **`src/core/` no importa nada de `src/sources/` ni de `src/targets/`.** El núcleo recibe el mapper (`parseOrder`) y el destino (`TargetAdapter`) por inyección. El único que conoce todas las piezas es `src/container.ts`.
2. **Sin trabajo en segundo plano.** Hostinger detiene la app tras la inactividad: nada de `setInterval`, workers ni colas en memoria. Todo trabajo lo dispara un webhook (`/webhooks/woo`) o el cron (`/jobs/run`). `setImmediate` justo después de responder un webhook está bien.
3. **`upsertOrder` debe ser idempotente.** Antes de crear: `id_map` → buscar en el destino por referencia. Guarda el mapeo **inmediatamente** después de crear, antes de cualquier otro paso.
4. **Clasifica los errores.** `PermanentError` para datos o credenciales (va a `dead` sin reintentar); `RetryableError` para red, 429 o 5xx. Nunca crees nada a medias: valida todo (SKU, cliente) antes del primer `create`.
5. **SQL compatible con MariaDB y MySQL.** Sin `SKIP LOCKED`, sin columnas `JSON` (usa `LONGTEXT` + `JSON.parse`), fechas en UTC con `UTC_TIMESTAMP()`. Los cambios de esquema van en una **nueva** migración `migrations/NNN_*.sql`; nunca edites una ya aplicada.
6. **La firma del webhook se calcula sobre el cuerpo crudo.** El scope de `webhooks.ts` recibe el cuerpo como `Buffer`; no lo cambies a un parser JSON.
7. **Secretos solo en variables de entorno.** Nunca en el código, los tests, los logs ni los commits. Si añades una variable: `src/config.ts` (zod) + `.env.example` + la tabla de `docs/DESPLIEGUE.md`.
8. **Odoo:** llamadas siempre con parámetros nombrados (`call(model, method, params, ids?)`), para que funcionen en JSON-2 y JSON-RPC. Precios sin IVA; no fijes impuestos de línea.

## Convenciones

- TypeScript estricto, ESM (`"type": "module"`): los imports relativos llevan `.js`.
- Identificadores en inglés; **comentarios, documentación, mensajes de log/error y commits en español**.
- Formato con Biome (comillas simples, punto y coma, 100 columnas).
- Commits estilo Conventional Commits en español: `fix(docker): …`, `feat(odoo): …`, con un cuerpo que explique el porqué.
- Tests: Vitest en `test/`, con dobles en memoria (`test/helpers.ts`) y transportes falsos. Nada de red ni de BD en los tests unitarios. Fixture de pedido real en `test/fixtures/woo-order.json`.
- Entorno de desarrollo: Windows + Docker (`C:\DockerWorkspace\syncApp-Ecolifescooters`). `npm install` debe hacerse en el mismo sistema operativo que ejecuta la app (Biome y esbuild traen binarios por plataforma).

## Documentación: mantenla al día

- **Al terminar una sesión de trabajo, añade una entrada a `JOURNAL.md`** (hecho / intentado o descartado / aprendido / siguiente). Incluye también lo que no funcionó.
- Nueva decisión de diseño → entrada en `docs/DECISIONES.md`. Si reemplaza otra, marca la vieja como "Reemplazada por Dn".
- Nuevo endpoint → tabla en `README.md`. Nuevo modo de fallo o procedimiento → `docs/OPERACION.md`. Cambio en el mapeo de campos → `docs/ARQUITECTURA.md`.

## Contexto del negocio

- Pasarelas: Stripe y ViaBill; en el futuro, BBVA (Redsys). El cobro siempre ocurre en WooCommerce; a Odoo llega el pedido pagado.
- WordPress con Elementor Pro y el tema Bridge, con plantillas de WooCommerce modificadas por un desarrollador anterior. Esta app **no toca** el WordPress: solo usa webhooks y la REST API.
- Seguimiento de tareas: Notion → *Ecolife Project* → *Instalar y configurar Node app integración* (13 subtareas).
- Datos personales de clientes de la UE: aplica el RGPD. No registres en los logs datos personales más allá de lo necesario.
