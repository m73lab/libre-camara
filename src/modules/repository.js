import { supabase } from '../config/supabase.js';

async function traerTodo(consulta, tam = 1000) {
  const filas = [];
  let desde = 0;
  for (;;) {
    const { data, error } = await consulta.range(desde, desde + tam - 1);
    if (error) throw error;
    filas.push(...(data || []));
    if (!data || data.length < tam) break;
    desde += tam;
  }
  return filas;
}

const MILITANCIAS = `
  select
    d.*,
    coalesce(
      (select jsonb_agg(jsonb_build_object(
        'partido', jsonb_build_object('id', m.partido_alias, 'nombre', p.nombre, 'alias', m.partido_alias),
        'fechaInicio', m.fecha_inicio,
        'fechaTermino', m.fecha_termino
      ) order by m.fecha_inicio desc)
       from militancias m left join partidos p on p.alias = m.partido_alias
       where m.diputado_id = d.id),
      '[]'::jsonb
    ) as militancias
  from diputados d`;

function distritoObj(d) {
  return d.distrito_numero
    ? { numero: d.distrito_numero, region: null, comunas: [] }
    : null;
}

async function periodoActual() {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('periodos_legislativos')
    .select('id')
    .order('id', { ascending: false })
    .limit(1);
  if (error || !data?.[0]) return null;
  const periodoId = data[0].id;

  const { data: filas, error: err } = await supabase
    .from('periodo_diputados')
    .select(`diputados(*)`)
    .eq('periodo_id', periodoId);
  if (err) return null;

  const ids = (filas || []).map((f) => f.diputados?.id).filter(Boolean);
  const militancias = await traerTodo(
    supabase
      .from('militancias')
      .select('diputado_id, partido_alias, fecha_inicio, fecha_termino')
      .in('diputado_id', ids.length ? ids : [0])
  );
  const militanciasPorDiputado = new Map();
  for (const m of militancias || []) {
    if (!militanciasPorDiputado.has(m.diputado_id)) militanciasPorDiputado.set(m.diputado_id, []);
    militanciasPorDiputado.get(m.diputado_id).push(m);
  }

  const { data: distritos } = await supabase.from('distritos').select('numero, region, comunas');
  const distritoPorNumero = new Map((distritos || []).map((d) => [d.numero, d]));
  const { data: partidos } = await supabase.from('partidos').select('alias, nombre');
  const partidoPorAlias = new Map((partidos || []).map((p) => [p.alias, p]));

  return (filas || [])
    .map((f) => f.diputados)
    .filter(Boolean)
    .map((d) => {
      const dist = distritoPorNumero.get(d.distrito_numero);
      const militancias = (militanciasPorDiputado.get(d.id) || [])
        .sort((a, b) => new Date(b.fecha_inicio) - new Date(a.fecha_inicio))
        .map((m) => ({
          partido: m.partido_alias
            ? { id: m.partido_alias, nombre: partidoPorAlias.get(m.partido_alias)?.nombre || m.partido_alias, alias: m.partido_alias }
            : null,
          fechaInicio: m.fecha_inicio,
          fechaTermino: m.fecha_termino,
        }));
      return {
        id: d.id,
        nombre: d.nombre,
        nombre2: d.nombre2,
        apellidoPaterno: d.apellido_paterno,
        apellidoMaterno: d.apellido_materno,
        fechaNacimiento: d.fecha_nacimiento,
        sexo: d.sexo ? { texto: d.sexo, valor: d.sexo === 'Femenino' ? 0 : 1 } : null,
        distrito: dist ? { numero: dist.numero, region: dist.region, comunas: dist.comunas } : null,
        militancias,
      };
    });
}

async function porId(id) {
  if (!supabase) return null;
  const { data: filas, error } = await supabase
    .from('diputados')
    .select('*')
    .eq('id', id)
    .limit(1);
  if (error || !filas?.[0]) return null;
  const d = filas[0];
  const { data: militancias } = await supabase
    .from('militancias')
    .select('partido_alias, fecha_inicio, fecha_termino')
    .eq('diputado_id', id)
    .order('fecha_inicio', { ascending: true });
  const { data: partidos } = await supabase.from('partidos').select('alias, nombre');
  const partidoPorAlias = new Map((partidos || []).map((p) => [p.alias, p]));
  const { data: distritos } = await supabase.from('distritos').select('numero, region, comunas').eq('numero', d.distrito_numero).limit(1);
  const dist = distritos?.[0];
  return {
    id: d.id,
    nombre: d.nombre,
    nombre2: d.nombre2,
    apellidoPaterno: d.apellido_paterno,
    apellidoMaterno: d.apellido_materno,
    fechaNacimiento: d.fecha_nacimiento,
    sexo: d.sexo ? { texto: d.sexo, valor: d.sexo === 'Femenino' ? 0 : 1 } : null,
    distrito: dist ? { numero: dist.numero, region: dist.region, comunas: dist.comunas } : null,
    militancias: (militancias || []).map((m) => ({
      partido: { id: m.partido_alias, nombre: partidoPorAlias.get(m.partido_alias)?.nombre || m.partido_alias, alias: m.partido_alias },
      fechaInicio: m.fecha_inicio,
      fechaTermino: m.fecha_termino,
    })),
  };
}

function shapeVotacion(v) {
  return {
    id: v.id,
    descripcion: v.descripcion,
    fecha: v.fecha,
    totalSi: v.total_si,
    totalNo: v.total_no,
    totalAbstencion: v.total_abstencion,
    totalDispensado: v.total_dispensado,
    quorum: v.quorum ? { texto: v.quorum } : null,
    resultado: v.resultado ? { texto: v.resultado } : null,
    tipo: v.tipo ? { texto: v.tipo } : null,
    proyecto: v.proyecto_nombre
      ? { boletin: v.boletin, nombre: v.proyecto_nombre, materias: v.proyecto_materias || [] }
      : null,
    esElectronica: /^\d+\s*-?\s*Otros$/i.test(String(v.descripcion || '').trim()),
  };
}

async function votacionesPorAnno(anno) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('votaciones')
    .select('id, descripcion, fecha, total_si, total_no, total_abstencion, total_dispensado, quorum, resultado, tipo, boletin, proyectos(nombre, materias)')
    .eq('anno', Number(anno))
    .order('fecha', { ascending: false });
  if (error) return null;
  return (data || []).map((v) =>
    shapeVotacion({
      ...v,
      proyecto_nombre: v.proyectos?.[0]?.nombre || null,
      proyecto_materias: v.proyectos?.[0]?.materias || [],
    })
  );
}

async function votacionDetalle(id) {
  if (!supabase) return null;
  const { data: vot, error } = await supabase
    .from('votaciones')
    .select('*')
    .eq('id', id)
    .limit(1);
  if (error || !vot?.[0]) return null;
  const v = vot[0];
  const { data: votos } = await supabase
    .from('votos')
    .select('diputado_id, opcion_voto, diputados(*)')
    .eq('votacion_id', id);
  const { data: partidos } = await supabase.from('partidos').select('alias, nombre');
  const partidoPorAlias = new Map((partidos || []).map((p) => [p.alias, p]));
  const { data: distritos } = await supabase.from('distritos').select('numero, region, comunas');
  const distritoPorNumero = new Map((distritos || []).map((d) => [d.numero, d]));
  const { data: proy } = await supabase
    .from('proyectos')
    .select('boletin, nombre, materias')
    .eq('boletin', v.boletin)
    .limit(1);

  return {
    ...shapeVotacion(v),
    proyecto: proy?.[0]
      ? { boletin: proy[0].boletin, nombre: proy[0].nombre, materias: proy[0].materias || [] }
      : null,
    votos: (votos || []).map((voto) => {
      const d = voto.diputados;
      const dist = d ? distritoPorNumero.get(d.distrito_numero) : null;
      const partido = d?.partido_actual ? partidoPorAlias.get(d.partido_actual) : null;
      return {
        opcionVoto: voto.opcion_voto ? { texto: voto.opcion_voto } : null,
        diputado: {
          id: d?.id,
          nombre: d?.nombre,
          apellidoPaterno: d?.apellido_paterno,
          distrito: dist ? dist.numero : null,
          partido: partido ? { alias: partido.alias, nombre: partido.nombre } : null,
        },
      };
    }),
  };
}

async function sesionesPorAnno(anno) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('sesiones')
    .select('id, numero, fecha_inicio, fecha_termino, tipo, estado')
    .eq('anno', Number(anno))
    .order('fecha_inicio', { ascending: false });
  if (error) return null;
  return (data || []).map((s) => ({
    id: s.id,
    numero: s.numero,
    fechaInicio: s.fecha_inicio,
    fechaTermino: s.fecha_termino,
    tipo: s.tipo ? { texto: s.tipo } : null,
    estado: s.estado ? { texto: s.estado } : null,
  }));
}

async function sesionDetalle(id) {
  if (!supabase) return null;
  const { data: ses, error } = await supabase.from('sesiones').select('*').eq('id', id).limit(1);
  if (error || !ses?.[0]) return null;
  const s = ses[0];
  const { data: asistencias } = await supabase
    .from('asistencias')
    .select('diputado_id, tipo_asistencia, justificacion, rebaja_asistencia, rebaja_quorum, diputados(*)')
    .eq('sesion_id', id);
  return {
    id: s.id,
    numero: s.numero,
    fechaInicio: s.fecha_inicio,
    fechaTermino: s.fecha_termino,
    tipo: s.tipo ? { texto: s.tipo } : null,
    estado: s.estado ? { texto: s.estado } : null,
    listadoAsistencia: (asistencias || []).map((a) => ({
      tipoAsistencia: a.tipo_asistencia ? { texto: a.tipo_asistencia } : null,
      justificacion: a.justificacion ? { nombre: a.justificacion, rebajaAsistencia: String(a.rebaja_asistencia), rebajaQuorum: String(a.rebaja_quorum) } : null,
      diputado: {
        id: a.diputados?.id,
        nombre: a.diputados?.nombre,
        apellidoPaterno: a.diputados?.apellido_paterno,
      },
    })),
  };
}

async function proyectoPorBoletin(boletin) {
  if (!supabase) return null;
  const { data: proy, error } = await supabase
    .from('proyectos')
    .select('*')
    .eq('boletin', boletin)
    .limit(1);
  if (error || !proy?.[0]) return null;
  const p = proy[0];
  const { data: vinculos } = await supabase
    .from('proyecto_votaciones')
    .select('votacion_id, articulo, tramite_constitucional, tramite_reglamentario')
    .eq('proyecto_boletin', boletin);
  return {
    id: p.id ?? null,
    numeroBoletin: p.boletin,
    nombre: p.nombre,
    fechaIngreso: p.fecha_ingreso,
    tipoIniciativa: p.tipo_iniciativa ? { texto: p.tipo_iniciativa } : null,
    camaraOrigen: p.camara_origen ? { texto: p.camara_origen } : null,
    admisible: p.admisible,
    autores: (p.autores || []).map((a) => ({ orden: null, diputado: { id: a.id, nombre: a.nombre, apellidoPaterno: a.apellidoPaterno } })),
    ministeriosPatrocinantes: p.ministerios || [],
    materias: p.materias || [],
    votaciones: (vinculos || []).map((v) => ({ id: v.votacion_id, articulo: v.articulo, tramiteConstitucional: v.tramite_constitucional ? { texto: v.tramite_constitucional } : null })),
  };
}

export const repos = {
  diputados: { periodoActual, porId },
  votaciones: { votacionesPorAnno, votacionDetalle },
  sesiones: { sesionesPorAnno, sesionDetalle },
  proyectos: { proyectoPorBoletin },
};

export const supabaseActivo = () => supabase !== null;
