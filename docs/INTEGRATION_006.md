# MI08 — INTEGRATION 006: investigación por caso (VS003 Stage A) integrada en RADAR y Blueprint

Estado: **preparado y probado offline. Nada aplicado, nada desplegado.**
Decisiones aplicadas: 1A, 2A y 3A (15-10-2026).

## 1. Qué cambia

| Pieza | Cambio | Casos sin investigación |
|---|---|---|
| `radar/contract.js`, `blueprint/contract.js` | Nuevo origen `RESEARCH` en `provided_by` | Salidas idénticas; cambia el hash del esquema |
| `radar/validate.js`, `blueprint/validate.js` | Una evidencia `RESEARCH` debe apuntar a una fuente del bundle; la investigación nunca puede presentarse como `SIGNAL`, `MANUEL` o `CONTEXT`; un `RESEARCH` sin fuente pasa a `UNCONFIRMED` | Sin efecto |
| `radar/epistemic.js` | El dominio del prospecto de cada investigación también marca lo autopublicado; resolución entre varias investigaciones | Sin efecto |
| Prompts | RADAR 0.1.5 y Blueprint 0.1.3: cómo citar `RESEARCH` por `source_id` y qué hacer si la investigación falló o venció | Plantilla nueva (más texto) |
| `research/case-spec.js`, `research/case-adapter.js` | URLs semilla explícitas; control de URL pública; control de dominio también después de redirecciones; plazo del run; marca `self_published` | — |
| `research/case-worker.js`, `research/case-wiring.js`, `server.js` | Worker conectado y apagado salvo `ATLAS_CASE_RESEARCH_WORKER_ENABLED=true` | Sin efecto |
| `migrations/20261015120000_integration_006_case_research.sql` | Tablas, RPC nuevas; `radar_claim_next` y `blueprint_claim_next` con 3 cambios anclados | Bundle idéntico byte a byte (probado) |

## 2. Circuitos

**Investigación previa a RADAR**
1. Manuel llama a `submit_signal_with_research(...)`.
2. En una sola transacción se crean el caso y un run `PRE_RADAR` en estado `REQUESTED`, con plazo.
3. `radar_claim_next` no toma ese caso mientras el run esté abierto y dentro del plazo.
4. El worker de investigación reclama el run, captura fuentes (semillas y, opcionalmente, descubrimiento), las registra y completa el run.
5. RADAR recibe `research_runs` y `research_sources`.
6. Si el run falla, Manuel lo cancela o vence el plazo, RADAR continúa sin evidencia externa. El vencimiento lo registran los propios claims de RADAR y Blueprint, de modo que funciona aunque el worker de investigación esté apagado.

**Enriquecimiento previo a Blueprint (sin repetir RADAR)**
1. Con el caso en `GROWTH_APPROVED`, Manuel llama a `case_research_authorize(...)`.
2. La autorización de Blueprint se registra como siempre (`blueprint_authorize_run`).
3. `blueprint_claim_next` espera mientras el run esté abierto y dentro del plazo.
4. Al terminar, Blueprint recibe las fuentes.
5. Cualquier otro estado devuelve un rechazo explícito y recuperable (`CASE_RESEARCH_CASE_NOT_AUTHORIZABLE`) y no registra nada.
6. La máquina de estados no cambia.

## 3. Contratos para Review Hub (sin cambios en Review Hub todavía)

Todas las RPC de Manuel comprueban `agency_os_is_manuel()`. Las del worker son exclusivas de `service_role`.

| RPC | Quién | Uso en la interfaz |
|---|---|---|
| `submit_signal_with_research(p_signal, p_source_type, p_organization_id, p_prospect, p_context, p_research, p_rationale)` | Manuel | Alta de señal con investigación previa. Devuelve lo mismo que `submit_signal` más `research_run_id`, `research_phase`, `research_status` y `research_deadline_at` |
| `case_research_authorize(p_case_id, p_research, p_rationale)` | Manuel | Botón «Investigar antes del Blueprint» (solo en `GROWTH_APPROVED`) |
| `case_research_cancel(p_run_id, p_rationale)` | Manuel | Cancelar un run abierto; el circuito continúa sin evidencia externa |
| `case_research_overview(p_case_id)` | Manuel | Panel del caso: límites, `can_authorize_enrichment`, runs, fuentes |
| `case_research_limits()` | Manuel / servicio | Topes para el formulario de presupuesto |

**Campos de `p_research`** (no se admiten otros):
- `prospect_url`: obligatorio, http(s) público. Su dominio debe coincidir con la web del prospecto si esta consta.
- `seed_urls`: hasta 3 URLs públicas; cada dominio queda permitido de forma explícita.
- `budget`: presupuesto `atlas_research_budget/0.2` **sin** `pricing` ni `pricing_version` (si vienen, se rechaza con `CASE_RESEARCH_CLIENT_PRICING_REJECTED`). `allowed_domains` debe ser exactamente el dominio del prospecto más los de las semillas.

### Tarifas en el servidor (corrección del 15-10-2026)
- Las tarifas viven solo en `case_research_pricing`. Una versión la propone el servidor con `case_research_pricing_propose` (solo `service_role`) y la aprueba Manuel con `case_research_pricing_approve`. Es inmutable y solo puede haber una aprobada a la vez.
- Sin versión aprobada no se puede autorizar ninguna investigación (`CASE_RESEARCH_PRICING_NOT_APPROVED`). La migración no trae ninguna: hay que proponer y aprobar las tarifas reales antes del piloto.
- `case_research_create_run` añade al presupuesto las tarifas aprobadas y guarda `pricing_version` en el run y en `RESEARCH_REQUESTED`. Rechaza el presupuesto si su peor caso (todos los topes de tokens y búsquedas agotados) supera `max_estimated_cost_usd`.
- `case_research_claim_next` solo reclama runs cuya versión sigue aprobada y corresponde al modelo del worker. Retirar la versión (`case_research_pricing_retire`) detiene también los runs en cola.
- `case_research_complete_run` recalcula el coste con el uso declarado y las tarifas del run. Rechaza un uso por encima de los topes o un coste declarado distinto del calculado.
- `case_research_limits()` muestra el estado (`APPROVED` o `NOT_APPROVED`), la versión aprobada y las propuestas pendientes.
- `wait_minutes`: entre 5 y 60; 20 por defecto. Debe superar `max_seconds` en al menos 60 s.
- `discovery`: booleano; `true` por defecto.

**Topes vigentes por run (propuestos, a fijar por Manuel):**

| Límite | Valor |
|---|---|
| Búsquedas | 3 |
| Fetches | 4 |
| Capturas por página | 3 |
| Caracteres por página | 4000 |
| Tokens de entrada | 60 000 |
| Tokens de salida | 12 000 |
| Duración | 300 s |
| Coste estimado | 1,00 USD |
| Runs por caso | 3 (uno abierto como máximo) |
| Techo diario autorizado | 5,00 USD |

**Qué mostrar de cada fuente:** `url`, `title`, `source_type`, `self_published` («la propia web del prospecto»), `seed`, `excerpt`, `verification_method`, `evidence_status` (verificada o solo pista).

**Eventos nuevos en el historial:** `RESEARCH_REQUESTED`, `RESEARCH_STARTED`, `RESEARCH_COMPLETED`, `RESEARCH_FAILED`, `RESEARCH_EXPIRED`, `RESEARCH_CANCELLED`.

**Errores** (prefijo `CASE_RESEARCH_`): `AUTH_REQUIRED`, `NOT_AUTHORIZED`, `REQUEST_REQUIRED`, `REQUEST_UNKNOWN_FIELD`, `RATIONALE_REQUIRED`, `PROSPECT_URL_INVALID`, `PROSPECT_DOMAIN_MISMATCH`, `SEED_URL_INVALID`, `SEED_URLS_TOO_MANY`, `NOTHING_TO_RESEARCH`, `BUDGET_INVALID`, `WAIT_*`, `ALREADY_OPEN`, `MAX_RUNS_PER_CASE`, `DAILY_BUDGET_EXCEEDED`, `CASE_NOT_AUTHORIZABLE`, `RUN_NOT_OPEN`.

## 4. Reversión

`migrations/20261015120000_integration_006_case_research.rollback.sql`
- **Siempre:** restaura `radar_claim_next` y `blueprint_claim_next` exactamente (md5 comprobado) y elimina todas las RPC `case_research_*`.
- **Si nunca se registró investigación:** elimina también las tablas y restaura el vocabulario original de eventos.
- **Si hay datos de investigación:** los conserva inertes y lo notifica; `case_events` es solo de anexión.

## 5. Procedimiento de activación controlada (piloto)

Cada paso requiere un GO explícito; ninguno se ha ejecutado.

1. **Verificación de solo lectura en staging.**
   - Repetir el catálogo: 27 migraciones y los md5 de `function_acl.json`.
   - La migración se niega a aplicarse si hay deriva (precondición).
2. **Resolver los bloqueos del apartado 6**, en particular crédito, fetch desde Railway y Review Hub.
3. **Aplicar la migración en staging** (GO 1).
   - Comprobar las postcondiciones del propio script.
   - Repetir, sobre un caso de prueba, la comparación de bundle de un caso sin investigación.
4. **Desplegar el motor con la bandera ausente o `false`** (GO 2).
   - `/health` debe mostrar `case_research_worker: { enabled: false }`.
   - RADAR y Blueprint deben funcionar igual (casos sin investigación).
5. **Cambio en Review Hub** (GO 3, autorización y créditos aparte), con los contratos del apartado 3.
6. **Ventana de piloto** (GO 4).
   - Fijar `CASE_RESEARCH_MODEL` y los precios reales en el formulario.
   - Poner `ATLAS_CASE_RESEARCH_WORKER_ENABLED=true`.
   - Un solo caso, con una sola semilla y `discovery=false`.
7. **Observación:** run `COMPLETED`, fuentes con `ENGINE_FETCHED_PAGE`, coste del manifiesto por debajo del autorizado, RADAR válido con evidencia `RESEARCH`.
8. **Criterios de vuelta atrás:**
   - cualquier `DOMAIN_NOT_ALLOWED` inesperado;
   - un coste estimado superior al autorizado;
   - un caso sin investigación cuyo bundle cambie;
   - un fallo de validación nuevo en RADAR o Blueprint.

   Primera acción: bandera en `false`. Segunda, si hace falta: script de reversión.

## 6. Bloqueos para el primer piloto

| Bloqueo | Detalle |
|---|---|
| Crédito de Anthropic | Probablemente agotado (fallo del 03-10-2026); necesario para la investigación y para RADAR. |
| Fetch real desde Railway | No probado: no se sabe si el motor puede descargar páginas públicas desde Railway. |
| Review Hub | No tiene interfaz para autorizar, mostrar el presupuesto ni consultar fuentes; tampoco se ha comprobado cómo muestra `provided_by = RESEARCH` ni los eventos `RESEARCH_*`. |
| Comportamiento del modelo | No verificado con prompts 0.1.5 y 0.1.3 (sin ejecuciones reales). |
| SSRF residual | Las URLs se validan como texto (IP literal, puertos, hosts privados), pero un dominio público que resuelva a una IP privada no se bloquea. Bloquearlo exige comprobar la IP resuelta en el fetch del motor; decisión pendiente. |
| Precios y topes | Los precios del presupuesto son de prueba. Los topes y el techo diario son propuestas a fijar por Manuel. |
