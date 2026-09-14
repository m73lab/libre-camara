# Libre Cámara — API

API REST-JSON sobre los datos abiertos de la Cámara de Diputadas y Diputados
de Chile (`opendata.camara.cl`). Normaliza los Web Services SOAP/XML de la
Cámara, los espeja en Postgres y les suma una capa analítica con metodología
publicada. Licencia MIT © Libre Cámara.

> Fuente de datos: Congreso Nacional de Chile — Datos Abiertos Legislativos,
> de utilización libre. Logos de partidos: Biblioteca del Congreso Nacional.

## Qué incluye

1. **API normalizadora** — 32 rutas REST que hablan SOAP por ti, con validación
   de parámetros, caché multinivel y respuestas `{ data, meta }`.
2. **API analítica** — ~30 endpoints computados (rankings, votos decisivos,
   contrafactuales, cohesión, dieta, cruces…), con caché de 6 h en Postgres.
   Ver `METODOLOGIA.md` para definiciones y limitaciones.
3. **Pipeline de datos** — `db:setup` (esquema) + `sync` (espejo 2020-2026) +
   `auditoria` (completitud lista-vs-detalle, con `--reparar`).

## Arquitectura de un request

```
cliente → Express (valida params del catálogo)
  → caché memoria (TTL 300s–3600s, header X-Cache)
  → Postgres (espejo; ORDER BY fecha desc)
  → upstream SOAP (POST XML, reintentos con backoff)
  → parseo XML→JSON → enriquecimiento (legible, distrito, perfiles)
  → { data, meta } (+ X-Total-Ms)
```

Sin `DATABASE_URL` la API funciona en modo upstream+caché (más lento,
sin persistencia).

## Quickstart

```bash
npm install
cp .env.example .env        # completar DATABASE_URL (Postgres 15+)
npm run db:setup            # crea las 17 tablas
npm run sync -- --entidad catalogos,diputados,periodos,comisiones
npm run sync -- --entidad votaciones --anno 2026
npm run dev                 # :3000 (API en /api/v1)
```

Sync completo 2020-2026: `npm run sync` (tarda ~1 h, idempotente).
Verificar huecos: `npm run auditoria [--anno AAAA] [--reparar]`.

## Variables de entorno

| Variable | Uso |
|---|---|
| `PORT` | Puerto (def. 3000) |
| `UPSTREAM_BASE` | WServices de la Cámara |
| `UPSTREAM_TIMEOUT_MS` | Timeout upstream (def. 30000) |
| `DATABASE_URL` | Postgres (opcional pero recomendado) |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` / `BOT_INTERVAL_MIN` | Bot vigilante (opcional) |
| `DIETA_MENSUAL` | Parámetro de la estimación de dieta (def. 8900000) |
| `SCORE_PESOS` | Pesos del score `asistencia,participación,mociones,avance` (def. `0.4,0.25,0.2,0.15`) |

## Endpoints de datos

| Ruta | Descripción |
|---|---|
| `GET /votaciones?anno=` | Votaciones de sala (más recientes primero) |
| `GET /votaciones/:id` | Detalle nominal + contexto del día |
| `GET /diputados/periodo-actual` | Roster vigente con distrito |
| `GET /diputados/:id` | Ficha + militancias + distrito |
| `GET /diputados/:id/votaciones?anno=` | Historial nominal con su voto |
| `GET /diputados/:id/asistencia?anno=` · `/mociones` · `/comisiones` · `/foto` | Perfil extendido |
| `GET /sesiones?anno=` · `/sesiones/:id` | Sesiones y asistencia nominal |
| `GET /proyectos/:boletin` | Ficha (autores, materias, vínculos) |
| `GET /proyectos/por-ley/:numero` · `/proyectos/acuerdos` · `/proyectos/resoluciones` | Otros cuerpos |
| `GET /comisiones` · `/comisiones/:id` · `/comisiones/periodo/:id` | Comisiones (con flag `disuelta`) |
| `GET /distritos` · `/comunas/:nombre/diputados` | División electoral y búsqueda por comuna |
| `GET /catalogos/*` · `/periodos-legislativos` · `/materias` · `/mensajes` · `/mociones` · `/tramites/*` | Catálogos |

## Endpoints analíticos

| Ruta | Descripción |
|---|---|
| `GET /rankings?anno=` | Score por diputado (ver metodología) |
| `GET /votos-decisivos?desde=&hasta=` | Votos que definieron resultados |
| `GET /contrafactuales?anno=` | Rechazadas que habrían cambiado |
| `GET /cohesion?anno=` · `/partidos` · `/partidos/:alias` | Disciplina de bloque, rebeldes |
| `GET /dieta?anno=` | Estimación de dieta cobrada sin asistir |
| `GET /brechas?anno=` · `/horarios` · `/cementerio` · `/analitica-temporal` · `/velocidad-ley` | Cortes demográficos y temporales |
| `GET /cruces/fiscalizacion` · `/agenda` · `/faltas` · `/cambios-voto` · `/edad` · `/distritos` · `/fatiga` · `/bloques` · `/materias` · `/afinidad-partidos` | Cruces entre dimensiones |
| `GET /afinidad` · `/diputados/:id/afinidad` · `/transfuguismo` · `/trayectoria` | Afinidades y cambios de partido |

Los endpoints con dependencia upstream inestable devuelven `parcial: true`
(y por año `ok: false`) en vez de un 502. Detalles y limitaciones en
`METODOLOGIA.md`.

## Scripts

| Script | Uso |
|---|---|
| `npm run db:setup` | Aplica `migrations/` en orden |
| `npm run sync [--entidad a,b] [--anno 2026]` | Espeja upstream → Postgres |
| `npm run auditoria [--anno AAAA] [--reparar]` | Reporta (y repara) huecos; exit 1 si quedan |
| `npm run fotos` | Descarga fotos oficiales a `data/fotos/` (no versionado) |

## Notas operativas

- Primera consulta de un cálculo pesado tarda (analiza el año completo);
  las siguientes son instantáneas (caché 6 h). Hay warm-up al arrancar.
- El upstream rate-limitea: ante 502s, reintentar más tarde; los parciales
  se completan solos al expirar la caché.
- Sin autenticación ni rate-limit propio: exponer detrás de un gateway si
  sale a internet.
- Requiere Node.js ≥ 18.17.
