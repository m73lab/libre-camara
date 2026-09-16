-- 003: ficha del sistema antiguo (sesión, boletín, trámite/informe codificados)
alter table if exists votaciones add column if not exists ficha jsonb;
alter table if exists votaciones add column if not exists ficha_actualizada timestamptz;
