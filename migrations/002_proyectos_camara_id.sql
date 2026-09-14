-- 002: id interno de la Cámara para enlazar a la tramitación oficial
alter table if exists proyectos add column if not exists camara_id integer;
