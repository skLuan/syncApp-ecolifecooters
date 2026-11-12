# Decisiones

Registro de decisiones de diseño: contexto, alternativas y consecuencias. Las más recientes van al final. Si una decisión cambia, no se borra: se marca como **reemplazada** y se añade la nueva.

| # | Decisión | Fecha | Estado |
|---|---|---|---|
| D1 | Seguir en Odoo Online; no migrar a Odoo.sh | 2026-09-29 | Vigente |
| D2 | WooCommerce sigue siendo la tienda; Odoo es el backoffice | 2026-10-22 | Vigente |
| D3 | Integración propia por API; sin n8n ni Make | 2026-10-22 | Vigente |
| D4 | App Node en Hostinger en lugar de plugin de WordPress | 2026-11-10 | Vigente |
| D5 | Núcleo + adaptadores, una instancia por cliente | 2026-11-10 | Vigente |
| D6 | Soportar JSON-2 y JSON-RPC de Odoo | 2026-11-10 | Vigente |
| D7 | Cola en MySQL compatible con MariaDB, sin `SKIP LOCKED` | 2026-11-10 | Vigente |
| D8 | Precios sin IVA; Odoo aplica los impuestos | 2026-11-10 | Vigente |
| D9 | El cobro se queda en WooCommerce | 2026-10-22 | Vigente |
| D10 | Alcance v1 mínimo: pedidos + stock opcional | 2026-11-10 | Vigente |

---

<a id="d1"></a>
## D1. Seguir en Odoo Online; no migrar a Odoo.sh

**Contexto.** El cliente compró Odoo como SaaS, plan **Custom**, sin una configuración especial. En Odoo Online no se pueden instalar módulos de terceros ni código propio, así que los conectores WooCommerce de Odoo Apps (Webkul, Emipro, Cybrosys…) no sirven.

**Alternativas.**
- Migrar a **Odoo.sh**: permite módulos, pero es un hosting aparte con costo adicional, supone una migración con ventana de corte y obliga a mantener GitHub, ramas y módulos.
- Migrar a **on-premise** o al hosting de un partner: más control, pero requiere mantenimiento.

**Decisión.** Quedarse en Online. El plan Custom **incluye la API externa**, que es lo único que se necesita para integrar desde fuera.

**Consecuencias.** Toda la lógica vive fuera de Odoo. Solo tendría sentido revisarlo si apareciera un desarrollo que la API no permita.

<a id="d2"></a>
## D2. WooCommerce sigue siendo la tienda; Odoo es el backoffice

**Contexto.** El cliente quería "hacer todo desde Odoo". La web vende en **España** (no en Colombia, así que la DIAN no aplica), con **Stripe** y **ViaBill**, y se quiere pasar a una pasarela de **BBVA**.

**Análisis de pasarelas en Odoo Online:**

| Pasarela | ¿Disponible en Odoo Online? |
|---|---|
| Stripe | Sí, nativa |
| ViaBill (pago a plazos, danés) | No: no hay conector, y Online no admite módulos de terceros |
| BBVA (vía Redsys) | No: Redsys no es nativo en Odoo; los módulos que existen son de terceros |

**Decisión.** No rehacer la tienda en el eCommerce de Odoo. WooCommerce se queda como tienda y Odoo hace de backoffice (inventario, ventas, contabilidad).

**Consecuencias.** Hace falta una integración. A cambio: se conservan ViaBill, el SEO y el diseño actual, WooCommerce ya tiene plugins de Redsys y BBVA para el futuro, y no hay que hacer redirecciones 301 de toda la web.

<a id="d3"></a>
## D3. Integración propia por API; sin n8n ni Make

**Contexto.** Se compararon tres caminos: plataformas iPaaS (n8n, Make, Zapier), un plugin de WordPress o un servicio propio. El hosting es Hostinger Business **compartido** (PHP y Node, sin VPS).

**Por qué no n8n ni Make.** n8n autoalojado necesita un VPS que no hay. n8n cloud y Make tienen costo recurrente por ejecución u operación. Además, el cliente no quiere gastos adicionales. Con lógica compleja (anti-duplicados, impuestos, varias pasarelas), los flujos visuales se vuelven difíciles de mantener y de probar.

**Decisión.** Un servicio propio contra la API externa de Odoo.

**Consecuencias.** Más trabajo inicial y mantenimiento propio (las APIs de Odoo cambian entre versiones). A cambio: cero costo de licencias, lógica a medida y código reutilizable.

<a id="d4"></a>
## D4. App Node en Hostinger en lugar de plugin de WordPress

**Contexto.** Las dos opciones eran viables en el hosting actual. Con un plugin, Action Scheduler (incluido en WooCommerce) ya da cola y reintentos. Pero hay otro cliente que podría necesitar una integración con Odoo o Zoho (aún sin confirmar), y la agencia contempla ofrecer "integración WooCommerce → ERP" como servicio.

**Decisión.** App Node independiente en un subdominio (`sync.ecolifescooters.com`). La diferencia de esfuerzo frente al plugin era pequeña, y la app no requiere instalar nada en la web del cliente, porque los webhooks de WooCommerce son nativos.

**Consecuencias.**
- La app se detiene tras inactividad: no puede haber trabajo en segundo plano. Todo se dispara por webhook o por cron (`/jobs/run`).
- Se necesita una base de datos propia (MySQL de hPanel).
- No depende del WordPress del cliente, que trae modificaciones heredadas de un desarrollador anterior.
- La nota inicial de la tarea en Notion ("Verificar ubicación de plugin") quedó obsoleta.

<a id="d5"></a>
## D5. Núcleo + adaptadores, una instancia por cliente

**Decisión.** `src/core/` define un modelo común y el contrato `TargetAdapter`, y no importa nada de WooCommerce ni de Odoo. Cada destino es un adaptador. Hoy hay una instancia por cliente, sin multi-cliente.

**Por qué no multi-cliente ya.** No hay un segundo cliente confirmado. La regla es no subir de fase en la [hoja de ruta](ARQUITECTURA.md#hoja-de-ruta-de-escalabilidad) hasta que un cliente real la pague.

<a id="d6"></a>
## D6. Soportar JSON-2 y JSON-RPC de Odoo

**Contexto.** Aún no se conoce la versión de Odoo del cliente. Odoo 19 introdujo la API **JSON-2** (`/json/2/...`, con bearer). XML-RPC y JSON-RPC están en retirada.

**Decisión.** Una interfaz `OdooTransport` con dos implementaciones, elegida por `ODOO_API`. El adaptador siempre usa parámetros nombrados.

**Consecuencias.** El desarrollo no se bloquea por la versión. Cuando se confirme, basta con una variable de entorno.

<a id="d7"></a>
## D7. Cola en MySQL compatible con MariaDB, sin `SKIP LOCKED`

**Contexto.** Hostinger usa MariaDB, cuya versión exacta no controlamos, y no hay Redis.

**Decisión.** Reservar jobs con un `UPDATE … LIMIT` atómico marcado con un UUID y luego un `SELECT` por ese UUID. La reserva caduca a los 5 minutos. El `payload` se guarda en `LONGTEXT`, no en `JSON`.

**Consecuencias.** Funciona en cualquier MariaDB o MySQL. Se verificó con dos reservas simultáneas contra MariaDB 10.11. Para el volumen previsto (decenas o cientos de pedidos al día) es de sobra.

<a id="d8"></a>
## D8. Precios sin IVA; Odoo aplica los impuestos

**Decisión.** `price_unit` = total de la línea sin IVA (con cupones aplicados) / cantidad. No se fija el impuesto de la línea: Odoo usa el del producto. Así no dependemos del nombre del campo de impuestos de `sale.order.line`, que ha cambiado entre versiones.

**Consecuencias.** Los impuestos en Odoo deben estar como **no incluidos en el precio**. Para detectar desajustes, después de crear cada pedido se compara `amount_total` con lo cobrado y se avisa si hay diferencia; no se bloquea el pedido.

<a id="d9"></a>
## D9. El cobro se queda en WooCommerce

**Decisión.** A Odoo llega el pedido ya pagado. La pasarela (`stripe`, `viabill`…) y el ID de la transacción van en la nota del pedido, para la conciliación bancaria.

**Pendiente.** Mapear cada pasarela a un diario de Odoo cuando se automatice el registro de pagos. Añadir BBVA será solo una entrada más en ese mapeo.

<a id="d10"></a>
## D10. Alcance v1 mínimo

**Dentro:** pedidos y clientes de WooCommerce a Odoo; stock de Odoo a WooCommerce, opcional.

**Fuera, y por qué:**

| Fuera de v1 | Motivo |
|---|---|
| Rehacer la tienda en Odoo | D2 |
| Sincronizar el catálogo completo (crear productos, fotos) | Mucho esfuerzo y poco impacto antes de Black Friday |
| Precios de Odoo a WooCommerce | Riesgo alto durante las ofertas de Black Friday |
| Facturas y pagos automáticos en Odoo | Corresponde al frente de contabilidad (conciliación bancaria) |
| Cancelaciones y reembolsos | Manuales en v1 |
| Pedidos históricos | Solo entran pedidos a partir de la activación |
| Multi-cliente, Zoho | D5 |
