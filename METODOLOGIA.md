# Metodología — cómo se calculan las métricas de Mi Cámara

Fuente primaria: datos abiertos de la Cámara de Diputadas y Diputados
(`opendata.camara.cl`, `backend/src/catalog.js`). Todo lo que sigue se calcula
sobre ese espejo. Nada de lo publicado es dato oficial de la Cámara salvo que
se indique.

## 1. Score y rankings (`GET /rankings`)

`score = 100 × (pA·asistencia + pP·participación + pM·mociones + pV·avance)`

- Pesos por defecto `0.4, 0.25, 0.2, 0.15`, configurables con `SCORE_PESOS`
  (se normalizan para sumar 1; formato inválido → defaults).
- Los pesos son una **decisión editorial**: cambiarlos cambia el orden.
  El score sirve para comparar, no es una medición física.
- Denominadores prorrateados: sesiones y votaciones se cuentan desde la
  **primera aparición** del diputado en el año (para no castigar a
  reemplazantes que entraron a mitad de periodo). Campos `sesionesBase`,
  `votacionesBase` y `primeraAparicion` transparentan el cálculo por fila.

## 2. Votos decisivos (`GET /votos-decisivos`)

Un voto es decisivo cuando sin él el resultado habría sido distinto
(votante pivotal): aprobada con `sí == quórum requerido` cuenta todos los
afirmativos; rechazada con `sí == requerido − 1` cuenta todos los en contra;
sin quórum tabulado se usa margen de 1 voto.

Los quórums dependen de los escaños en ejercicio: **120 hasta 2017 y 155
desde 2018** (`escanosPara()` en `backend/src/lib/quorum.js`). Ejemplos
verificados: Calificado 78/61, 2/3 104/80, 3/5 93/72, 4/7 89/69.
Quórums desconocidos caen al criterio de margen (aproximación documentada).

## 3. Contrafactuales (`GET /contrafactuales`)

Para cada votación rechazada: cuántos votos faltaron para el quórum y si los
ausentes + no-votantes habrían alcanzado (`habrianAlcanzado`). El partido se
atribuye con solape de fechas de militancia (`partidoEnAnno`), igual que el
resto del sistema. Los "ausentes" se calculan contra los escaños del periodo
(ver punto 2), no contra un 155 fijo.

## 4. Dieta de ausentes (`GET /dieta`, estimación)

`valorPorSesion = (DIETA_MENSUAL × 12) / sesiones del año`;
`cobroEstimado = sesiones cobradas sin asistir × valorPorSesion`.
Es un **orden de magnitud, no un cobro real**: depende de los flags de rebaja
del upstream y del parámetro `DIETA_MENSUAL`. Presentar siempre como estimación.

## 5. Enriquecimiento legible

- **Proyectos**: boletín → nombre/materias desde el espejo (batch DB).
  Los no resueltos **no se cachean como nulos**: reintentan en la próxima
  pasada (un null suele ser rate-limit transitorio).
- **Resoluciones/acuerdos**: el número se repite entre años; se desambigua
  buscando en año, año−1, año−2 y prefiriendo el ingreso más reciente
  anterior a la votación.
- **Etapa**: reglas sobre el campo `artículo` (Mixta / Modificaciones del
  Senado / Particular / General). 762 vínculos sin artículo quedan sin etapa.
- **Distrito**: emparejamiento por nombre + año de nacimiento contra la
  división electoral; riesgo residual en homónimos y reemplazos.

## 6. Completitud y degradación parcial

- El sync cuenta **omitidas** por rate-limit en el `sync_log` (ya no son
  silenciosas). `npm run auditoria [--anno AAAA] [--reparar]` compara
  lista-vs-detalle por año y puede reparar huecos.
- Endpoints con dependencia upstream inestable (`fiscalizacion`,
  `contrafactuales`, `votos-decisivos`) devuelven `parcial: true` y por año
  `ok: false` en vez de un 502. Los parciales también se cachean (6 h).

## 7. Cachés

Memoria (TTL 300s–3600s según endpoint) + Postgres tabla `analiticas`
(6 h). La primera consulta de un cálculo pesado tarda (analiza el año
completo); las siguientes son instantáneas.
