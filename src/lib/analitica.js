import { cache, fetchCachedData, mapConcurrent } from './fetchCached.js';
import { guardarAnalitica, leerAnalitica } from '../modules/analiticasDb.js';
import { enriquecerConDistrito } from './distritos.js';
import { calcularContrafactual, clasificarAsistencia, clasificarVoto, requeridoPara } from './quorum.js';

const HORA = 3600;

function ageAnios(fechaIngreso) {
  const inicio = new Date(fechaIngreso);
  if (Number.isNaN(inicio.getTime())) return null;
  return (Date.now() - inicio.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
}

async function getProyecto(boletin) {
  const { data } = await fetchCachedData(
    'WSLegislativo',
    'retornarProyectoLey',
    { prmNumeroBoletin: boletin },
    'single',
    HORA
  );
  return data;
}

export async function getMocionesIndex(anno) {
  const cacheKey = `analitica.mociones.${anno}`;
  const enBd = await leerAnalitica(cacheKey);
  if (enBd !== undefined) {
    cache.set(cacheKey, enBd, 6 * HORA);
    return enBd;
  }

  const { data: mociones } = await fetchCachedData(
    'WSLegislativo',
    'retornarMocionesXAnno',
    { prmAnno: Number(anno) },
    'collection',
    300
  );

  const index = await mapConcurrent(mociones, 20, async (mocion) => {
    const proyecto = await getProyecto(mocion.numeroBoletin);
    if (!proyecto || Object.keys(proyecto).length === 0) return null;
    return {
      boletin: mocion.numeroBoletin,
      id: mocion.id,
      nombre: proyecto.nombre || mocion.nombre,
      fechaIngreso: proyecto.fechaIngreso || mocion.fechaIngreso,
      admisible: proyecto.admisible,
      materias: Array.isArray(proyecto.materias) ? proyecto.materias : [],
      votaciones: Array.isArray(proyecto.votaciones) ? proyecto.votaciones.length : 0,
      autores: Array.isArray(proyecto.autores) ? proyecto.autores : [],
    };
  });

  const data = index.filter(Boolean);
  persistir(cacheKey, data, 6 * HORA);
  return data;
}

export async function getComisionesIndex() {
  const cacheKey = 'analitica.comisiones.v3';
  const enBd = await leerAnalitica(cacheKey);
  if (enBd !== undefined) {
    cache.set(cacheKey, enBd, 6 * HORA);
    return enBd;
  }

  const listas = [];
  for (const periodo of [10, 11]) {
    const { data } = await fetchCachedData(
      'WSComision',
      'retornarComisionesXPeriodo',
      { prmPeriodoId: periodo },
      'collection',
      300
    );
    listas.push(...data);
  }

  const index = await mapConcurrent(listas, 20, async (comision) => {
    const { data: detalle } = await fetchCachedData(
      'WSComision',
      'retornarComision',
      { prmComisionId: Number(comision.id) },
      'single',
      HORA
    );
    if (!detalle || Object.keys(detalle).length === 0) return null;
    const integrantes = Array.isArray(detalle.integrantes)
      ? detalle.integrantes
          .map((i) => ({
            diputadoId: i.diputado?.id,
            nombre: i.diputado?.nombre,
            apellidoPaterno: i.diputado?.apellidoPaterno,
            apellidoMaterno: i.diputado?.apellidoMaterno,
            fechaInicio: i.fechaInicio,
            fechaTermino: i.fechaTermino,
          }))
          .filter((i) => i.diputadoId)
      : [];
    const inicioPeriodoActual = new Date('2026-03-10').getTime();
    return {
      id: detalle.id,
      nombre: detalle.nombre,
      tipo: detalle.tipo ? detalle.tipo.texto : null,
      numero: detalle.numero,
      fechaInicio: detalle.fechaInicio,
      fechaTermino: detalle.fechaTermino || null,
      disuelta: Boolean(detalle.fechaTermino) ||
        (detalle.tipo?.texto !== 'Permanente' &&
          new Date(detalle.fechaInicio || 0).getTime() < inicioPeriodoActual),
      presidente: detalle.presidente
        ? {
            diputadoId: detalle.presidente.id,
            nombre: detalle.presidente.nombre,
            apellidoPaterno: detalle.presidente.apellidoPaterno,
          }
        : null,
      integrantes,
    };
  });

  const data = index.filter(Boolean);
  persistir(cacheKey, data, 6 * HORA);
  return data;
}

export async function getAsistenciaMatriz(anno) {
  const cacheKey = `analitica.asistencia.v2.${anno}`;
  const enBd = await leerAnalitica(cacheKey);
  if (enBd !== undefined) {
    cache.set(cacheKey, enBd, 6 * HORA);
    return enBd;
  }

  const { data: sesiones } = await fetchCachedData(
    'WSSala',
    'retornarSesionesXAnno',
    { prmAnno: Number(anno) },
    'collection',
    300
  );

  const matriz = new Map();
  await mapConcurrent(sesiones, 20, async (sesion) => {
    const { data: detalle } = await fetchCachedData(
      'WSSala',
      'retornarSesionAsistencia',
      { prmSesionId: Number(sesion.id) },
      'single',
      HORA
    );
    const lista = Array.isArray(detalle.listadoAsistencia) ? detalle.listadoAsistencia : [];
    const fecha = String(sesion.fechaInicio || '').slice(0, 10);
    for (const asiento of lista) {
      if (!asiento.diputado?.id) continue;
      const just = asiento.justificacion;
      const justObj = just && typeof just === 'object' ? just : null;
      const justificacion = justObj ? justObj.nombre ?? just : null;
      const cls = clasificarAsistencia(asiento.tipoAsistencia?.texto, justificacion);
      const id = String(asiento.diputado.id);
      if (!matriz.has(id)) {
        matriz.set(id, { presente: 0, ausente: 0, justificado: 0, sinJustificar: 0, justificadoSinRebaja: 0, justificadoConRebaja: 0, primera: null });
      }
      const fila = matriz.get(id);
      fila[cls] += 1;
      if (fecha && (!fila.primera || fecha < fila.primera)) fila.primera = fecha;
      if (cls === 'ausente') fila.sinJustificar += 1;
      else if (cls === 'justificado') {
        if (justObj && String(justObj.rebajaAsistencia) === 'true') fila.justificadoConRebaja += 1;
        else fila.justificadoSinRebaja += 1;
      }
    }
  });

  const data = Object.fromEntries(matriz);
  persistir(cacheKey, data, 6 * HORA);
  return data;
}

export async function getVotacionMatriz(anno) {
  const cacheKey = `analitica.votaciones.v2.${anno}`;
  const enBd = await leerAnalitica(cacheKey);
  if (enBd !== undefined) {
    cache.set(cacheKey, enBd, 6 * HORA);
    return enBd;
  }

  const { data: votaciones } = await fetchCachedData(
    'WSLegislativo',
    'retornarVotacionesXAnno',
    { prmAnno: Number(anno) },
    'collection',
    300
  );

  const matriz = new Map();
  await mapConcurrent(votaciones, 20, async (votacion) => {
    const { data: detalle } = await fetchCachedData(
      'WSLegislativo',
      'retornarVotacionDetalle',
      { prmVotacionId: Number(votacion.id) },
      'single',
      HORA
    );
    const votos = Array.isArray(detalle.votos) ? detalle.votos : [];
    const fecha = String(votacion.fecha || '').slice(0, 10);
    for (const voto of votos) {
      if (!voto.diputado?.id) continue;
      const cls = clasificarVoto(voto.opcionVoto?.texto);
      const id = String(voto.diputado.id);
      if (!matriz.has(id)) matriz.set(id, { emitido: 0, dispensado: 0, noVota: 0, ausente: 0, primera: null });
      const fila = matriz.get(id);
      fila[cls] += 1;
      if (fecha && (!fila.primera || fecha < fila.primera)) fila.primera = fecha;
    }
  });

  const data = Object.fromEntries(matriz);
  persistir(cacheKey, data, 6 * HORA);
  return data;
}

export async function getContrafactuales(anno) {
  const cacheKey = `analitica.contrafactuales.v2.${anno}`;
  const enBd = await leerAnalitica(cacheKey);
  if (enBd !== undefined) {
    cache.set(cacheKey, enBd, 6 * HORA);
    return enBd;
  }

  const { data: votaciones } = await fetchCachedData(
    'WSLegislativo',
    'retornarVotacionesXAnno',
    { prmAnno: Number(anno) },
    'collection',
    300
  );

  const { data: roster } = await fetchCachedData(
    'WSDiputado',
    'retornarDiputadosPeriodoActual',
    {},
    'collection',
    600
  );
  const rosterIds = new Set(roster.map((d) => String(d.diputado?.id ?? d.id)));

  const rechazadas = votaciones.filter((v) => v.resultado?.texto?.startsWith('Rechaz'));
  let parcial = false;
  const items = await mapConcurrent(rechazadas, 20, async (votacion) => {
    try {
      const { data: detalle } = await fetchCachedData(
        'WSLegislativo',
        'retornarVotacionDetalle',
        { prmVotacionId: Number(votacion.id) },
        'single',
        HORA
      );
      const votos = Array.isArray(detalle.votos) ? detalle.votos : [];
    const contrafactual = calcularContrafactual(votacion, votos);

    const listados = new Set(votos.map((v) => String(v.diputado?.id)));
    const rosterFlat = roster.map((d) => d.diputado ?? d);
    const partidoPorId = new Map(
      rosterFlat
        .map((d) => {
          const p = partidoEnAnno(d, anno);
          return [String(d.id), p ? { alias: p.alias, nombre: p.nombre } : null];
        })
        .filter(([, p]) => p)
    );
    const conPartido = (d) => ({
      id: d.id,
      nombre: d.nombre,
      apellidoPaterno: d.apellidoPaterno,
      partido: partidoPorId.get(String(d.id)) || null,
    });
    const ausentesDetalle = rosterFlat
      .filter((d) => !listados.has(String(d.id)))
      .map(conPartido);
    const noVotaronDetalle = votos
      .filter((v) => v.opcionVoto?.texto === 'No Vota')
      .map((v) => ({
        id: v.diputado?.id,
        nombre: v.diputado?.nombre,
        apellidoPaterno: v.diputado?.apellidoPaterno,
      }))
      .filter((d) => d.id)
      .map(conPartido);

    return {
      id: votacion.id,
      descripcion: votacion.descripcion,
      fecha: votacion.fecha,
      quorum: votacion.quorum?.texto || null,
      tipo: votacion.tipo?.texto || null,
      si: votacion.totalSi,
      no: votacion.totalNo,
      abstencion: votacion.totalAbstencion,
      dispensado: votacion.totalDispensado,
      ...contrafactual,
      ausentesDetalle,
      noVotaronDetalle,
    };
    } catch {
      parcial = true;
      return null;
    }
  });

  const data = {
    parcial,
    items: items
      .filter((item) => item && item.faltaron !== null)
      .sort((a, b) => {
        if (a.habrianAlcanzado !== b.habrianAlcanzado) return a.habrianAlcanzado ? -1 : 1;
        return a.faltaron - b.faltaron;
      }),
  };
  persistir(cacheKey, data, 6 * HORA);
  return data;
}

const PESOS_SCORE_DEFECTO = [0.4, 0.25, 0.2, 0.15];

export function leerPesosScore() {
  const crudo = String(process.env.SCORE_PESOS || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n >= 0);
  if (crudo.length !== 4) return [...PESOS_SCORE_DEFECTO];
  const suma = crudo.reduce((a, b) => a + b, 0);
  if (suma <= 0) return [...PESOS_SCORE_DEFECTO];
  return crudo.map((n) => n / suma);
}

export async function getRankings(anno) {
  const cacheKey = `analitica.rankings.v2.${anno}`;
  const enBd = await leerAnalitica(cacheKey);
  if (enBd !== undefined) {
    cache.set(cacheKey, enBd, 6 * HORA);
    return enBd;
  }

  const [asistencia, votaciones, mociones, roster, sesionesRes, votacionesRes] = await Promise.all([
    getAsistenciaMatriz(anno),
    getVotacionMatriz(anno),
    getMocionesIndex(anno),
    getAnnoDiputados(anno),
    fetchCachedData('WSSala', 'retornarSesionesXAnno', { prmAnno: Number(anno) }, 'collection', 300),
    fetchCachedData('WSLegislativo', 'retornarVotacionesXAnno', { prmAnno: Number(anno) }, 'collection', 300),
  ]);

  const totalSesiones = sesionesRes.data.length;
  const totalVotaciones = votacionesRes.data.length;
  const fechasSesiones = sesionesRes.data
    .map((s) => String(s.fechaInicio || '').slice(0, 10))
    .filter(Boolean);
  const fechasVotaciones = votacionesRes.data
    .map((v) => String(v.fecha || '').slice(0, 10))
    .filter(Boolean);
  const pesos = leerPesosScore();
  const [pAsistencia, pParticipacion, pMociones, pAvance] = pesos;

  const mocionesPorDiputado = new Map();
  const mocionesAvanzadasPorDiputado = new Map();
  for (const mocion of mociones) {
    for (const autor of mocion.autores) {
      const id = String(autor.diputado?.id ?? autor.id);
      mocionesPorDiputado.set(id, (mocionesPorDiputado.get(id) || 0) + 1);
      if (mocion.votaciones > 0) {
        mocionesAvanzadasPorDiputado.set(id, (mocionesAvanzadasPorDiputado.get(id) || 0) + 1);
      }
    }
  }

  const maxMociones = Math.max(1, ...[...mocionesPorDiputado.values()]);
  const maxAvance = Math.max(1, ...[...mocionesAvanzadasPorDiputado.values()]);
  const resultado = roster
    .map((diputado) => {
      const id = String(diputado.id);
      const a = asistencia[id] || { presente: 0, ausente: 0, justificado: 0, sinJustificar: 0, justificadoSinRebaja: 0, justificadoConRebaja: 0 };
      const v = votaciones[id] || { emitido: 0, dispensado: 0, noVota: 0, ausente: 0 };
      if (totalSesiones === 0 && totalVotaciones === 0) return null;
      const mocionesDiputado = mocionesPorDiputado.get(id) || 0;
      const mocionesAvanzadas = mocionesAvanzadasPorDiputado.get(id) || 0;

      const primera = [a.primera, v.primera].filter(Boolean).sort()[0] || null;
      const sesionesBase = primera
        ? fechasSesiones.filter((f) => f >= primera).length
        : totalSesiones;
      const votacionesBase = primera
        ? fechasVotaciones.filter((f) => f >= primera).length
        : totalVotaciones;

      const asistenciaPct = sesionesBase ? a.presente / sesionesBase : 0;
      const participacionPct = votacionesBase ? v.emitido / votacionesBase : 0;
      const mocionesRel = mocionesDiputado / maxMociones;
      const avanceRel = mocionesAvanzadas / maxAvance;
      const score = Math.round(100 * (pAsistencia * asistenciaPct + pParticipacion * participacionPct + pMociones * mocionesRel + pAvance * avanceRel));

      return {
        id: diputado.id,
        nombre: diputado.nombre,
        nombre2: diputado.nombre2,
        apellidoPaterno: diputado.apellidoPaterno,
        apellidoMaterno: diputado.apellidoMaterno,
        distrito: diputado.distrito ? diputado.distrito.numero : null,
        partido: diputado.partidoAnno
          ? { id: diputado.partidoAnno.id, nombre: diputado.partidoAnno.nombre, alias: diputado.partidoAnno.alias }
          : null,
        asistencia: {
          presente: a.presente,
          ausente: Math.max(0, sesionesBase - a.presente - a.justificado),
          justificado: a.justificado,
          pct: Math.round(asistenciaPct * 100),
        },
        votos: {
          emitido: v.emitido,
          dispensado: v.dispensado,
          noVota: v.noVota,
          ausente: Math.max(0, votacionesBase - v.emitido - v.dispensado - v.noVota),
          pct: Math.round(participacionPct * 100),
        },
        sesionesBase,
        votacionesBase,
        primeraAparicion: primera,
        mociones: mocionesDiputado,
        mocionesAvanzadas,
        tasaExito: mocionesDiputado ? Math.round((mocionesAvanzadas / mocionesDiputado) * 100) : 0,
        score,
      };
    })
    .sort((a, b) => b.score - a.score);
  persistir(cacheKey, resultado, 6 * HORA);
  return resultado;
}

export async function getCementerio(anno) {
  const cacheKey = `analitica.cementerio.${anno}`;
  const enBd = await leerAnalitica(cacheKey);
  if (enBd !== undefined) {
    cache.set(cacheKey, enBd, 6 * HORA);
    return enBd;
  }

  const [mocionesRes, mensajesRes] = await Promise.all([
    fetchCachedData('WSLegislativo', 'retornarMocionesXAnno', { prmAnno: Number(anno) }, 'collection', 300),
    fetchCachedData('WSLegislativo', 'retornarMensajesXAnno', { prmAnno: Number(anno) }, 'collection', 300),
  ]);

  const proyectos = [...mocionesRes.data, ...mensajesRes.data];
  const items = await mapConcurrent(proyectos, 20, async (p) => {
    const detalle = await getProyecto(p.numeroBoletin);
    if (!detalle || Object.keys(detalle).length === 0) return null;
    return {
      boletin: p.numeroBoletin,
      nombre: detalle.nombre || p.nombre,
      fechaIngreso: detalle.fechaIngreso || p.fechaIngreso,
      tipoIniciativa: detalle.tipoIniciativa ? detalle.tipoIniciativa.texto : null,
      admisible: detalle.admisible,
      materias: Array.isArray(detalle.materias) ? detalle.materias.map((m) => m.nombre) : [],
      votaciones: Array.isArray(detalle.votaciones) ? detalle.votaciones.length : 0,
      edadAnios: ageAnios(detalle.fechaIngreso || p.fechaIngreso),
    };
  });

  const data = items.filter(Boolean);
  persistir(cacheKey, data, 6 * HORA);
  return data;
}

async function getRosterEnriquecido() {
  const { data } = await fetchCachedData(
    'WSDiputado',
    'retornarDiputadosPeriodoActual',
    {},
    'collection',
    600
  );
  return enriquecerConDistrito(data.map((d) => d.diputado ?? d));
}

export async function getAnnoDiputados(anno) {
  const cacheKey = `analitica.diputados.${anno}`;
  const enBd = await leerAnalitica(cacheKey);
  if (enBd !== undefined) {
    cache.set(cacheKey, enBd, 6 * HORA);
    return enBd;
  }

  if (String(anno) === String(new Date().getFullYear())) {
    const rosterActual = await getRosterEnriquecido();
    const data = rosterActual.map((d) => ({
      ...d,
      partidoAnno: partidoEnAnno(d, anno),
    }));
    persistir(cacheKey, data, 6 * HORA);
    return data;
  }

  const [sesionesRes, votacionesRes] = await Promise.all([
    fetchCachedData('WSSala', 'retornarSesionesXAnno', { prmAnno: Number(anno) }, 'collection', 300),
    fetchCachedData('WSLegislativo', 'retornarVotacionesXAnno', { prmAnno: Number(anno) }, 'collection', 300),
  ]);

  const mapa = new Map();
  await mapConcurrent(votacionesRes.data, 10, async (votacion) => {
    const { data: detalle } = await fetchCachedData(
      'WSLegislativo',
      'retornarVotacionDetalle',
      { prmVotacionId: Number(votacion.id) },
      'single',
      HORA
    );
    for (const voto of detalle.votos || []) {
      if (voto.diputado?.id) mapa.set(String(voto.diputado.id), voto.diputado);
    }
  });
  await mapConcurrent(sesionesRes.data, 10, async (sesion) => {
    const { data: detalle } = await fetchCachedData(
      'WSSala',
      'retornarSesionAsistencia',
      { prmSesionId: Number(sesion.id) },
      'single',
      HORA
    );
    for (const asiento of detalle.listadoAsistencia || []) {
      if (asiento.diputado?.id) mapa.set(String(asiento.diputado.id), asiento.diputado);
    }
  });

  const rosterActual = await getRosterEnriquecido();
  const datosActuales = new Map(rosterActual.map((d) => [String(d.id), d]));
  const enriquecidos = enriquecerConDistrito([...mapa.values()]);
  const data = await mapConcurrent(enriquecidos, 20, async (d) => {
    const actual = datosActuales.get(String(d.id));
    let partido = actual ? partidoEnAnno(actual, anno) : null;
    let sexo = d.sexo || (actual ? actual.sexo : null) || null;
    let fechaNacimiento = d.fechaNacimiento || (actual ? actual.fechaNacimiento : null) || null;
    if (!partido) {
      const { data: detalle } = await fetchCachedData(
        'WSDiputado',
        'retornarDiputado',
        { prmDiputadoId: Number(d.id) },
        'single',
        HORA
      );
      if (detalle && Object.keys(detalle).length > 0) {
        partido = partidoEnAnno(detalle, anno);
        sexo = sexo || detalle.sexo || null;
        fechaNacimiento = fechaNacimiento || detalle.fechaNacimiento || null;
      }
    }
    return {
      ...d,
      sexo,
      fechaNacimiento,
      partidoAnno: partido,
    };
  });

  persistir(cacheKey, data, 6 * HORA);
  return data;
}

function partidoEnAnno(diputado, anno) {
  const militancias = Array.isArray(diputado.militancias) ? diputado.militancias : [];
  const inicio = `${anno}-01-01`;
  const fin = `${anno}-12-31`;
  const activas = militancias.filter((m) => {
    if (!m.fechaInicio) return false;
    if (m.fechaInicio > fin) return false;
    if (m.fechaTermino && m.fechaTermino < inicio) return false;
    return true;
  });
  if (activas.length === 0) return null;
  return [...activas].sort((a, b) => new Date(b.fechaInicio) - new Date(a.fechaInicio))[0].partido || null;
}

function rangoEdad(edad) {
  if (edad === null) return 'Sin dato';
  if (edad < 40) return '25-39';
  if (edad < 55) return '40-54';
  if (edad < 70) return '55-69';
  return '70+';
}

export async function getCohesion(anno) {
  const cacheKey = `analitica.cohesion.${anno}`;
  const enBd = await leerAnalitica(cacheKey);
  if (enBd !== undefined) {
    cache.set(cacheKey, enBd, 6 * HORA);
    return enBd;
  }

  const { data: votaciones } = await fetchCachedData(
    'WSLegislativo',
    'retornarVotacionesXAnno',
    { prmAnno: Number(anno) },
    'collection',
    300
  );
  const roster = await getRosterEnriquecido();
  const partidoPorDiputado = new Map(
    roster.map((d) => [String(d.id), partidoEnAnno(d, anno)])
  );

  const partidos = new Map();
  const rebeliones = new Map();

  await mapConcurrent(votaciones, 20, async (votacion) => {
    const { data: detalle } = await fetchCachedData(
      'WSLegislativo',
      'retornarVotacionDetalle',
      { prmVotacionId: Number(votacion.id) },
      'single',
      HORA
    );
    const votos = Array.isArray(detalle.votos) ? detalle.votos : [];
    const grupos = new Map();
    for (const voto of votos) {
      const partido = partidoPorDiputado.get(String(voto.diputado?.id));
      if (!partido) continue;
      if (!grupos.has(partido.id)) grupos.set(partido.id, { alias: partido.alias, nombre: partido.nombre, af: 0, ec: 0 });
      const g = grupos.get(partido.id);
      if (voto.opcionVoto?.texto === 'Afirmativo') g.af += 1;
      else if (voto.opcionVoto?.texto === 'En Contra') g.ec += 1;
    }
    for (const [, g] of grupos) {
      if (g.af + g.ec < 2) continue;
      const posicion = g.af > g.ec ? 'af' : g.ec > g.af ? 'ec' : null;
      if (!posicion) continue;
      if (!partidos.has(g.alias)) {
        partidos.set(g.alias, { alias: g.alias, nombre: g.nombre, cohesionSum: 0, votaciones: 0 });
      }
      const p = partidos.get(g.alias);
      p.cohesionSum += Math.max(g.af, g.ec) / (g.af + g.ec);
      p.votaciones += 1;
    }
    for (const voto of votos) {
      const partido = partidoPorDiputado.get(String(voto.diputado?.id));
      if (!partido) continue;
      const g = grupos.get(partido.id);
      if (!g) continue;
      const posicion = g.af > g.ec ? 'af' : g.ec > g.af ? 'ec' : null;
      if (!posicion) continue;
      const votante = String(voto.diputado.id);
      if (!rebeliones.has(votante)) rebeliones.set(votante, { votaciones: 0, rebeliones: 0 });
      const r = rebeliones.get(votante);
      r.votaciones += 1;
      const votoPos = voto.opcionVoto?.texto === 'Afirmativo' ? 'af' : voto.opcionVoto?.texto === 'En Contra' ? 'ec' : null;
      if (votoPos && votoPos !== posicion) r.rebeliones += 1;
    }
  });

  const nombrePorId = new Map(roster.map((d) => [String(d.id), d]));
  const data = [...partidos.values()]
    .map((p) => ({
      alias: p.alias,
      nombre: p.nombre,
      cohesion: Math.round((p.cohesionSum / p.votaciones) * 1000) / 10,
      votacionesAnalizadas: p.votaciones,
      diputados: 0,
      rebeldes: [],
    }))
    .sort((a, b) => a.cohesion - b.cohesion);

  const partidoPorAlias = new Map(data.map((p) => [p.alias, p]));
  for (const [diputadoId, r] of rebeliones) {
    const diputado = nombrePorId.get(diputadoId);
    const partido = partidoPorDiputado.get(diputadoId);
    if (!diputado || !partido) continue;
    const p = partidoPorAlias.get(partido.alias);
    if (!p) continue;
    p.diputados += 1;
    if (r.votaciones >= 50 && r.rebeliones >= 10) {
      p.rebeldes.push({
        id: diputado.id,
        nombre: diputado.nombre,
        apellidoPaterno: diputado.apellidoPaterno,
        rebeliones: r.rebeliones,
        votaciones: r.votaciones,
        tasa: Math.round((r.rebeliones / r.votaciones) * 1000) / 10,
      });
    }
  }
  for (const p of data) p.rebeldes.sort((a, b) => b.tasa - a.tasa);

  persistir(cacheKey, data, 6 * HORA);
  return data;
}

export async function getDieta(anno) {
  const cacheKey = `analitica.dieta.${anno}`;
  const enBd = await leerAnalitica(cacheKey);
  if (enBd !== undefined) {
    cache.set(cacheKey, enBd, 6 * HORA);
    return enBd;
  }

  const [asistencia, roster, sesionesRes] = await Promise.all([
    getAsistenciaMatriz(anno),
    getAnnoDiputados(anno),
    fetchCachedData('WSSala', 'retornarSesionesXAnno', { prmAnno: Number(anno) }, 'collection', 300),
  ]);

  const dietaMensual = Number(process.env.DIETA_MENSUAL || 8900000);
  const totalSesiones = sesionesRes.data.length;
  const valorPorSesion = totalSesiones ? Math.round((dietaMensual * 12) / totalSesiones) : 0;

  const data = roster
    .map((diputado) => {
      const id = String(diputado.id);
      const a = asistencia[id] || { presente: 0, sinJustificar: 0, justificadoSinRebaja: 0, justificadoConRebaja: 0, ausente: 0, justificado: 0 };
      const cobroSinEstar = a.sinJustificar + a.justificadoSinRebaja;
      return {
        id: diputado.id,
        nombre: diputado.nombre,
        apellidoPaterno: diputado.apellidoPaterno,
        distrito: diputado.distrito ? diputado.distrito.numero : null,
        partido: diputado.partidoAnno ? diputado.partidoAnno.alias : null,
        presente: a.presente,
        sinJustificar: a.sinJustificar,
        justificadoSinRebaja: a.justificadoSinRebaja,
        justificadoConRebaja: a.justificadoConRebaja,
        totalSesiones: a.presente + a.ausente + a.justificado,
        cobroSinEstar,
        cobroEstimado: cobroSinEstar * valorPorSesion,
      };
    })
    .sort((a, b) => b.cobroSinEstar - a.cobroSinEstar);

  persistir(cacheKey, { data, valorPorSesion, dietaMensual, totalSesiones }, 6 * HORA);
  return { data, valorPorSesion, dietaMensual, totalSesiones };
}

export async function getHorarios(anno) {
  const cacheKey = `analitica.horarios.${anno}`;
  const enBd = await leerAnalitica(cacheKey);
  if (enBd !== undefined) {
    cache.set(cacheKey, enBd, 6 * HORA);
    return enBd;
  }

  const [sesionesRes, votacionesRes] = await Promise.all([
    fetchCachedData('WSSala', 'retornarSesionesXAnno', { prmAnno: Number(anno) }, 'collection', 300),
    fetchCachedData('WSLegislativo', 'retornarVotacionesXAnno', { prmAnno: Number(anno) }, 'collection', 300),
  ]);

  const sesiones = sesionesRes.data
    .map((s) => {
      const inicio = new Date(s.fechaInicio);
      const termino = new Date(s.fechaTermino);
      const duracionMin = !Number.isNaN(inicio.getTime()) && !Number.isNaN(termino.getTime())
        ? Math.round((termino.getTime() - inicio.getTime()) / 60000)
        : null;
      return {
        id: s.id,
        numero: s.numero,
        fechaInicio: s.fechaInicio,
        duracionMin,
        terminoMadrugada:
          duracionMin !== null &&
          termino.getHours() >= 0 &&
          termino.getHours() < 8 &&
          termino.getDate() !== inicio.getDate(),
        tipo: s.tipo?.texto || null,
      };
    })
    .sort((a, b) => (b.duracionMin ?? 0) - (a.duracionMin ?? 0));

  const votaciones = votacionesRes.data;
  const porHora = Array.from({ length: 24 }, () => 0);
  const deMadrugada = [];
  for (const v of votaciones) {
    const fecha = new Date(v.fecha);
    if (Number.isNaN(fecha.getTime())) continue;
    porHora[fecha.getHours()] += 1;
    if (fecha.getHours() >= 0 && fecha.getHours() < 6) {
      deMadrugada.push({
        id: v.id,
        descripcion: v.descripcion,
        fecha: v.fecha,
        hora: fecha.toTimeString().slice(0, 5),
      });
    }
  }
  deMadrugada.sort((a, b) => new Date(a.fecha) - new Date(b.fecha));

  const data = {
    sesiones,
    sesionesMaratonicas: sesiones.filter((s) => s.duracionMin !== null && s.duracionMin >= 600),
    sesionesTerminaronMadrugada: sesiones.filter((s) => s.terminoMadrugada),
    duracionPromedioMin: Math.round(
      sesiones.filter((s) => s.duracionMin !== null).reduce((acc, s) => acc + s.duracionMin, 0) /
        Math.max(1, sesiones.filter((s) => s.duracionMin !== null).length)
    ),
    votacionesPorHora: porHora,
    votacionesMadrugada: deMadrugada,
    votacionesTotal: votaciones.length,
  };
  persistir(cacheKey, data, 6 * HORA);
  return data;
}

export async function getBrechas(anno) {
  const cacheKey = `analitica.brechas.${anno}`;
  const enBd = await leerAnalitica(cacheKey);
  if (enBd !== undefined) {
    cache.set(cacheKey, enBd, 6 * HORA);
    return enBd;
  }

  const [asistencia, votacionesRes, roster, sesionesRes] = await Promise.all([
    getAsistenciaMatriz(anno),
    fetchCachedData('WSLegislativo', 'retornarVotacionesXAnno', { prmAnno: Number(anno) }, 'collection', 300),
    getAnnoDiputados(anno),
    fetchCachedData('WSSala', 'retornarSesionesXAnno', { prmAnno: Number(anno) }, 'collection', 300),
  ]);

  const totalSesiones = sesionesRes.data.length;
  const sexoPorDiputado = new Map(roster.map((d) => [String(d.id), d.sexo?.texto || 'Sin dato']));
  const edadPorDiputado = new Map(
    roster.map((d) => [
      String(d.id),
      d.fechaNacimiento ? new Date().getFullYear() - new Date(d.fechaNacimiento).getFullYear() : null,
    ])
  );

  const grupos = {
    'Femenino': { n: 0, asisSum: 0 },
    'Masculino': { n: 0, asisSum: 0 },
  };
  const porEdad = new Map();
  for (const d of roster) {
    const id = String(d.id);
    const a = asistencia[id] || { presente: 0, ausente: 0, justificado: 0 };
    if (totalSesiones === 0) continue;
    const asisPct = a.presente / totalSesiones;
    const sexo = d.sexo?.texto || 'Sin dato';
    if (grupos[sexo]) {
      grupos[sexo].n += 1;
      grupos[sexo].asisSum += asisPct;
    }
    const rango = rangoEdad(edadPorDiputado.get(id));
    if (!porEdad.has(rango)) porEdad.set(rango, { n: 0, asisSum: 0 });
    const g = porEdad.get(rango);
    g.n += 1;
    g.asisSum += asisPct;
  }

  const porPartido = new Map();
  const porDistrito = new Map();
  for (const d of roster) {
    const sexo = d.sexo?.texto;
    const esMujer = sexo === 'Femenino';
    const esHombre = sexo === 'Masculino';
    if (!esMujer && !esHombre) continue;
    if (d.partidoAnno) {
      if (!porPartido.has(d.partidoAnno.alias)) {
        porPartido.set(d.partidoAnno.alias, { alias: d.partidoAnno.alias, nombre: d.partidoAnno.nombre, mujeres: 0, hombres: 0 });
      }
      const g = porPartido.get(d.partidoAnno.alias);
      if (esMujer) g.mujeres += 1;
      else g.hombres += 1;
    }
    if (d.distrito) {
      if (!porDistrito.has(d.distrito.numero)) {
        porDistrito.set(d.distrito.numero, { numero: d.distrito.numero, mujeres: 0, hombres: 0 });
      }
      const g = porDistrito.get(d.distrito.numero);
      if (esMujer) g.mujeres += 1;
      else g.hombres += 1;
    }
  }

  const votacionesConBrecha = [];
  const { data: votaciones } = votacionesRes;
  await mapConcurrent(votaciones, 20, async (votacion) => {
    const { data: detalle } = await fetchCachedData(
      'WSLegislativo',
      'retornarVotacionDetalle',
      { prmVotacionId: Number(votacion.id) },
      'single',
      HORA
    );
    const votos = Array.isArray(detalle.votos) ? detalle.votos : [];
    const porSexo = { Femenino: { af: 0, ec: 0 }, Masculino: { af: 0, ec: 0 } };
    for (const voto of votos) {
      const sexo = sexoPorDiputado.get(String(voto.diputado?.id));
      if (sexo !== 'Femenino' && sexo !== 'Masculino') continue;
      const g = porSexo[sexo];
      if (voto.opcionVoto?.texto === 'Afirmativo') g.af += 1;
      else if (voto.opcionVoto?.texto === 'En Contra') g.ec += 1;
    }
    const apoyo = (g) => (g.af + g.ec >= 1 ? g.af / (g.af + g.ec) : null);
    const apoyoM = apoyo(porSexo.Femenino);
    const apoyoH = apoyo(porSexo.Masculino);
    if (apoyoM === null || apoyoH === null) return;
    if (porSexo.Femenino.af + porSexo.Femenino.ec < 5 || porSexo.Masculino.af + porSexo.Masculino.ec < 5) return;
    const diferencia = Math.round(Math.abs(apoyoM - apoyoH) * 100);
    if (diferencia >= 15) {
      votacionesConBrecha.push({
        id: votacion.id,
        descripcion: votacion.descripcion,
        fecha: votacion.fecha,
        resultado: votacion.resultado?.texto || null,
        apoyoMujeres: Math.round(apoyoM * 100),
        apoyoHombres: Math.round(apoyoH * 100),
        diferencia,
      });
    }
  });
  votacionesConBrecha.sort((a, b) => b.diferencia - a.diferencia);

  const data = {
    porSexo: Object.entries(grupos).map(([sexo, g]) => ({
      sexo,
      diputados: g.n,
      asistenciaPct: g.n ? Math.round((g.asisSum / g.n) * 1000) / 10 : 0,
    })),
    porEdad: [...porEdad.entries()].map(([rango, g]) => ({
      rango,
      diputados: g.n,
      asistenciaPct: g.n ? Math.round((g.asisSum / g.n) * 1000) / 10 : 0,
    })),
    porPartido: [...porPartido.values()]
      .map((g) => ({
        ...g,
        pctMujeres: Math.round((g.mujeres / Math.max(1, g.mujeres + g.hombres)) * 100),
      }))
      .sort((a, b) => b.pctMujeres - a.pctMujeres),
    porDistrito: [...porDistrito.values()]
      .map((g) => ({
        ...g,
        pctMujeres: Math.round((g.mujeres / Math.max(1, g.mujeres + g.hombres)) * 100),
      }))
      .sort((a, b) => b.pctMujeres - a.pctMujeres),
    votacionesConBrecha,
  };
  persistir(cacheKey, data, 6 * HORA);
  return data;
}

export async function getAfinidad(anno, diputadoId = null) {
  const cacheKey = `analitica.afinidad.${anno}`;
  const enBd = await leerAnalitica(cacheKey);
  if (enBd !== undefined) {
    cache.set(cacheKey, enBd, 6 * HORA);
    return diputadoId
      ? enBd.filter(
          (p) => String(p.diputadoA.id) === String(diputadoId) || String(p.diputadoB.id) === String(diputadoId)
        )
      : enBd;
  }

  const { data: votaciones } = await fetchCachedData(
    'WSLegislativo',
    'retornarVotacionesXAnno',
    { prmAnno: Number(anno) },
    'collection',
    300
  );
  const pares = new Map();
  await mapConcurrent(votaciones, 20, async (votacion) => {
    const { data: detalle } = await fetchCachedData(
      'WSLegislativo',
      'retornarVotacionDetalle',
      { prmVotacionId: Number(votacion.id) },
      'single',
      HORA
    );
    const votos = (detalle.votos || []).filter(
      (v) =>
        v.diputado?.id &&
        (v.opcionVoto?.texto === 'Afirmativo' || v.opcionVoto?.texto === 'En Contra')
    );
    for (let i = 0; i < votos.length; i += 1) {
      for (let j = i + 1; j < votos.length; j += 1) {
        const a = votos[i];
        const b = votos[j];
        if (a.opcionVoto.texto !== b.opcionVoto.texto) continue;
        const idA = String(a.diputado.id);
        const idB = String(b.diputado.id);
        const key = idA < idB ? `${idA}|${idB}` : `${idB}|${idA}`;
        pares.set(key, (pares.get(key) || 0) + 1);
      }
    }
  });

  const roster = await getAnnoDiputados(anno);
  const nombres = new Map(roster.map((d) => [String(d.id), d]));
  const totalVotaciones = votaciones.length;
  const data = [...pares.entries()]
    .map(([key, juntas]) => {
      const [idA, idB] = key.split('|');
      const a = nombres.get(idA);
      const b = nombres.get(idB);
      if (!a || !b) return null;
      return {
        diputadoA: { id: a.id, nombre: a.nombre, apellidoPaterno: a.apellidoPaterno, partido: a.partidoAnno?.alias || null },
        diputadoB: { id: b.id, nombre: b.nombre, apellidoPaterno: b.apellidoPaterno, partido: b.partidoAnno?.alias || null },
        juntas,
        tasa: Math.round((juntas / totalVotaciones) * 1000) / 10,
      };
    })
    .filter(Boolean)
    .sort((x, y) => y.juntas - x.juntas);

  persistir(cacheKey, data, 6 * HORA);
  return diputadoId
    ? data.filter(
        (p) => String(p.diputadoA.id) === String(diputadoId) || String(p.diputadoB.id) === String(diputadoId)
      )
    : data;
}

export async function getTransfuguismo() {
  const cacheKey = 'analitica.transfuguismo';
  const enBd = await leerAnalitica(cacheKey);
  if (enBd !== undefined) {
    cache.set(cacheKey, enBd, 6 * HORA);
    return enBd;
  }

  const roster = await getRosterEnriquecido();
  const data = roster
    .map((diputado) => {
      const militancias = [...(diputado.militancias || [])].sort(
        (a, b) => new Date(a.fechaInicio || 0) - new Date(b.fechaInicio || 0)
      );
      const cambios = militancias.filter(
        (m, i) => i > 0 && m.partido?.id !== militancias[i - 1].partido?.id
      );
      return {
        id: diputado.id,
        nombre: diputado.nombre,
        apellidoPaterno: diputado.apellidoPaterno,
        distrito: diputado.distrito ? diputado.distrito.numero : null,
        partidoActual: militancias.length > 0 ? militancias[militancias.length - 1].partido?.alias : null,
        nCambios: cambios.length,
        historial: militancias.map((m) => ({
          partido: m.partido?.nombre,
          alias: m.partido?.alias,
          fechaInicio: m.fechaInicio,
          fechaTermino: m.fechaTermino,
        })),
      };
    })
    .filter((d) => d.nCambios > 0)
    .sort((a, b) => b.nCambios - a.nCambios);

  persistir(cacheKey, data, 6 * HORA);
  return data;
}

export async function getPartidos(anno) {
  const cacheKey = `analitica.partidos.${anno}`;
  const enBd = await leerAnalitica(cacheKey);
  if (enBd !== undefined) {
    cache.set(cacheKey, enBd, 6 * HORA);
    return enBd;
  }

  const [cohesion, brechas, rankings, mociones] = await Promise.all([
    getCohesion(anno),
    getBrechas(anno),
    getRankings(anno),
    getMocionesIndex(anno),
  ]);

  const partidoPorDiputado = new Map(
    rankings.map((r) => [String(r.id), r.partido ? r.partido.alias : null]).filter(([, v]) => v)
  );
  const mocionesPorPartido = new Map();
  for (const mocion of mociones) {
    for (const autor of mocion.autores) {
      const alias = partidoPorDiputado.get(String(autor.diputado?.id ?? autor.id));
      if (alias) mocionesPorPartido.set(alias, (mocionesPorPartido.get(alias) || 0) + 1);
    }
  }

  const cohesionMap = new Map(cohesion.map((p) => [p.alias, p]));
  const brechaMap = new Map(brechas.porPartido.map((p) => [p.alias, p]));

  const aliases = new Set([
    ...cohesionMap.keys(),
    ...brechaMap.keys(),
    ...partidoPorDiputado.values(),
  ]);

  const data = [...aliases]
    .map((alias) => {
      const c = cohesionMap.get(alias);
      const b = brechaMap.get(alias);
      return {
        alias,
        nombre: c?.nombre || b?.nombre || alias,
        diputados: b ? b.mujeres + b.hombres : 0,
        pctMujeres: b ? b.pctMujeres : null,
        cohesion: c ? c.cohesion : null,
        votacionesAnalizadas: c ? c.votacionesAnalizadas : 0,
        rebeldes: c ? c.rebeldes.length : 0,
        mociones: mocionesPorPartido.get(alias) || 0,
      };
    })
    .sort((a, b) => b.diputados - a.diputados || (b.cohesion ?? 0) - (a.cohesion ?? 0));

  persistir(cacheKey, data, 6 * HORA);
  return data;
}

export async function getPartidoDetalle(alias, anno) {
  const cacheKey = `analitica.partido.v2.${alias}.${anno}`;
  const enBd = await leerAnalitica(cacheKey);
  if (enBd !== undefined) {
    cache.set(cacheKey, enBd, 6 * HORA);
    return enBd;
  }

  const [partidos, rankings, comisiones, cohesion] = await Promise.all([
    getPartidos(anno),
    getRankings(anno),
    getComisionesIndex(),
    getCohesion(anno),
  ]);

  const partido = partidos.find((p) => p.alias === alias);
  if (!partido) return null;

  const cohesionPartido = cohesion.find((p) => p.alias === alias);

  const partidoPorDiputado = new Map(
    rankings.map((r) => [String(r.id), r.partido ? r.partido.alias : null]).filter(([, v]) => v)
  );
  const diputados = rankings
    .filter((r) => r.partido && r.partido.alias === alias)
    .sort((a, b) => b.score - a.score);

  const presidencias = comisiones
    .filter((c) => c.presidente && partidoPorDiputado.get(String(c.presidente.diputadoId)) === alias)
    .map((c) => ({ id: c.id, nombre: c.nombre, tipo: c.tipo, disuelta: Boolean(c.disuelta), fechaTermino: c.fechaTermino }));

  const data = {
    ...partido,
    diputados,
    presidencias,
    rebeldesDetalle: cohesionPartido ? cohesionPartido.rebeldes : [],
    scorePromedio: diputados.length
      ? Math.round((diputados.reduce((a, d) => a + d.score, 0) / diputados.length) * 10) / 10
      : 0,
    asistenciaPromedio: diputados.length
      ? Math.round(diputados.reduce((a, d) => a + d.asistencia.pct, 0) / diputados.length)
      : 0,
    participacionPromedio: diputados.length
      ? Math.round(diputados.reduce((a, d) => a + d.votos.pct, 0) / diputados.length)
      : 0,
  };
  persistir(cacheKey, data, 6 * HORA);
  return data;
}

export async function getTrayectoria(anno) {
  const cacheKey = `analitica.trayectoria.${anno}`;
  const enBd = await leerAnalitica(cacheKey);
  if (enBd !== undefined) {
    cache.set(cacheKey, enBd, 6 * HORA);
    return enBd;
  }

  const [periodosRes, rankings] = await Promise.all([
    fetchCachedData('WSLegislativo', 'retornarPeriodosLegislativos', {}, 'collection', 3600),
    getRankings(anno),
  ]);

  const membresia = new Map();
  for (const periodo of periodosRes.data) {
    try {
      const { data } = await fetchCachedData(
        'WSDiputado',
        'retornarDiputadosXPeriodo',
        { prmPeriodoID: Number(periodo.id) },
        'collection',
        600
      );
      for (const item of data) {
        const id = String(item.diputado?.id ?? item.id);
        if (!id || id === 'undefined') continue;
        if (!membresia.has(id)) membresia.set(id, []);
        membresia.get(id).push(periodo.nombre);
      }
    } catch {
      console.log(`[trayectoria] periodo ${periodo.id} (${periodo.nombre}) no disponible, se omite`);
    }
  }

  const promedio = Math.round(rankings.reduce((acc, r) => acc + r.score, 0) / Math.max(1, rankings.length));

  const data = rankings
    .map((r) => {
      const historial = membresia.get(String(r.id)) || [];
      const periodos = historial.length;
      const estado =
        r.score >= promedio ? 'justificada' : r.score >= promedio - 15 ? 'en-duda' : 'no-justificada';
      return {
        id: r.id,
        nombre: r.nombre,
        apellidoPaterno: r.apellidoPaterno,
        distrito: r.distrito,
        partido: r.partido ? r.partido.alias : null,
        score: r.score,
        periodos,
        reelecciones: Math.max(0, periodos - 1),
        primerPeriodo: historial[0] || null,
        estado,
      };
    })
    .filter((r) => r.periodos > 1)
    .sort((a, b) => b.periodos - a.periodos || b.score - a.score);

  const resultado = { data, promedio };
  persistir(cacheKey, resultado, 6 * HORA);
  return resultado;
}

export async function getAnalisisTemporal(desde, hasta) {
  const cacheKey = `analitica.temporal.${desde}.${hasta}`;
  const enBd = await leerAnalitica(cacheKey);
  if (enBd !== undefined) {
    cache.set(cacheKey, enBd, 6 * HORA);
    return enBd;
  }

  const annos = [];
  for (let a = new Date(desde).getFullYear(); a <= new Date(hasta).getFullYear(); a += 1) {
    annos.push(a);
  }

  const [listas, sesionesListas] = await Promise.all([
    Promise.all(
      annos.map((a) =>
        fetchCachedData('WSLegislativo', 'retornarVotacionesXAnno', { prmAnno: a }, 'collection', 300)
      )
    ),
    Promise.all(
      annos.map((a) => fetchCachedData('WSSala', 'retornarSesionesXAnno', { prmAnno: a }, 'collection', 300))
    ),
  ]);

  const inicio = new Date(desde).getTime();
  const fin = new Date(hasta).getTime() + 86399999;
  const enRango = (fecha) => {
    const t = new Date(fecha).getTime();
    return !Number.isNaN(t) && t >= inicio && t <= fin;
  };

  const votaciones = listas.flatMap((l) => l.data).filter((v) => enRango(v.fecha));
  const sesiones = sesionesListas.flatMap((l) => l.data).filter((s) => enRango(s.fechaInicio));

  const porHora = Array.from({ length: 24 }, () => ({ total: 0, aprobadas: 0, rechazadas: 0 }));
  const porDia = Array.from({ length: 7 }, () => ({ total: 0, aprobadas: 0, rechazadas: 0 }));
  const porMes = Array.from({ length: 12 }, () => ({ total: 0, aprobadas: 0, rechazadas: 0 }));
  const porQuorum = new Map();

  let total = 0;
  let aprobadas = 0;
  let rechazadas = 0;

  for (const v of votaciones) {
    const fecha = new Date(v.fecha);
    const esAprobada = (v.resultado?.texto || '').startsWith('Aprob');
    const esRechazada = (v.resultado?.texto || '').startsWith('Rechaz');
    total += 1;
    if (esAprobada) aprobadas += 1;
    if (esRechazada) rechazadas += 1;

    const h = fecha.getHours();
    porHora[h].total += 1;
    if (esAprobada) porHora[h].aprobadas += 1;
    if (esRechazada) porHora[h].rechazadas += 1;

    const d = (fecha.getDay() + 6) % 7;
    porDia[d].total += 1;
    if (esAprobada) porDia[d].aprobadas += 1;
    if (esRechazada) porDia[d].rechazadas += 1;

    const m = fecha.getMonth();
    porMes[m].total += 1;
    if (esAprobada) porMes[m].aprobadas += 1;
    if (esRechazada) porMes[m].rechazadas += 1;

    const q = v.quorum?.texto || 'Sin dato';
    if (!porQuorum.has(q)) porQuorum.set(q, { total: 0, aprobadas: 0, rechazadas: 0 });
    const qg = porQuorum.get(q);
    qg.total += 1;
    if (esAprobada) qg.aprobadas += 1;
    if (esRechazada) qg.rechazadas += 1;
  }

  const tasa = (g) => (g.total ? Math.round((g.aprobadas / g.total) * 100) : 0);
  const diasSesion = new Set(sesiones.map((s) => String(s.fechaInicio || '').slice(0, 10)));
  const duraciones = sesiones
    .map((s) => {
      const ini = new Date(s.fechaInicio);
      const ter = new Date(s.fechaTermino);
      if (Number.isNaN(ini.getTime()) || Number.isNaN(ter.getTime())) return null;
      return Math.round((ter.getTime() - ini.getTime()) / 60000);
    })
    .filter((d) => d !== null);

  let diasHabiles = 0;
  for (let t = inicio; t <= fin; t += 86400000) {
    const d = new Date(t).getDay();
    if (d >= 1 && d <= 5) diasHabiles += 1;
  }

  const data = {
    desde,
    hasta,
    total,
    aprobadas,
    rechazadas,
    tasaAprobacion: total ? Math.round((aprobadas / total) * 100) : 0,
    porHora: porHora.map((g, h) => ({ hora: h, ...g, tasa: tasa(g) })),
    porDia: porDia.map((g, d) => ({ dia: d, ...g, tasa: tasa(g) })),
    porMes: porMes.map((g, m) => ({ mes: m + 1, ...g, tasa: tasa(g) })),
    porQuorum: [...porQuorum.entries()]
      .map(([quorum, g]) => ({ quorum, ...g, tasa: tasa(g) }))
      .sort((a, b) => b.total - a.total),
    sesiones: {
      total: sesiones.length,
      diasSesion: diasSesion.size,
      diasHabiles,
      coberturaPct: diasHabiles ? Math.round((diasSesion.size / diasHabiles) * 100) : 0,
      duracionPromedioMin: duraciones.length
        ? Math.round(duraciones.reduce((a, b) => a + b, 0) / duraciones.length)
        : 0,
      duracionMaximaMin: duraciones.length ? Math.max(...duraciones) : 0,
      maratonicas: duraciones.filter((d) => d >= 600).length,
      votacionesPorDiaSesion: diasSesion.size ? total / diasSesion.size : 0,
    },
  };

  persistir(cacheKey, data, 6 * HORA);
  return data;
}

export async function getVotosDecisivos(desde, hasta) {
  const cacheKey = `analitica.decisivos.v3.${desde}.${hasta}`;
  const enBd = await leerAnalitica(cacheKey);
  if (enBd !== undefined) {
    cache.set(cacheKey, enBd, 6 * HORA);
    return enBd;
  }

  const annos = [];
  for (let a = new Date(desde).getFullYear(); a <= new Date(hasta).getFullYear(); a += 1) {
    annos.push(a);
  }
  const listas = await Promise.all(
    annos.map((a) =>
      fetchCachedData('WSLegislativo', 'retornarVotacionesXAnno', { prmAnno: a }, 'collection', 300)
    )
  );
  const inicio = new Date(desde).getTime();
  const fin = new Date(hasta).getTime() + 86399999;
  const votaciones = listas
    .flatMap((l) => l.data)
    .filter((v) => {
      const t = new Date(v.fecha).getTime();
      return !Number.isNaN(t) && t >= inicio && t <= fin;
    });

  const decisivos = new Map();
  const resolver = (id, nombre, apellidoPaterno, votacion) => {
    if (!id) return;
    const clave = String(id);
    if (!decisivos.has(clave)) {
      decisivos.set(clave, { id, nombre, apellidoPaterno, veces: 0, votaciones: [] });
    }
    const d = decisivos.get(clave);
    d.veces += 1;
    if (d.votaciones.length < 5) {
      d.votaciones.push({
        id: votacion.id,
        descripcion: votacion.descripcion,
        fecha: votacion.fecha,
        resultado: votacion.resultado ? votacion.resultado.texto : null,
      });
    }
  };

  let parcial = false;
  await mapConcurrent(votaciones, 20, async (votacion) => {
    try {
    const { data: detalle } = await fetchCachedData(
      'WSLegislativo',
      'retornarVotacionDetalle',
      { prmVotacionId: Number(votacion.id) },
      'single',
      HORA
    );
    const votos = Array.isArray(detalle.votos) ? detalle.votos : [];
    const si = Number(votacion.totalSi || 0);
    const no = Number(votacion.totalNo || 0);
    const esAprobada = (votacion.resultado?.texto || '').startsWith('Aprob');
    const requerido = requeridoPara(votacion.quorum?.texto || '', votacion.fecha);

    let decisive = [];
    if (requerido !== null) {
      if (esAprobada && si === requerido) decisive = votos.filter((v) => v.opcionVoto?.texto === 'Afirmativo');
      else if (!esAprobada && si === requerido - 1) decisive = votos.filter((v) => v.opcionVoto?.texto === 'En Contra');
    } else if (si - no === 1 && esAprobada) {
      decisive = votos.filter((v) => v.opcionVoto?.texto === 'Afirmativo');
    } else if (no - si === 1 && !esAprobada) {
      decisive = votos.filter((v) => v.opcionVoto?.texto === 'En Contra');
    }

    for (const voto of decisive) {
      resolver(
        voto.diputado?.id,
        voto.diputado?.nombre,
        voto.diputado?.apellidoPaterno,
        votacion
      );
    }
    } catch {
      parcial = true;
    }
  });

  const data = {
    parcial,
    items: [...decisivos.values()]
      .map((d) => ({ id: d.id, nombre: d.nombre, apellidoPaterno: d.apellidoPaterno, veces: d.veces, votaciones: d.votaciones }))
      .sort((a, b) => b.veces - a.veces),
  };

  const { enriquecerVotaciones } = await import('./legible.js');
  const unicas = [];
  const vistas = new Set();
  for (const d of data.items) {
    for (const v of d.votaciones) {
      if (!vistas.has(v.id)) {
        vistas.add(v.id);
        unicas.push(v);
      }
    }
  }
  if (unicas.length > 0) {
    const enriquecidas = await enriquecerVotaciones(unicas);
    const porId = new Map(enriquecidas.map((v) => [String(v.id), v]));
    for (const d of data.items) {
      d.votaciones = d.votaciones.map((v) => ({
        ...v,
        proyecto: porId.get(String(v.id))?.proyecto || null,
      }));
    }
  }

  const perfiles = new Map(
    (await getAnnoDiputados(String(new Date(hasta).getFullYear()))).map((d) => [
      String(d.id),
      {
        distrito: d.distrito ? d.distrito.numero : null,
        partido: d.partidoAnno ? { alias: d.partidoAnno.alias, nombre: d.partidoAnno.nombre } : null,
      },
    ])
  );
  const dataEnriquecida = {
    parcial: data.parcial,
    items: data.items.map((d) => ({ ...d, ...(perfiles.get(String(d.id)) || {}) })),
  };
  persistir(cacheKey, dataEnriquecida, 6 * HORA);
  return dataEnriquecida;
}

export async function getVelocidadLey(desde, hasta) {
  const cacheKey = `analitica.velocidad.${desde}.${hasta}`;
  const enBd = await leerAnalitica(cacheKey);
  if (enBd !== undefined) {
    cache.set(cacheKey, enBd, 6 * HORA);
    return enBd;
  }

  const annos = [];
  for (let a = new Date(desde).getFullYear(); a <= new Date(hasta).getFullYear(); a += 1) {
    annos.push(a);
  }

  const proyectos = [];
  for (const anno of annos) {
    const [mociones, mensajes] = await Promise.all([
      getMocionesIndex(String(anno)),
      fetchCachedData('WSLegislativo', 'retornarMensajesXAnno', { prmAnno: anno }, 'collection', 300),
    ]);
    for (const m of mociones) proyectos.push({ boletin: m.boletin, fechaIngreso: m.fechaIngreso });
    for (const m of mensajes.data) proyectos.push({ boletin: m.numeroBoletin, fechaIngreso: m.fechaIngreso });
  }

  const items = [];
  let conVotaciones = 0;
  let sinVotaciones = 0;
  await mapConcurrent(proyectos, 20, async (p) => {
    try {
      const { data: detalle } = await fetchCachedData(
        'WSLegislativo',
        'retornarProyectoLey',
        { prmNumeroBoletin: p.boletin },
        'single',
        HORA
      );
      if (!detalle || Object.keys(detalle).length === 0) return;
      const votaciones = Array.isArray(detalle.votaciones) ? detalle.votaciones : [];
      if (votaciones.length === 0) {
        sinVotaciones += 1;
        return;
      }
      const primera = Math.min(...votaciones.map((v) => new Date(v.fecha).getTime()));
      const inicio = new Date(detalle.fechaIngreso || p.fechaIngreso).getTime();
      if (Number.isNaN(primera) || Number.isNaN(inicio)) return;
      const dias = Math.round((primera - inicio) / 86400000);
      if (dias < 0) return;
      conVotaciones += 1;
      items.push({
        boletin: p.boletin,
        nombre: detalle.nombre,
        fechaIngreso: detalle.fechaIngreso,
        primeraVotacion: new Date(primera).toISOString(),
        dias,
      });
    } catch {
      // proyectos no disponibles
    }
  });

  const buckets = [
    { desde: 0, hasta: 30, etiqueta: '0-30 días' },
    { desde: 31, hasta: 90, etiqueta: '31-90 días' },
    { desde: 91, hasta: 180, etiqueta: '91-180 días' },
    { desde: 181, hasta: 365, etiqueta: '6 meses - 1 año' },
    { desde: 366, hasta: 730, etiqueta: '1-2 años' },
    { desde: 731, hasta: Infinity, etiqueta: 'Más de 2 años' },
  ];
  const distribucion = buckets.map((b) => ({
    etiqueta: b.etiqueta,
    total: items.filter((i) => i.dias >= b.desde && i.dias <= b.hasta).length,
  }));

  const data = {
    promedioDias: items.length
      ? Math.round(items.reduce((a, b) => a + b.dias, 0) / items.length)
      : 0,
    medianaDias: items.length
      ? items.map((i) => i.dias).sort((a, b) => a - b)[Math.floor(items.length / 2)]
      : 0,
    conVotaciones,
    sinVotaciones,
    masLento: items.length ? items.sort((a, b) => b.dias - a.dias)[0] : null,
    masRapido: items.length ? [...items].sort((a, b) => a.dias - b.dias)[0] : null,
    distribucion,
  };
  persistir(cacheKey, data, 6 * HORA);
  return data;
}

export async function getMateriasCementerio(anno) {
  const cacheKey = `analitica.materiasCemento.${anno}`;
  const enBd = await leerAnalitica(cacheKey);
  if (enBd !== undefined) {
    cache.set(cacheKey, enBd, 6 * HORA);
    return enBd;
  }

  const cementerio = await getCementerio(anno);
  const porMateria = new Map();
  for (const p of cementerio) {
    for (const materia of p.materias) {
      if (!porMateria.has(materia)) {
        porMateria.set(materia, { materia, proyectos: 0, sinVotaciones: 0, conVotaciones: 0, edadSum: 0 });
      }
      const g = porMateria.get(materia);
      g.proyectos += 1;
      if (p.votaciones === 0) g.sinVotaciones += 1;
      else g.conVotaciones += 1;
      if (p.edadAnios !== null) g.edadSum += p.edadAnios;
    }
  }

  const data = [...porMateria.values()]
    .map((g) => ({
      ...g,
      edadPromedio: g.proyectos ? Math.round((g.edadSum / g.proyectos) * 10) / 10 : 0,
    }))
    .sort((a, b) => b.sinVotaciones - a.sinVotaciones || b.proyectos - a.proyectos)
    .slice(0, 25);
  persistir(cacheKey, data, 6 * HORA);
  return data;
}

export async function getAfinidadPartidos(anno) {
  const cacheKey = `analitica.afinidadPartidos.${anno}`;
  const enBd = await leerAnalitica(cacheKey);
  if (enBd !== undefined) {
    cache.set(cacheKey, enBd, 6 * HORA);
    return enBd;
  }

  const [pares, rankings] = await Promise.all([getAfinidad(anno), getRankings(anno)]);
  const partidoPorId = new Map(
    rankings.map((r) => [String(r.id), r.partido ? r.partido.alias : null]).filter(([, v]) => v)
  );

  const grupos = new Map();
  for (const par of pares) {
    const a = partidoPorId.get(String(par.diputadoA.id));
    const b = partidoPorId.get(String(par.diputadoB.id));
    if (!a || !b || a === b) continue;
    const clave = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (!grupos.has(clave)) grupos.set(clave, { a: a < b ? a : b, b: a < b ? b : a, suma: 0, n: 0, juntas: 0 });
    const g = grupos.get(clave);
    g.suma += par.tasa;
    g.n += 1;
    g.juntas += par.juntas;
  }

  const data = [...grupos.values()]
    .filter((g) => g.n >= 8)
    .map((g) => ({
      partidoA: g.a,
      partidoB: g.b,
      tasa: Math.round((g.suma / g.n) * 10) / 10,
      pares: g.n,
    }))
    .sort((a, b) => b.tasa - a.tasa);
  persistir(cacheKey, data, 6 * HORA);
  return data;
}

export async function getFiscalizacion() {
  const cacheKey = 'analitica.fiscalizacion';
  const enBd = await leerAnalitica(cacheKey);
  if (enBd !== undefined) {
    cache.set(cacheKey, enBd, 6 * HORA);
    return enBd;
  }

  const comisiones = await getComisionesIndex();
  const ceiPorPeriodo = new Map();
  for (const c of comisiones) {
    if (!c.tipo || !c.tipo.includes('Investigadora')) continue;
    const anno = c.fechaInicio ? Number(String(c.fechaInicio).slice(0, 4)) : 0;
    const periodo = anno >= 2026 ? '2026-2030' : anno >= 2022 ? '2022-2026' : anno >= 2018 ? '2018-2022' : 'anterior';
    ceiPorPeriodo.set(periodo, (ceiPorPeriodo.get(periodo) || 0) + 1);
  }

  const annos = [2026, 2025, 2024, 2023, 2022, 2021, 2020];
  const acuerdos = [];
  const resoluciones = [];
  let parcial = false;
  await Promise.all(
    annos.map(async (anno) => {
      let a = null;
      let r = null;
      try {
        ({ data: a } = await fetchCachedData(
          'WSProyectosAcuerdo',
          'retornarProyectosAcuerdoXAnno',
          { prmAnno: anno },
          'collection',
          300
        ));
      } catch {
        parcial = true;
      }
      try {
        ({ data: r } = await fetchCachedData(
          'WSProyectosResolucion',
          'retornarProyectosResolucionXAnno',
          { prmAnno: anno },
          'collection',
          300
        ));
      } catch {
        parcial = true;
      }
      acuerdos.push({ anno, total: a ? a.length : 0, ok: !!a });
      resoluciones.push({ anno, total: r ? r.length : 0, ok: !!r });
    })
  );
  acuerdos.sort((x, y) => y.anno - x.anno);
  resoluciones.sort((x, y) => y.anno - x.anno);

  const data = {
    parcial,
    ceiPorPeriodo: [...ceiPorPeriodo.entries()].map(([periodo, total]) => ({ periodo, total })),
    acuerdos,
    resoluciones,
  };
  persistir(cacheKey, data, 6 * HORA);
  return data;
}

export async function getAgendaEjecutivo(anno) {
  const cacheKey = `analitica.agenda.${anno}`;
  const enBd = await leerAnalitica(cacheKey);
  if (enBd !== undefined) {
    cache.set(cacheKey, enBd, 6 * HORA);
    return enBd;
  }

  const { data: mensajes } = await fetchCachedData(
    'WSLegislativo',
    'retornarMensajesXAnno',
    { prmAnno: Number(anno) },
    'collection',
    300
  );

  const porMinisterio = new Map();
  await mapConcurrent(mensajes, 20, async (m) => {
    try {
      const { data: detalle } = await fetchCachedData(
        'WSLegislativo',
        'retornarProyectoLey',
        { prmNumeroBoletin: m.numeroBoletin },
        'single',
        HORA
      );
      if (!detalle || Object.keys(detalle).length === 0) return;
      const ministerios = Array.isArray(detalle.ministeriosPatrocinantes)
        ? detalle.ministeriosPatrocinantes.map((x) => x.nombre)
        : [];
      const conVotaciones = Array.isArray(detalle.votaciones) && detalle.votaciones.length > 0;
      if (ministerios.length === 0) {
        if (!porMinisterio.has('Sin ministerio asignado')) {
          porMinisterio.set('Sin ministerio asignado', { ministerio: 'Sin ministerio asignado', mensajes: 0, conVotaciones: 0 });
        }
        const g = porMinisterio.get('Sin ministerio asignado');
        g.mensajes += 1;
        if (conVotaciones) g.conVotaciones += 1;
        return;
      }
      for (const nombre of ministerios) {
        if (!porMinisterio.has(nombre)) {
          porMinisterio.set(nombre, { ministerio: nombre, mensajes: 0, conVotaciones: 0 });
        }
        const g = porMinisterio.get(nombre);
        g.mensajes += 1;
        if (conVotaciones) g.conVotaciones += 1;
      }
    } catch {
      // mensaje no disponible
    }
  });

  const data = [...porMinisterio.values()].sort((a, b) => b.mensajes - a.mensajes);
  persistir(cacheKey, data, 6 * HORA);
  return data;
}

export async function getFaltasPorPartido(anno) {
  const cacheKey = `analitica.faltasPartido.${anno}`;
  const enBd = await leerAnalitica(cacheKey);
  if (enBd !== undefined) {
    cache.set(cacheKey, enBd, 6 * HORA);
    return enBd;
  }

  const dieta = await getDieta(anno);
  const porPartido = new Map();
  for (const d of dieta.data) {
    const clave = d.partido || 'Sin partido';
    if (!porPartido.has(clave)) {
      porPartido.set(clave, { partido: clave, diputados: 0, sinJustificar: 0, sinRebaja: 0, conRebaja: 0 });
    }
    const g = porPartido.get(clave);
    g.diputados += 1;
    g.sinJustificar += d.sinJustificar;
    g.sinRebaja += d.justificadoSinRebaja;
    g.conRebaja += d.justificadoConRebaja;
  }

  const data = [...porPartido.values()]
    .map((g) => ({
      ...g,
      promedioSinJustificar: g.diputados ? Math.round((g.sinJustificar / g.diputados) * 10) / 10 : 0,
      promedioSinRebaja: g.diputados ? Math.round((g.sinRebaja / g.diputados) * 10) / 10 : 0,
    }))
    .filter((g) => g.diputados >= 2)
    .sort((a, b) => b.promedioSinJustificar - a.promedioSinJustificar);
  persistir(cacheKey, data, 6 * HORA);
  return data;
}

const RE_BOLETIN_LOCAL = /^Bolet\u00edn\s*N[\u00b0\u00ba]\s*(\S+)/i;
const VOTOS_REALES = new Set(['Afirmativo', 'En Contra', 'Abstención']);

export async function getCambiosDeVoto(anno) {
  const cacheKey = `analitica.cambios.${anno}`;
  const enBd = await leerAnalitica(cacheKey);
  if (enBd !== undefined) {
    cache.set(cacheKey, enBd, 6 * HORA);
    return enBd;
  }

  const { data: votaciones } = await fetchCachedData(
    'WSLegislativo',
    'retornarVotacionesXAnno',
    { prmAnno: Number(anno) },
    'collection',
    300
  );

  const porBoletin = new Map();
  for (const v of votaciones) {
    const m = RE_BOLETIN_LOCAL.exec(String(v.descripcion || ''));
    if (!m) continue;
    if (!porBoletin.has(m[1])) porBoletin.set(m[1], []);
    porBoletin.get(m[1]).push(v);
  }

  const diputados = new Map();
  let proyectosAnalizados = 0;
  const proyectos = [];

  await mapConcurrent([...porBoletin.entries()].filter(([, lista]) => lista.length >= 2), 10, async ([boletin, lista]) => {
    const detalles = await Promise.all(
      lista.map((v) =>
        fetchCachedData('WSLegislativo', 'retornarVotacionDetalle', { prmVotacionId: Number(v.id) }, 'single', HORA)
      )
    );
    let nombre = boletin;
    try {
      const { data: proyecto } = await fetchCachedData(
        'WSLegislativo',
        'retornarProyectoLey',
        { prmNumeroBoletin: boletin },
        'single',
        HORA
      );
      if (proyecto && proyecto.nombre) nombre = proyecto.nombre;
    } catch {
      // nombre queda como boletin
    }

    const historial = new Map();
    detalles.forEach((detalle, i) => {
      const votos = Array.isArray(detalle.data.votos) ? detalle.data.votos : [];
      for (const voto of votos) {
        const id = voto.diputado?.id;
        if (!id) continue;
        if (!historial.has(String(id))) historial.set(String(id), []);
        historial.get(String(id)).push({
          fecha: lista[i].fecha,
          voto: voto.opcionVoto?.texto || null,
          votacionId: lista[i].id,
        });
      }
    });

    for (const [id, fila] of historial) {
      fila.sort((a, b) => new Date(a.fecha) - new Date(b.fecha));
      const relevantes = fila.filter((f) => VOTOS_REALES.has(f.voto));
      for (let i = 1; i < relevantes.length; i += 1) {
        if (relevantes[i].voto !== relevantes[i - 1].voto) {
          if (!diputados.has(id)) {
            diputados.set(id, {
              id,
              nombre: null,
              apellidoPaterno: null,
              cambios: 0,
              casos: [],
            });
          }
          const d = diputados.get(id);
          d.cambios += 1;
          if (d.casos.length < 3) {
            d.casos.push({
              boletin,
              proyecto: nombre,
              votoAnterior: relevantes[i - 1].voto,
              votoPosterior: relevantes[i].voto,
              fechaAnterior: relevantes[i - 1].fecha,
              fechaPosterior: relevantes[i].fecha,
            });
          }
        }
      }
    }
    proyectosAnalizados += 1;
    proyectos.push(boletin);
  });

  // nombres de los diputados
  await mapConcurrent([...diputados.values()], 10, async (d) => {
    const { data: detalle } = await fetchCachedData(
      'WSDiputado',
      'retornarDiputado',
      { prmDiputadoId: Number(d.id) },
      'single',
      HORA
    );
    if (detalle && detalle.nombre) {
      d.nombre = detalle.nombre;
      d.apellidoPaterno = detalle.apellidoPaterno;
    }
  });

  const data = [...diputados.values()]
    .filter((d) => d.nombre)
    .sort((a, b) => b.cambios - a.cambios);

  const perfiles = new Map(
    (await getAnnoDiputados(String(anno))).map((d) => [
      String(d.id),
      {
        distrito: d.distrito ? d.distrito.numero : null,
        partido: d.partidoAnno ? { alias: d.partidoAnno.alias, nombre: d.partidoAnno.nombre } : null,
      },
    ])
  );
  const dataEnriquecida = data.map((d) => ({ ...d, ...(perfiles.get(String(d.id)) || {}) }));

  const resultado = {
    data: dataEnriquecida,
    meta: { proyectosAnalizados, totalCambios: data.reduce((a, b) => a + b.cambios, 0) },
  };
  persistir(cacheKey, resultado, 6 * HORA);
  return resultado;
}

export async function getEdadCongreso(anno) {
  const cacheKey = `analitica.edad.${anno}`;
  const enBd = await leerAnalitica(cacheKey);
  if (enBd !== undefined) {
    cache.set(cacheKey, enBd, 6 * HORA);
    return enBd;
  }

  const [roster, periodosRes] = await Promise.all([
    getAnnoDiputados(anno),
    fetchCachedData('WSLegislativo', 'retornarPeriodosLegislativos', {}, 'collection', 3600),
  ]);

  const nacimientoPorId = new Map();
  for (const d of roster) {
    if (d.fechaNacimiento) nacimientoPorId.set(String(d.id), new Date(d.fechaNacimiento).getFullYear());
  }

  const porPartido = new Map();
  const ahora = new Date().getFullYear();
  for (const d of roster) {
    const nac = nacimientoPorId.get(String(d.id));
    if (!nac || !d.partidoAnno) continue;
    const edad = ahora - nac;
    if (!porPartido.has(d.partidoAnno.alias)) {
      porPartido.set(d.partidoAnno.alias, { alias: d.partidoAnno.alias, suma: 0, n: 0, menores40: 0, mayores70: 0 });
    }
    const g = porPartido.get(d.partidoAnno.alias);
    g.suma += edad;
    g.n += 1;
    if (edad < 40) g.menores40 += 1;
    if (edad >= 70) g.mayores70 += 1;
  }

  const porPeriodo = [];
  for (const periodo of periodosRes.data) {
    try {
      const { data } = await fetchCachedData(
        'WSDiputado',
        'retornarDiputadosXPeriodo',
        { prmPeriodoID: Number(periodo.id) },
        'collection',
        600
      );
      const inicioPeriodo = Number(String(periodo.nombre).slice(0, 4));
      if (Number.isNaN(inicioPeriodo)) continue;
      let suma = 0;
      let n = 0;
      for (const item of data) {
        const id = String(item.diputado?.id ?? item.id);
        if (id === 'undefined') continue;
        let nac = nacimientoPorId.get(id);
        if (!nac) {
          try {
            const { data: detalle } = await fetchCachedData(
              'WSDiputado',
              'retornarDiputado',
              { prmDiputadoId: Number(id) },
              'single',
              HORA
            );
            if (detalle && detalle.fechaNacimiento) {
              nac = new Date(detalle.fechaNacimiento).getFullYear();
              nacimientoPorId.set(id, nac);
            }
          } catch {
            // sin datos
          }
        }
        if (!nac) continue;
        suma += inicioPeriodo - nac;
        n += 1;
      }
      if (n > 0) {
        porPeriodo.push({ periodo: periodo.nombre, edadPromedio: Math.round(suma / n), diputados: n });
      }
    } catch {
      // periodo no disponible
    }
  }

  const data = {
    porPartido: [...porPartido.values()]
      .map((g) => ({ ...g, edadPromedio: Math.round(g.suma / g.n) }))
      .sort((a, b) => b.edadPromedio - a.edadPromedio),
    porPeriodo,
    edadPromedioCongreso: roster.length
      ? Math.round(
          roster.reduce((acc, d) => {
            const nac = nacimientoPorId.get(String(d.id));
            return acc + (nac ? ahora - nac : 0);
          }, 0) / roster.length
        )
      : 0,
  };
  persistir(cacheKey, data, 6 * HORA);
  return data;
}

export async function getDistritosRepresentacion(anno) {
  const cacheKey = `analitica.distritos.${anno}`;
  const enBd = await leerAnalitica(cacheKey);
  if (enBd !== undefined) {
    cache.set(cacheKey, enBd, 6 * HORA);
    return enBd;
  }

  const [rankings, contrafactualesRes] = await Promise.all([
    getRankings(anno),
    getContrafactuales(anno),
  ]);
  const contrafactuales = Array.isArray(contrafactualesRes)
    ? contrafactualesRes
    : contrafactualesRes.items;

  const distritoPorId = new Map(rankings.map((r) => [String(r.id), r.distrito]));
  const perdidasClave = contrafactuales.filter((c) => c.habrianAlcanzado && c.faltaron <= 3);

  const porDistrito = new Map();
  for (const r of rankings) {
    if (!r.distrito) continue;
    if (!porDistrito.has(r.distrito)) {
      porDistrito.set(r.distrito, {
        distrito: r.distrito,
        diputados: 0,
        scoreSum: 0,
        ausenciasSum: 0,
        perdidasClaveConAusencia: 0,
      });
    }
    const g = porDistrito.get(r.distrito);
    g.diputados += 1;
    g.scoreSum += r.score;
    g.ausenciasSum += r.votos.ausente;
  }

  const ausentesPorVotacion = perdidasClave.map((c) => ({
    ausentes: c.ausentesDetalle.map((d) => String(d.id)),
  }));
  for (const g of porDistrito.values()) {
    for (const v of ausentesPorVotacion) {
      if (v.ausentes.some((id) => distritoPorId.get(id) === g.distrito)) {
        g.perdidasClaveConAusencia += 1;
      }
    }
  }

  const data = [...porDistrito.values()]
    .map((g) => ({
      ...g,
      scorePromedio: Math.round((g.scoreSum / g.diputados) * 10) / 10,
      ausenciasPromedio: Math.round((g.ausenciasSum / g.diputados) * 10) / 10,
    }))
    .sort((a, b) => b.scorePromedio - a.scorePromedio);
  persistir(cacheKey, data, 6 * HORA);
  return data;
}

export async function getCurvaFatiga(anno) {
  const cacheKey = `analitica.fatiga.${anno}`;
  const enBd = await leerAnalitica(cacheKey);
  if (enBd !== undefined) {
    cache.set(cacheKey, enBd, 6 * HORA);
    return enBd;
  }

  const [sesiones, votaciones] = await Promise.all([
    fetchCachedData('WSSala', 'retornarSesionesXAnno', { prmAnno: Number(anno) }, 'collection', 300),
    fetchCachedData('WSLegislativo', 'retornarVotacionesXAnno', { prmAnno: Number(anno) }, 'collection', 300),
  ]);

  let primerasAprobadas = 0;
  let ultimasAprobadas = 0;
  let sesionesAnalizadas = 0;
  const porSesion = [];

  for (const sesion of sesiones.data) {
    const inicio = new Date(sesion.fechaInicio).getTime();
    const fin = new Date(sesion.fechaTermino).getTime();
    if (Number.isNaN(inicio) || Number.isNaN(fin)) continue;
    const deSesion = votaciones.data
      .filter((v) => {
        const t = new Date(v.fecha).getTime();
        return !Number.isNaN(t) && t >= inicio && t <= fin;
      })
      .sort((a, b) => new Date(a.fecha) - new Date(b.fecha));
    if (deSesion.length < 2) continue;
    const aprobada = (v) => (v.resultado?.texto || '').startsWith('Aprob');
    const primera = deSesion[0];
    const ultima = deSesion[deSesion.length - 1];
    if (aprobada(primera)) primerasAprobadas += 1;
    if (aprobada(ultima)) ultimasAprobadas += 1;
    sesionesAnalizadas += 1;
    if (porSesion.length < 12) {
      porSesion.push({
        numero: sesion.numero,
        fecha: sesion.fechaInicio,
        totalVotaciones: deSesion.length,
        primeraAprobada: aprobada(primera),
        ultimaAprobada: aprobada(ultima),
      });
    }
  }

  const data = {
    sesionesAnalizadas,
    primerasAprobadas,
    ultimasAprobadas,
    primerasPct: sesionesAnalizadas ? Math.round((primerasAprobadas / sesionesAnalizadas) * 100) : 0,
    ultimasPct: sesionesAnalizadas ? Math.round((ultimasAprobadas / sesionesAnalizadas) * 100) : 0,
    porSesion,
  };
  persistir(cacheKey, data, 6 * HORA);
  return data;
}

export async function getBloques(anno) {
  const cacheKey = `analitica.bloques.${anno}`;
  const enBd = await leerAnalitica(cacheKey);
  if (enBd !== undefined) {
    cache.set(cacheKey, enBd, 6 * HORA);
    return enBd;
  }

  const [rankings, cohesion] = await Promise.all([getRankings(anno), getCohesion(anno)]);
  const cohesionPorPartido = new Map(cohesion.map((c) => [c.alias, c.cohesion]));
  const { AGRUPACIONES } = await import('../data/bloques.js');

  const partidoPorDiputado = new Map(
    rankings.map((r) => [String(r.id), r.partido ? r.partido.alias : null]).filter(([, v]) => v)
  );

  const data = AGRUPACIONES.map((agrupacion) => {
    const partidosSet = new Set(agrupacion.partidos);
    const diputados = rankings.filter((r) => r.partido && partidosSet.has(r.partido.alias));
    const cohesionBloque = diputados.length
      ? Math.round(
          (diputados.reduce((acc, d) => acc + (cohesionPorPartido.get(d.partido.alias) || 0), 0) /
            diputados.length) *
            10
        ) / 10
      : 0;
    const porPartido = new Map();
    for (const d of diputados) {
      if (!porPartido.has(d.partido.alias)) {
        porPartido.set(d.partido.alias, { alias: d.partido.alias, n: 0, scoreSum: 0 });
      }
      const g = porPartido.get(d.partido.alias);
      g.n += 1;
      g.scoreSum += d.score;
    }
    return {
      clave: agrupacion.clave,
      nombre: agrupacion.nombre,
      partidos: agrupacion.partidos,
      diputados: diputados.length,
      cohesion: cohesionBloque,
      scorePromedio: diputados.length
        ? Math.round((diputados.reduce((a, b) => a + b.score, 0) / diputados.length) * 10) / 10
        : 0,
      composicion: [...porPartido.values()]
        .map((g) => ({ ...g, scorePromedio: Math.round(g.scoreSum / g.n) }))
        .sort((a, b) => b.n - a.n),
    };
  });

  persistir(cacheKey, data, 6 * HORA);
  return data;
}

function cacheGet(key) {
  return cache.get(key);
}

function cacheSet(key, value, ttl) {
  cache.set(key, value, ttl);
}

function persistir(cacheKey, data) {
  cache.set(cacheKey, data, 6 * HORA);
  guardarAnalitica(cacheKey, data);
}
