-- ============================================================================
-- Mi Cámara — Esquema de base de datos (Supabase / PostgreSQL 15+)
-- Tablas de solo lectura alimentadas por el proceso de sync desde opendata.camara.cl
-- ============================================================================

-- ============ Catálogos y geografía ============

create table if not exists catalogos (
  tipo text not null,              -- 'regiones','partidos','tipos-asistencia','tipos-quorum',...
  clave text not null,
  data jsonb not null default '{}'::jsonb,
  actualizado_en timestamptz not null default now(),
  primary key (tipo, clave)
);

create table if not exists distritos (
  numero int primary key,
  region text not null,
  circunscripcion text,
  senadores int,
  diputados int,
  comunas jsonb not null default '[]'::jsonb
);

-- ============ Partidos ============

create table if not exists partidos (
  alias text primary key,
  nombre text,
  bloque text,                     -- 'gobierno','oposicion','independientes','izquierda','centro','derecha','otros'
  tiene_logo boolean not null default false
);

-- ============ Diputados ============

create table if not exists diputados (
  id int primary key,
  nombre text,
  nombre2 text,
  apellido_paterno text,
  apellido_materno text,
  fecha_nacimiento date,
  rut text,
  rutdv text,
  sexo text,
  distrito_numero int references distritos(numero),
  partido_actual text references partidos(alias),
  actualizado_en timestamptz not null default now()
);

create index if not exists idx_diputados_apellido on diputados(apellido_paterno);
create index if not exists idx_diputados_distrito on diputados(distrito_numero);
create index if not exists idx_diputados_partido on diputados(partido_actual);

create table if not exists militancias (
  id bigserial primary key,
  diputado_id int not null references diputados(id) on delete cascade,
  partido_alias text references partidos(alias),
  fecha_inicio date,
  fecha_termino date
);

create index if not exists idx_militancias_diputado on militancias(diputado_id, fecha_inicio);

create table if not exists periodos_legislativos (
  id int primary key,
  nombre text not null,
  fecha_inicio date,
  fecha_termino date
);

create table if not exists periodo_diputados (
  periodo_id int not null references periodos_legislativos(id) on delete cascade,
  diputado_id int not null references diputados(id) on delete cascade,
  primary key (periodo_id, diputado_id)
);

create index if not exists idx_periodo_diputados_dip on periodo_diputados(diputado_id);

-- ============ Sesiones y asistencia ============

create table if not exists sesiones (
  id int primary key,
  numero int,
  fecha_inicio timestamptz,
  fecha_termino timestamptz,
  tipo text,
  estado text,
  anno int
);

create index if not exists idx_sesiones_anno on sesiones(anno, fecha_inicio);

create table if not exists asistencias (
  sesion_id int not null references sesiones(id) on delete cascade,
  diputado_id int not null references diputados(id) on delete cascade,
  tipo_asistencia text,
  justificacion text,
  rebaja_asistencia boolean,
  rebaja_quorum boolean,
  primary key (sesion_id, diputado_id)
);

create index if not exists idx_asistencias_diputado on asistencias(diputado_id);

-- ============ Votaciones y votos nominales ============

create table if not exists votaciones (
  id int primary key,
  descripcion text,
  fecha timestamptz,
  total_si int,
  total_no int,
  total_abstencion int,
  total_dispensado int,
  quorum text,
  resultado text,
  tipo text,
  anno int,
  boletin text
);

create index if not exists idx_votaciones_fecha on votaciones(fecha);
create index if not exists idx_votaciones_anno on votaciones(anno);
create index if not exists idx_votaciones_boletin on votaciones(boletin);
create index if not exists idx_votaciones_resultado on votaciones(resultado);

create table if not exists votos (
  votacion_id int not null references votaciones(id) on delete cascade,
  diputado_id int not null references diputados(id) on delete cascade,
  opcion_voto text,
  primary key (votacion_id, diputado_id)
);

create index if not exists idx_votos_diputado on votos(diputado_id);

-- ============ Proyectos ============

create table if not exists proyectos (
  boletin text primary key,
  nombre text,
  fecha_ingreso date,
  tipo_iniciativa text,
  camara_origen text,
  admisible boolean,
  anno int,
  autores jsonb not null default '[]'::jsonb,
  ministerios jsonb not null default '[]'::jsonb,
  materias jsonb not null default '[]'::jsonb
);

create index if not exists idx_proyectos_anno on proyectos(anno, fecha_ingreso);
create index if not exists idx_proyectos_materias on proyectos using gin (materias);

create table if not exists proyecto_votaciones (
  proyecto_boletin text not null references proyectos(boletin) on delete cascade,
  votacion_id int not null references votaciones(id) on delete cascade,
  articulo text,
  tramite_constitucional text,
  tramite_reglamentario text,
  primary key (proyecto_boletin, votacion_id)
);

create index if not exists idx_proyecto_votaciones_vot on proyecto_votaciones(votacion_id);

-- ============ Comisiones ============

create table if not exists comisiones (
  id int primary key,
  nombre text,
  tipo text,
  numero int,
  fecha_inicio date,
  fecha_termino date,
  presidente_diputado_id int references diputados(id)
);

create table if not exists comision_integrantes (
  comision_id int not null references comisiones(id) on delete cascade,
  diputado_id int not null references diputados(id) on delete cascade,
  fecha_inicio date,
  fecha_termino date,
  primary key (comision_id, diputado_id)
);

create index if not exists idx_comision_integrantes_dip on comision_integrantes(diputado_id);

-- ============ Resultados analíticos cacheados ============

create table if not exists analiticas (
  clave text primary key,          -- 'rankings.2026','contrafactuales.2026',...
  anno int,
  data jsonb not null,
  calculado_en timestamptz not null default now()
);

create index if not exists idx_analiticas_anno on analiticas(anno);

-- ============ Log de sincronización ============

create table if not exists sync_log (
  id bigserial primary key,
  entidad text not null,
  detalle text,
  filas int,
  duracion_ms int,
  ok boolean not null,
  error text,
  ejecutado_en timestamptz not null default now()
);

create index if not exists idx_sync_log_entidad on sync_log(entidad, ejecutado_en);
