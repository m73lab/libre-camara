import { upsert } from '../sync/util.js';
import { divisionElectoral, diputadosPorDistrito } from '../data/distritos.js';
import { LOGOS_PARTIDOS } from '../data/logosPartidos.js';
import { supabase } from '../config/supabase.js';

const RE_BOLETIN = /^Bolet\u00edn\s*N[\u00b0\u00ba]\s*(\S+)/i;

const distritoPorNombre = new Map(
  diputadosPorDistrito.map(([distrito, nombre]) => [
    nombre.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(),
    distrito,
  ])
);

async function asegurarBase() {
  await upsert(
    'distritos',
    divisionElectoral.map((d) => ({
      numero: d.numero,
      region: d.region,
      circunscripcion: d.circunscripcion,
      senadores: d.senadores,
      diputados: d.diputados,
      comunas: d.comunas,
    })),
    'numero'
  );
}

function partidoActualDe(militancias) {
  if (!Array.isArray(militancias) || militancias.length === 0) return null;
  const validas = militancias.filter((m) => m.fechaInicio && !Number.isNaN(new Date(m.fechaInicio).getTime()));
  if (validas.length === 0) return null;
  return [...validas].sort((a, b) => new Date(b.fechaInicio) - new Date(a.fechaInicio))[0].partido || null;
}

async function inyectarDiputados(payload) {
  const lista = Array.isArray(payload) ? payload : [payload];
  const filasDiputados = [];
  const partidos = new Map();

  for (const d of lista) {
    const alias = partidoActualDe(d.militancias)?.alias || null;
    const clave = `${d.nombre || ''} ${d.apellidoPaterno || ''}`
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
    filasDiputados.push({
      id: d.id,
      nombre: d.nombre,
      nombre2: d.nombre2 || null,
      apellido_paterno: d.apellidoPaterno,
      apellido_materno: d.apellidoMaterno || null,
      fecha_nacimiento: d.fechaNacimiento ? String(d.fechaNacimiento).slice(0, 10) : null,
      sexo: d.sexo ? d.sexo.texto : null,
      distrito_numero: d.distrito?.numero ?? distritoPorNombre.get(clave) ?? null,
      partido_actual: alias,
    });
    for (const m of d.militancias || []) {
      if (m.partido?.alias && !partidos.has(m.partido.alias)) {
        partidos.set(m.partido.alias, m.partido);
      }
    }
  }

  await upsert('partidos',
    [...partidos.values()].map((p) => ({
      alias: p.alias,
      nombre: p.nombre,
      bloque: null,
      tiene_logo: Boolean(LOGOS_PARTIDOS[p.alias]),
    })),
    'alias'
  );
  await upsert('diputados', filasDiputados, 'id', 500);
}

async function inyectarVotacionesLista(data) {
  const filas = data.map((v) => {
    const m = RE_BOLETIN.exec(String(v.descripcion || ''));
    return {
      id: v.id,
      descripcion: v.descripcion,
      fecha: v.fecha,
      total_si: v.totalSi ?? 0,
      total_no: v.totalNo ?? 0,
      total_abstencion: v.totalAbstencion ?? 0,
      total_dispensado: v.totalDispensado ?? 0,
      quorum: v.quorum ? v.quorum.texto : null,
      resultado: v.resultado ? v.resultado.texto : null,
      tipo: v.tipo ? v.tipo.texto : null,
      anno: Number(String(v.fecha || '').slice(0, 4)),
      boletin: m ? m[1] : null,
    };
  });
  await upsert('votaciones', filas, 'id', 500);
}

async function inyectarVotacionDetalle(data) {
  const v = data;
  const m = RE_BOLETIN.exec(String(v.descripcion || ''));
  await upsert(
    'votaciones',
    [{
      id: v.id,
      descripcion: v.descripcion,
      fecha: v.fecha,
      total_si: v.totalSi ?? 0,
      total_no: v.totalNo ?? 0,
      total_abstencion: v.totalAbstencion ?? 0,
      total_dispensado: v.totalDispensado ?? 0,
      quorum: v.quorum ? v.quorum.texto : null,
      resultado: v.resultado ? v.resultado.texto : null,
      tipo: v.tipo ? v.tipo.texto : null,
      anno: Number(String(v.fecha || '').slice(0, 4)),
      boletin: m ? m[1] : null,
    }],
    'id'
  );
  const votos = (v.votos || [])
    .filter((voto) => voto.diputado?.id)
    .map((voto) => ({
      votacion_id: v.id,
      diputado_id: voto.diputado.id,
      opcion_voto: voto.opcionVoto ? voto.opcionVoto.texto : null,
    }));
  if (votos.length > 0) {
    await upsert('votos', votos, 'votacion_id,diputado_id', 1000);
  }
}

async function inyectarSesionesLista(data) {
  await upsert(
    'sesiones',
    data.map((s) => ({
      id: s.id,
      numero: s.numero,
      fecha_inicio: s.fechaInicio,
      fecha_termino: s.fechaTermino,
      tipo: s.tipo ? s.tipo.texto : null,
      estado: s.estado ? s.estado.texto : null,
      anno: Number(String(s.fechaInicio || '').slice(0, 4)),
    })),
    'id',
    500
  );
}

async function inyectarSesionDetalle(data) {
  const s = data;
  await upsert(
    'sesiones',
    [{
      id: s.id,
      numero: s.numero,
      fecha_inicio: s.fechaInicio,
      fecha_termino: s.fechaTermino,
      tipo: s.tipo ? s.tipo.texto : null,
      estado: s.estado ? s.estado.texto : null,
      anno: Number(String(s.fechaInicio || '').slice(0, 4)),
    }],
    'id'
  );
  const lista = Array.isArray(s.listadoAsistencia) ? s.listadoAsistencia : [];
  const filas = lista
    .filter((a) => a.diputado?.id)
    .map((a) => {
      const just = a.justificacion;
      const justObj = just && typeof just === 'object' ? just : null;
      return {
        sesion_id: s.id,
        diputado_id: a.diputado.id,
        tipo_asistencia: a.tipoAsistencia ? a.tipoAsistencia.texto : null,
        justificacion: justObj ? justObj.nombre ?? just : just ?? null,
        rebaja_asistencia: justObj ? String(justObj.rebajaAsistencia) === 'true' : null,
        rebaja_quorum: justObj ? String(justObj.rebajaQuorum) === 'true' : null,
      };
    });
  if (filas.length > 0) {
    await upsert('asistencias', filas, 'sesion_id,diputado_id', 1000);
  }
}

async function inyectarProyecto(data) {
  const p = data;
  if (!p || Object.keys(p).length === 0) return;
  await upsert(
    'proyectos',
    [{
      boletin: p.numeroBoletin,
      nombre: p.nombre,
      fecha_ingreso: p.fechaIngreso ? String(p.fechaIngreso).slice(0, 10) : null,
      tipo_iniciativa: p.tipoIniciativa ? p.tipoIniciativa.texto : null,
      camara_origen: p.camaraOrigen ? p.camaraOrigen.texto : null,
      admisible: p.admisible === true || p.admisible === 'true',
      anno: Number(String(p.fechaIngreso || '').slice(0, 4)),
      autores: (p.autores || []).map((a) => ({
        id: a.diputado?.id ?? a.id,
        nombre: a.diputado?.nombre,
        apellidoPaterno: a.diputado?.apellidoPaterno,
      })),
      ministerios: (p.ministeriosPatrocinantes || []).map((m) => ({ id: m.id, nombre: m.nombre })),
      materias: (p.materias || []).map((m) => ({ id: m.id, nombre: m.nombre })),
    }],
    'boletin'
  );
  const vinculos = (p.votaciones || []).map((v) => ({
    proyecto_boletin: p.numeroBoletin,
    votacion_id: v.id,
    articulo: v.articulo || null,
    tramite_constitucional: v.tramiteConstitucional ? v.tramiteConstitucional.texto : null,
    tramite_reglamentario: v.tramiteReglamentario ? v.tramiteReglamentario.texto : null,
  }));
  if (vinculos.length > 0) {
    await upsert('proyecto_votaciones', vinculos, 'proyecto_boletin,votacion_id', 1000);
  }
}

export async function inyectar(match, data) {
  if (!supabase || !match.db) return;
  try {
    await asegurarBase();
    const repo = match.db.repo;
    const metodo = match.db.metodo;
    if (repo === 'diputados') await inyectarDiputados(Array.isArray(data) ? data : data);
    else if (repo === 'votaciones' && metodo === 'votacionesPorAnno') await inyectarVotacionesLista(data);
    else if (repo === 'votaciones' && metodo === 'votacionDetalle') await inyectarVotacionDetalle(data);
    else if (repo === 'sesiones' && metodo === 'sesionesPorAnno') await inyectarSesionesLista(data);
    else if (repo === 'sesiones' && metodo === 'sesionDetalle') await inyectarSesionDetalle(data);
    else if (repo === 'proyectos') await inyectarProyecto(data);
    console.log(`[inyeccion] ${match.path} → supabase`);
  } catch (err) {
    console.error(`[inyeccion] ${match.path}: ${err.message}`);
  }
}
