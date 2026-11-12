# ecolife-sync

Integración **WooCommerce → Odoo Online** para [ecolifescooters.com](https://ecolifescooters.com): una app Node propia que corre en un subdominio de Hostinger Business (`sync.ecolifescooters.com`).

- Cada pedido **pagado** de la web se crea en Odoo como pedido de venta, con su cliente, **una sola vez**.
- Opcional: el stock de Odoo vuelve a WooCommerce.
- Diseño **núcleo + adaptadores**: sumar Zoho u otro destino es añadir un adaptador, sin tocar el núcleo.

> **Estado (12 nov 2026):** esqueleto funcional y probado (29 tests, integración con MariaDB y prueba de punta a punta con Odoo y WooCommerce simulados). **Aún no está desplegado** ni conectado al Odoo real. Objetivo: en producción el **24 de noviembre**, antes de Black Friday. Ver [JOURNAL.md](JOURNAL.md).

---

## Arranque rápido (local)

Requisitos: Node 22 (`.nvmrc`) y Docker.

```bash
cp .env.example .env          # completa credenciales de prueba
docker compose up -d          # MariaDB local (publica ${DB_PORT:-3306})
npm install                   # en tu sistema operativo, no copies node_modules de otro
npm run dev                   # http://localhost:3000/health → {"ok":true,"db":true}
```

> Si `docker compose up -d` falla con `Bind for 0.0.0.0:3306 failed: port is already
> allocated`, ya hay otro MySQL/MariaDB ocupando el puerto. Pon `DB_PORT=3307` en `.env`
> y vuelve a levantar: compose publica ese puerto y la app se conecta al mismo.

| Comando | Qué hace |
|---|---|
| `npm run dev` | Servidor con recarga automática |
| `npm test` | Tests (no necesitan red ni base de datos) |
| `npm run lint` / `lint:fix` | Biome (formato + lint) |
| `npm run typecheck` | TypeScript sin compilar |
| `npm run build` | Compila a `dist/` |
| `npm run migrate` | Aplica migraciones a mano (también se aplican al arrancar) |

Para probar webhooks reales en local, expón el puerto con un túnel (ngrok, cloudflared) y crea un webhook de prueba en WooCommerce que apunte a él.

---

## Cómo funciona, en una imagen

```
WooCommerce ──webhook firmado──▶ POST /webhooks/woo ──▶ cola (MySQL)
                                                          │  procesa enseguida
Cron hPanel (cada 5 min) ──▶ POST /jobs/run ──────────────┤  + reintentos
                                                          ▼
                                    núcleo (modelo común) ──▶ adaptador Odoo ──▶ API de Odoo
                                                          ▲
                                    stock (opcional) ◀────┘
```

Hostinger detiene la app tras un rato sin tráfico, así que **no hay procesos en segundo plano**: todo lo dispara un webhook o el cron. Detalle completo en [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md).

## Endpoints

| Método | Ruta | Auth | Uso |
|---|---|---|---|
| GET | `/health` | — | Estado de la app y de la base de datos |
| POST | `/webhooks/woo` | Firma HMAC | Recibe pedidos de WooCommerce |
| POST | `/jobs/run` | `Bearer JOBS_TOKEN` | Cron: cola, reintentos y stock |
| GET | `/status` | `Bearer ADMIN_TOKEN` | Conteo por estado y últimos fallos |
| POST | `/jobs/:id/retry` | `Bearer ADMIN_TOKEN` | Reintento manual |

---

## Documentación

| Documento | Para qué |
|---|---|
| [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md) | Componentes, flujo de datos, base de datos, mapeo WooCommerce → Odoo, cómo añadir un destino |
| [docs/DESPLIEGUE.md](docs/DESPLIEGUE.md) | Requisitos en Odoo, despliegue en Hostinger, cron, webhooks, variables de entorno |
| [docs/OPERACION.md](docs/OPERACION.md) | Runbook: pedidos que no entran, apagar la sincronización, guardia de Black Friday |
| [docs/DECISIONES.md](docs/DECISIONES.md) | Por qué se hizo así (y qué se descartó) |
| [JOURNAL.md](JOURNAL.md) | Bitácora: qué se intentó y qué se hizo, por fecha |
| [CLAUDE.md](CLAUDE.md) | Instrucciones para trabajar en el repo con Claude Code |

**Seguimiento de tareas:** Notion → *The Lamb Studio* → *Ecolife Project* → [Instalar y configurar Node app integración](https://app.notion.com/p/40fa050d37e48185abe2daa5d41a5ee8) (spec completa y 13 subtareas).

## Estructura

```
src/
  server.ts            entrada (Hostinger: dist/server.js)
  app.ts               Fastify + registro de rutas
  container.ts         arma las piezas reales a partir de la config
  config.ts            variables de entorno validadas con zod
  core/                NO conoce WooCommerce ni Odoo
  sources/woo/         fuente WooCommerce: firma, esquema, mapper, cliente REST
  targets/odoo/        transporte JSON-2 / JSON-RPC + adaptador
  jobs/stock-sync.ts   stock Odoo → WooCommerce
  http/                rutas y auth
  db/                  pool y migraciones
migrations/            SQL versionado
test/                  vitest
docs/                  documentación
```
