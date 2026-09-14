import { fetchCachedData } from './fetchCached.js';
import { getAnnoDiputados } from './analitica.js';

const HORA = 3600;
const memo = new Map();

const RE_BOLETIN = /^Boletín\s*N°\s*(\S+)/i;
const RE_RESOLUCION = /^Proyecto de Resolución\s*N°\s*(\d+)/i;
const RE_ACUERDO = /^Proyecto de Acuerdo\s*N°\s*(\d+)/i;

async function buscarProyecto(boletin) {
  try {
    const { data } = await fetchCachedData(
      'WSLegislativo',
      'retornarProyectoLey',
      { prmNumeroBoletin: boletin },
      'single',
      HORA
    );
    if (!data || Object.keys(data).length === 0 || !data.nombre) return null;
    return {
      tipo: 'proyecto',
      boletin,
      nombre: data.nombre,
      materias: Array.isArray(data.materias) ? data.materias : [],
    };
  } catch {
    return null;
  }
}

async function buscarResolucion(numero, fechaVotacion) {
  const cand = await buscarSolicitud('resolucion', numero, fechaVotacion);
  if (!cand) return null;
  return { tipo: 'resolucion', numero: String(numero), nombre: cand.materia, materias: [] };
}

async function buscarAcuerdo(numero, fechaVotacion) {
  const cand = await buscarSolicitud('acuerdo', numero, fechaVotacion);
  if (!cand) return null;
  return { tipo: 'acuerdo', numero: String(numero), nombre: cand.materia, materias: [] };
}

const mapaSolicitudes = new Map();
const fallosSolicitudes = new Map();

function servicioSolicitudes(tipo) {
  return tipo === 'resolucion'
    ? ['WSProyectosResolucion', 'retornarProyectosResolucionXAnno']
    : ['WSProyectosAcuerdo', 'retornarProyectosAcuerdoXAnno'];
}

async function mapaSolicitudesDe(tipo, anno) {
  const key = `${tipo}|${anno}`;
  const cached = mapaSolicitudes.get(key);
  if (cached) return cached;
  const fallo = fallosSolicitudes.get(key);
  if (fallo && Date.now() - fallo < HORA * 1000) return null;
  try {
    const [servicio, metodo] = servicioSolicitudes(tipo);
    const { data } = await fetchCachedData(servicio, metodo, { prmAnno: anno }, 'collection', HORA);
    const m = new Map();
    for (const it of data || []) {
      if (it.numero !== undefined && it.numero !== null) {
        m.set(String(it.numero), { fechaIngreso: it.fechaIngreso || null, materia: it.materia || it.nombre || null });
      }
    }
    mapaSolicitudes.set(key, m);
    fallosSolicitudes.delete(key);
    return m;
  } catch {
    fallosSolicitudes.set(key, Date.now());
    return null;
  }
}

async function buscarSolicitud(tipo, numero, fechaVotacion) {
  const annoVot = new Date(fechaVotacion || Date.now()).getFullYear();
  if (Number.isNaN(annoVot)) return null;
  const num = String(numero);
  let respaldo = null;
  for (const a of [annoVot, annoVot - 1, annoVot - 2]) {
    const m = await mapaSolicitudesDe(tipo, a);
    const cand = m?.get(num);
    if (!cand?.materia) continue;
    if (!respaldo) respaldo = cand;
    if (cand.fechaIngreso && fechaVotacion && new Date(cand.fechaIngreso) <= new Date(fechaVotacion)) {
      return cand;
    }
  }
  return respaldo;
}

export function derivarEtapa(articulo) {
  const t = String(articulo || '');
  if (!t.trim()) return null;
  if (/comisi[oó]n mixta/i.test(t)) return 'Comisión Mixta';
  if (/modificaciones introducidas por el senado|enmienda del senado/i.test(t)) return 'Modificaciones del Senado';
  if (/segundo informe/i.test(t)) return 'Particular';
  if (/primer informe/i.test(t)) return 'General';
  if (/art[íi]culo|numeral|inciso|letra/i.test(t)) return 'Particular';
  return 'En general';
}

async function resolver(descripcion, fecha) {
  let match;
  if ((match = descripcion.match(RE_BOLETIN))) {
    const key = `b|${match[1]}`;
    if (!memo.has(key)) {
      const p = await buscarProyecto(match[1]);
      if (p) memo.set(key, p);
      return p;
    }
    return memo.get(key);
  }
  const annoVot = new Date(fecha || Date.now()).getFullYear();
  if ((match = descripcion.match(RE_RESOLUCION))) {
    const key = `r|${match[1]}|${annoVot}`;
    if (!memo.has(key)) {
      const r = await buscarResolucion(match[1], fecha);
      if (r) memo.set(key, r);
      return r;
    }
    return memo.get(key);
  }
  if ((match = descripcion.match(RE_ACUERDO))) {
    const key = `a|${match[1]}|${annoVot}`;
    if (!memo.has(key)) {
      const a = await buscarAcuerdo(match[1], fecha);
      if (a) memo.set(key, a);
      return a;
    }
    return memo.get(key);
  }
  return null;
}

export async function enriquecerVotacion(votacion) {
  if (!votacion || votacion.proyecto !== undefined) return votacion;
  const descripcion = votacion.descripcion || '';
  const proyecto = await resolver(descripcion, votacion.fecha);
  const salida = {
    ...votacion,
    proyecto,
    etapa: derivarEtapa(votacion.articulo),
    esElectronica: /^\d+\s*-?\s*Otros$/i.test(descripcion.trim()),
  };
  if (Array.isArray(votacion.contexto) && votacion.contexto.length > 0) {
    salida.contexto = await enriquecerVotaciones(votacion.contexto);
  }
  return salida;
}

export async function enriquecerVotaciones(lista) {
  const faltantes = [];
  const solicitudes = new Map();
  for (const votacion of lista) {
    const descripcion = String(votacion.descripcion || '');
    const m = RE_BOLETIN.exec(descripcion);
    if (m && !memo.has(`b|${m[1]}`)) faltantes.push(m[1]);
    const r = RE_RESOLUCION.exec(descripcion) || RE_ACUERDO.exec(descripcion);
    if (r) {
      const tipo = RE_RESOLUCION.test(descripcion) ? 'resolucion' : 'acuerdo';
      const annoVot = new Date(votacion.fecha || Date.now()).getFullYear();
      const key = `${tipo}|${r[1]}|${annoVot}`;
      if (!memo.has(key) && !solicitudes.has(key)) {
        solicitudes.set(key, { tipo, numero: r[1], fecha: votacion.fecha });
      }
    }
  }
  if (faltantes.length > 0) {
    await precalentarProyectos(faltantes);
  }
  for (const [key, s] of solicitudes) {
    const nombre = s.tipo === 'resolucion'
      ? await buscarResolucion(s.numero, s.fecha)
      : await buscarAcuerdo(s.numero, s.fecha);
    if (nombre) memo.set(key, nombre);
  }
  const salida = [];
  for (const votacion of lista) {
    salida.push(await enriquecerVotacion(votacion));
  }
  return salida;
}

export async function precalentarProyectos(boletines) {
  const unicos = [...new Set(boletines)].filter((b) => b && !memo.has(`b|${b}`));
  if (unicos.length === 0) return;
  const { fuenteBatch, usarBd } = await import('../modules/fuente.js');
  if (!usarBd()) return;
  try {
    const filas = await fuenteBatch['WSLegislativo|retornarProyectoLey'](unicos);
    for (const f of filas) {
      memo.set(`b|${f.boletin}`, {
        tipo: 'proyecto',
        boletin: f.boletin,
        nombre: f.nombre,
        materias: f.materias || [],
      });
    }
    // los no encontrados no se memoizan: reintentan en la próxima pasada
    // (un null puede deberse a un rate-limit transitorio del upstream)
  } catch {
    // el batch falla: los resolver individuales cubrirán
  }
}

export async function calentarLegible(anno) {
  const { data } = await fetchCachedData(
    'WSLegislativo',
    'retornarVotacionesXAnno',
    { prmAnno: Number(anno) },
    'collection',
    300
  );
  await enriquecerVotaciones(data);
  console.log(`[legible] ${memo.size} proyectos resueltos para ${anno}`);
}

const perfilMemo = new Map();

async function perfilesDelAnno(anno) {
  if (!perfilMemo.has(anno)) {
    const roster = await getAnnoDiputados(anno);
    perfilMemo.set(
      anno,
      new Map(
        roster.map((d) => [
          String(d.id),
          {
            distrito: d.distrito ? d.distrito.numero : null,
            partido: d.partidoAnno
              ? { alias: d.partidoAnno.alias, nombre: d.partidoAnno.nombre }
              : null,
          },
        ])
      )
    );
  }
  return perfilMemo.get(anno);
}

export async function enriquecerVotosConPerfil(votacion) {
  if (!votacion || !Array.isArray(votacion.votos)) return votacion;
  const anno = String(new Date(votacion.fecha || Date.now()).getFullYear());
  const perfiles = await perfilesDelAnno(anno);
  return {
    ...votacion,
    votos: votacion.votos.map((voto) => ({
      ...voto,
      diputado: voto.diputado
        ? { ...voto.diputado, ...(perfiles.get(String(voto.diputado.id)) || {}) }
        : voto.diputado,
    })),
  };
}
