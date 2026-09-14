import postgres from 'postgres';
import { distritoDe } from '../lib/distritos.js';

const sql = process.env.DATABASE_URL
  ? postgres(process.env.DATABASE_URL, { max: 10, idle_timeout: 30, onnotice: () => {} })
  : null;

export const usarBd = () => sql !== null;

const sexoObj = (s) => (s ? { texto: s, valor: s === 'Femenino' ? 0 : 1 } : null);
const textoObj = (t) => (t ? { texto: t } : null);
const boolStr = (b) => (b === null || b === undefined ? null : String(b));

function shapeVotacion(r) {
  return {
    id: r.id,
    descripcion: r.descripcion,
    fecha: r.fecha,
    totalSi: r.total_si,
    totalNo: r.total_no,
    totalAbstencion: r.total_abstencion,
    totalDispensado: r.total_dispensado,
    quorum: textoObj(r.quorum),
    resultado: textoObj(r.resultado),
    tipo: textoObj(r.tipo),
    articulo: r.articulo || null,
  };
}

async function votaciones(anno) {
  if (!sql) return undefined;
  const rows = await sql`
    select v.*,
      (select pv.articulo from proyecto_votaciones pv where pv.votacion_id = v.id limit 1) as articulo
    from votaciones v where v.anno = ${Number(anno)} order by v.fecha desc`;
  return rows.map(shapeVotacion);
}

async function votacion(id) {
  if (!sql) return undefined;
  const [v] = await sql`
    select v.*,
      (select pv.articulo from proyecto_votaciones pv where pv.votacion_id = v.id limit 1) as articulo
    from votaciones v where v.id = ${Number(id)}`;
  if (!v) return undefined;
  const votos = await sql`
    select v.diputado_id, v.opcion_voto, d.nombre, d.apellido_paterno, d.apellido_materno
    from votos v left join diputados d on d.id = v.diputado_id
    where v.votacion_id = ${Number(id)}`;
  const contexto = await sql`
    select v.*,
      (select pv.articulo from proyecto_votaciones pv where pv.votacion_id = v.id limit 1) as articulo
    from votaciones v
    where v.fecha::date = (select fecha::date from votaciones where id = ${Number(id)})
      and v.id <> ${Number(id)}
    order by v.fecha desc limit 12`;
  return {
    ...shapeVotacion(v),
    contexto: contexto.map(shapeVotacion),
    votos: votos.map((voto) => ({
      opcionVoto: textoObj(voto.opcion_voto),
      diputado: voto.diputado_id
        ? {
            id: voto.diputado_id,
            nombre: voto.nombre,
            apellidoPaterno: voto.apellido_paterno,
            apellidoMaterno: voto.apellido_materno,
          }
        : null,
    })),
  };
}

async function sesiones(anno) {
  if (!sql) return undefined;
  const rows = await sql`select * from sesiones where anno = ${Number(anno)} order by fecha_inicio desc`;
  return rows.map((s) => ({
    id: s.id,
    numero: s.numero,
    fechaInicio: s.fecha_inicio,
    fechaTermino: s.fecha_termino,
    tipo: textoObj(s.tipo),
    estado: textoObj(s.estado),
  }));
}

async function sesion(id) {
  if (!sql) return undefined;
  const [s] = await sql`select * from sesiones where id = ${Number(id)}`;
  if (!s) return undefined;
  const asistencias = await sql`
    select a.diputado_id, a.tipo_asistencia, a.justificacion, a.rebaja_asistencia, a.rebaja_quorum,
           d.nombre, d.apellido_paterno
    from asistencias a left join diputados d on d.id = a.diputado_id
    where a.sesion_id = ${Number(id)}`;
  return {
    id: s.id,
    numero: s.numero,
    fechaInicio: s.fecha_inicio,
    fechaTermino: s.fecha_termino,
    tipo: textoObj(s.tipo),
    estado: textoObj(s.estado),
    listadoAsistencia: asistencias.map((a) => ({
      tipoAsistencia: textoObj(a.tipo_asistencia),
      justificacion: a.justificacion
        ? {
            nombre: a.justificacion,
            rebajaAsistencia: boolStr(a.rebaja_asistencia),
            rebajaQuorum: boolStr(a.rebaja_quorum),
          }
        : null,
      diputado: {
        id: a.diputado_id,
        nombre: a.nombre,
        apellidoPaterno: a.apellido_paterno,
      },
    })),
  };
}

async function militanciasDe(diputadoId) {
  const rows = await sql`
    select m.partido_alias, m.fecha_inicio, m.fecha_termino, p.nombre as partido_nombre
    from militancias m left join partidos p on p.alias = m.partido_alias
    where m.diputado_id = ${diputadoId} order by m.fecha_inicio desc`;
  return rows.map((m) => ({
    partido: m.partido_alias
      ? { id: m.partido_alias, nombre: m.partido_nombre || m.partido_alias, alias: m.partido_alias }
      : null,
    fechaInicio: m.fecha_inicio,
    fechaTermino: m.fecha_termino,
  }));
}

function shapeDiputado(d) {
  return {
    id: d.id,
    nombre: d.nombre,
    nombre2: d.nombre2,
    apellidoPaterno: d.apellido_paterno,
    apellidoMaterno: d.apellido_materno,
    fechaNacimiento: d.fecha_nacimiento,
    rut: d.rut,
    rutdv: d.rutdv,
    sexo: sexoObj(d.sexo),
  };
}

async function diputado(id) {
  if (!sql) return undefined;
  const [d] = await sql`select * from diputados where id = ${Number(id)}`;
  if (!d) return undefined;
  const base = { ...shapeDiputado(d), militancias: await militanciasDe(d.id) };
  return { ...base, distrito: distritoDe(base) };
}

async function diputados() {
  if (!sql) return undefined;
  const rows = await sql`select * from diputados order by apellido_paterno, nombre`;
  const conMilitancias = [];
  for (const d of rows) {
    conMilitancias.push({ ...shapeDiputado(d), militancias: await militanciasDe(d.id) });
  }
  return conMilitancias;
}

async function rosterActual() {
  if (!sql) return undefined;
  const [periodo] = await sql`select * from periodos_legislativos order by id desc limit 1`;
  if (!periodo) return undefined;
  const rows = await sql`
    select pd.diputado_id, d.* from periodo_diputados pd
    join diputados d on d.id = pd.diputado_id
    where pd.periodo_id = ${periodo.id}`;
  return Promise.all(
    rows.map(async (d) => ({
      fechaInicio: periodo.fecha_inicio,
      fechaTermino: periodo.fecha_termino,
      diputado: { ...shapeDiputado(d), militancias: await militanciasDe(d.id) },
    }))
  );
}

async function diputadosXPeriodo(periodoId) {
  if (!sql) return undefined;
  const [periodo] = await sql`select * from periodos_legislativos where id = ${Number(periodoId)}`;
  if (!periodo) return undefined;
  const rows = await sql`
    select pd.diputado_id, d.* from periodo_diputados pd
    join diputados d on d.id = pd.diputado_id
    where pd.periodo_id = ${Number(periodoId)}`;
  const salida = [];
  for (const d of rows) {
    salida.push({
      fechaInicio: periodo.fecha_inicio,
      fechaTermino: periodo.fecha_termino,
      diputado: { ...shapeDiputado(d), militancias: await militanciasDe(d.id) },
    });
  }
  return salida;
}

async function proyectosDe(anno, tipo) {
  if (!sql) return undefined;
  const rows = await sql`
    select * from proyectos
    where anno = ${Number(anno)} and tipo_iniciativa = ${tipo}
    order by fecha_ingreso desc`;
  return rows.map((p) => ({
    id: null,
    numeroBoletin: p.boletin,
    nombre: p.nombre,
    fechaIngreso: p.fecha_ingreso,
    tipoIniciativa: textoObj(p.tipo_iniciativa),
    camaraOrigen: textoObj(p.camara_origen),
    admisible: String(p.admisible),
  }));
}

async function backfillCamaraId(boletin) {
  try {
    const { callUpstream } = await import('../lib/camaraClient.js');
    const { parseUpstreamXml } = await import('../lib/xml.js');
    const { xml } = await callUpstream('WSLegislativo', 'retornarProyectoLey', { prmNumeroBoletin: boletin });
    const detalle = parseUpstreamXml(xml, 'single');
    const id = detalle?.id ? Number(detalle.id) : null;
    if (id && !Number.isNaN(id)) {
      await sql`update proyectos set camara_id = ${id} where boletin = ${boletin} and camara_id is null`;
      return id;
    }
  } catch {
    // sin id: la ficha igual se sirve sin link de tramitación
  }
  return null;
}

async function proyecto(boletin) {
  if (!sql) return undefined;
  const [p] = await sql`select * from proyectos where boletin = ${boletin}`;
  if (!p) return undefined;
  let camaraId = p.camara_id ?? null;
  if (camaraId === null) {
    camaraId = await backfillCamaraId(boletin);
  }
  const vinculos = await sql`
    select pv.votacion_id, pv.articulo, pv.tramite_constitucional, pv.tramite_reglamentario,
           v.descripcion, v.fecha, v.total_si, v.total_no, v.total_abstencion, v.total_dispensado,
           v.quorum, v.resultado, v.tipo
    from proyecto_votaciones pv left join votaciones v on v.id = pv.votacion_id
    where pv.proyecto_boletin = ${boletin} order by v.fecha desc`;
  return {
    id: null,
    camaraId,
    numeroBoletin: p.boletin,
    nombre: p.nombre,
    fechaIngreso: p.fecha_ingreso,
    tipoIniciativa: textoObj(p.tipo_iniciativa),
    camaraOrigen: textoObj(p.camara_origen),
    admisible: p.admisible === true || p.admisible === 'true',
    autores: (p.autores || []).map((a) => ({
      orden: null,
      diputado: { id: a.id, nombre: a.nombre, apellidoPaterno: a.apellidoPaterno },
    })),
    ministeriosPatrocinantes: p.ministerios || [],
    materias: p.materias || [],
    votaciones: vinculos.map((v) => ({
      id: v.votacion_id,
      descripcion: v.descripcion,
      fecha: v.fecha,
      totalSi: v.total_si,
      totalNo: v.total_no,
      totalAbstencion: v.total_abstencion,
      totalDispensado: v.total_dispensado,
      quorum: textoObj(v.quorum),
      resultado: textoObj(v.resultado),
      tipo: textoObj(v.tipo),
      articulo: v.articulo,
      tramiteConstitucional: textoObj(v.tramite_constitucional),
      tramiteReglamentario: textoObj(v.tramite_reglamentario),
    })),
  };
}

async function periodos() {
  if (!sql) return undefined;
  const rows = await sql`select * from periodos_legislativos order by id`;
  return rows.map((p) => ({
    id: p.id,
    nombre: p.nombre,
    fechaInicio: p.fecha_inicio,
    fechaTermino: p.fecha_termino,
  }));
}

async function comisionesXPeriodo(periodoId) {
  if (!sql) return undefined;
  const [periodo] = await sql`select * from periodos_legislativos where id = ${Number(periodoId)}`;
  if (!periodo) return undefined;
  const rows = await sql`
    select * from comisiones
    where fecha_inicio >= ${periodo.fecha_inicio}
      and (fecha_termino is null or fecha_termino <= ${periodo.fecha_termino})
    order by nombre`;
  return rows.map((c) => ({ id: c.id, nombre: c.nombre, tipo: textoObj(c.tipo) }));
}

async function comision(id) {
  if (!sql) return undefined;
  const [c] = await sql`select * from comisiones where id = ${Number(id)}`;
  if (!c) return undefined;
  const integrantes = await sql`
    select ci.diputado_id, ci.fecha_inicio, ci.fecha_termino, d.nombre, d.apellido_paterno, d.apellido_materno
    from comision_integrantes ci left join diputados d on d.id = ci.diputado_id
    where ci.comision_id = ${Number(id)}`;
  const [presidente] = c.presidente_diputado_id
    ? await sql`select id, nombre, apellido_paterno from diputados where id = ${c.presidente_diputado_id}`
    : [];
  return {
    id: c.id,
    nombre: c.nombre,
    tipo: textoObj(c.tipo),
    numero: c.numero,
    fechaInicio: c.fecha_inicio,
    fechaTermino: c.fecha_termino,
    integrantes: integrantes.map((i) => ({
      fechaInicio: i.fecha_inicio,
      fechaTermino: i.fecha_termino,
      diputado: {
        id: i.diputado_id,
        nombre: i.nombre,
        apellidoPaterno: i.apellido_paterno,
        apellidoMaterno: i.apellido_materno,
      },
    })),
    presidente: presidente
      ? { id: presidente.id, nombre: presidente.nombre, apellidoPaterno: presidente.apellido_paterno }
      : null,
  };
}

export const fuente = {
  'WSLegislativo|retornarVotacionesXAnno': (params) => votaciones(params.prmAnno),
  'WSLegislativo|retornarVotacionDetalle': (params) => votacion(params.prmVotacionId),
  'WSSala|retornarSesionesXAnno': (params) => sesiones(params.prmAnno),
  'WSSala|retornarSesionAsistencia': (params) => sesion(params.prmSesionId),
  'WSDiputado|retornarDiputadosPeriodoActual': () => rosterActual(),
  'WSDiputado|retornarDiputados': () => diputados(),
  'WSDiputado|retornarDiputado': (params) => diputado(params.prmDiputadoId),
  'WSDiputado|retornarDiputadosXPeriodo': (params) => diputadosXPeriodo(params.prmPeriodoID ?? params.prmPeriodoId),
  'WSLegislativo|retornarMocionesXAnno': (params) => proyectosDe(params.prmAnno, 'Moción'),
  'WSLegislativo|retornarMensajesXAnno': (params) => proyectosDe(params.prmAnno, 'Mensaje'),
  'WSLegislativo|retornarProyectoLey': (params) => proyecto(params.prmNumeroBoletin),
  'WSLegislativo|retornarPeriodosLegislativos': () => periodos(),
  'WSComision|retornarComisionesXPeriodo': (params) => comisionesXPeriodo(params.prmPeriodoId),
  'WSComision|retornarComision': (params) => comision(params.prmComisionId),
};

export const fuenteBatch = {
  'WSLegislativo|retornarProyectoLey': async (boletines) => {
    if (!sql || boletines.length === 0) return [];
    return sql`select boletin, nombre, materias from proyectos where boletin = any(${boletines})`;
  },
};
