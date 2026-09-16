-- 004: ficha del Senado (etapa real, urgencias, texto completo, historial)
alter table if exists proyectos add column if not exists ficha_senado jsonb;
alter table if exists proyectos add column if not exists ficha_senado_actualizada timestamptz;
