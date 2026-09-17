import { cache, fetchCachedData, mapConcurrent } from './fetchCached.js';
import { guardarAnalitica, leerAnalitica } from '../modules/analiticasDb.js';
import { pg, pgDisponible } from './pgDirecto.js';
import {
  getAnnoDiputados,
  getVotacionMatriz,
  getMocionesIndex,
  getRankings,
} from './analitica.js';
import { requeridoPara } from './quorum.js';
import { divisionElectoral } from '../data/distritos.js';
import { enriquecerVotaciones } from './legible.js';

const HORA = 3600;
const RE_BOLETIN = /^Boletín\s*N°\s*(\S+)/i;

function persistirLocal(cacheKey, data) {
  cache.set(cacheKey, data, 6 * HORA);
  guardarAnalitica(cacheKey, data);
}

async function leerCache(cacheKey) {
  const enBd = await leerAnalitica(cacheKey);
  if (enBd !== undefined) {
    cache.set(cacheKey, enBd, 6 * HORA);
    return enBd;
  }
  return undefined;
}

const regionPorDistrito = new Map(divisionElectoral.map((d) => [d.numero, d.region]));

async function rosterMap(anno) {
  const roster = await getAnnoDiputados(anno);
  const mapa = new Map();
  for (const d of roster) {
    mapa.set(String(d.id), {
      id: d.id,
      nombre: d.nombre,
      apellidoPaterno: d.apellidoPaterno,
      distrito: d.distrito ? d.distrito.numero : null,
      region: d.distrito ? regionPorDistrito.get(d.distrito.numero) || null : null,
      partido: d.partidoAnno ? { alias: d.partidoAnno.alias, nombre: d.partidoAnno.nombre } : null,
    });
  }
  return mapa;
}

async function detallesAnno(anno, onFallo) {
  const { data: votaciones } = await fetchCachedData(
    'WSLegislativo',
    'retornarVotacionesXAnno',
    { prmAnno: Number(anno) },
    'collection',
    300
  );
  const detalles = await mapConcurrent(votaciones, 20, async (votacion) => {
    try {
      const { data: detalle } = await fetchCachedData(
        'WSLegislativo',
        'retornarVotacionDetalle',
        { prmVotacionId: Number(votacion.id) },
        'single',
        HORA
      );
      return { votacion, votos: Array.isArray(detalle.votos) ? detalle.votos : [] };
    } catch {
      if (onFallo) onFallo();
      return null;
    }
  });
  return detalles.filter(Boolean);
}

function mayoriaPartido(votos, partidoPorId) {
  const conteo = new Map();
  for (const voto of votos) {
    const p = partidoPorId.get(String(voto.diputado?.id));
    const op = voto.opcionVoto?.texto;
    if (!p || (op !== 'Afirmativo' && op !== 'En Contra')) continue;
    if (!conteo.has(p)) conteo.set(p, { Afirmativo: 0, 'En Contra': 0 });
    conteo.get(p)[op] += 1;
  }
  const mayoria = new Map();
  for (const [p, c] of conteo) {
    if (c.Afirmativo === c['En Contra']) continue;
    mayoria.set(p, c.Afirmativo > c['En Contra'] ? 'Afirmativo' : 'En Contra');
  }
  return mayoria;
}

async function adjuntarProyectos(items) {
  const lista = items.flatMap((i) => i.ejemplos || []);
  if (lista.length === 0) return items;
  const unicas = [];
  const vistas = new Set();
  for (const v of lista) {
    if (!vistas.has(String(v.id))) {
      vistas.add(String(v.id));
      unicas.push(v);
    }
  }
  const enriquecidas = await enriquecerVotaciones(unicas);
  const porId = new Map(enriquecidas.map((v) => [String(v.id), v]));
  for (const i of items) {
    i.ejemplos = (i.ejemplos || []).map((v) => {
      const e = porId.get(String(v.id));
      return { ...v, proyecto: e?.proyecto || null };
    });
  }
  return items;
}

// Quién se rebela cuando no cuesta y obedece cuando decide.
export async function getPerformativos(anno) {
  const cacheKey = `analitica.performativos.v2.${anno}`;
  const enCache = await leerCache(cacheKey);
  if (enCache !== undefined) return enCache;

  const perfiles = await rosterMap(anno);
  const partidoPorId = new Map(
    [...perfiles.values()].map((d) => [String(d.id), d.partido ? d.partido.alias : null]).filter(([, p]) => p)
  );
  let parcial = false;
  const detalles = await detallesAnno(anno, () => {
    parcial = true;
  });

  const stats = new Map();
  for (const { votacion, votos } of detalles) {
    const si = Number(votacion.totalSi || 0);
    const no = Number(votacion.totalNo || 0);
    const aprobada = (votacion.resultado?.texto || '').startsWith('Aprob');
    const estrecha = aprobada ? si - no <= 3 : no - si <= 3;
    const mayoria = mayoriaPartido(votos, partidoPorId);
    for (const voto of votos) {
      const id = String(voto.diputado?.id);
      const op = voto.opcionVoto?.texto;
      if (!id || (op !== 'Afirmativo' && op !== 'En Contra')) continue;
      const lado = mayoria.get(partidoPorId.get(id));
      if (!lado) continue;
      if (!stats.has(id)) {
        stats.set(id, { holgada: 0, rebelHolgada: 0, estrecha: 0, rebelEstrecha: 0, ejemplos: [] });
      }
      const s = stats.get(id);
      const rebelde = op !== lado;
      if (estrecha) {
        s.estrecha += 1;
        if (rebelde) s.rebelEstrecha += 1;
      } else {
        s.holgada += 1;
        if (rebelde) {
          s.rebelHolgada += 1;
          if (s.ejemplos.length < 3) {
            s.ejemplos.push({ id: votacion.id, descripcion: votacion.descripcion, fecha: votacion.fecha });
          }
        }
      }
    }
  }

  let items = [...stats.entries()]
    .filter(([, s]) => s.holgada >= 15 && s.estrecha >= 5 && s.rebelHolgada > 0)
    .map(([id, s]) => {
      const p = perfiles.get(id) || {};
      if (!p.partido || p.partido.alias === 'IND') return null;
      const tHolgada = s.rebelHolgada / s.holgada;
      const tEstrecha = s.rebelEstrecha / s.estrecha;
      return {
        id: p.id,
        nombre: p.nombre,
        apellidoPaterno: p.apellidoPaterno,
        partido: p.partido,
        distrito: p.distrito,
        holgada: s.holgada,
        rebelHolgada: s.rebelHolgada,
        estrecha: s.estrecha,
        rebelEstrecha: s.rebelEstrecha,
        tasaHolgada: Math.round(tHolgada * 100),
        tasaEstrecha: Math.round(tEstrecha * 100),
        indice: Math.round((tHolgada - tEstrecha) * 100),
        ejemplos: s.ejemplos,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.indice - a.indice);
  items = await adjuntarProyectos(items);

  const data = { parcial, items };
  persistirLocal(cacheKey, data);
  return data;
}

// Poder de bloque: veces que dar vuelta todos sus votos cambiaría el resultado.
export async function getBanzhaf(anno) {
  const cacheKey = `analitica.banzhaf.${anno}`;
  const enCache = await leerCache(cacheKey);
  if (enCache !== undefined) return enCache;

  const perfiles = await rosterMap(anno);
  const partidoPorId = new Map(
    [...perfiles.values()].map((d) => [String(d.id), d.partido ? d.partido.alias : null]).filter(([, p]) => p)
  );
  const nombrePartido = new Map(
    [...perfiles.values()].filter((d) => d.partido).map((d) => [d.partido.alias, d.partido.nombre])
  );
  let parcial = false;
  const detalles = await detallesAnno(anno, () => {
    parcial = true;
  });

  const poder = new Map();
  let analizadas = 0;
  for (const { votacion, votos } of detalles) {
    const si = Number(votacion.totalSi || 0);
    const no = Number(votacion.totalNo || 0);
    if (si + no === 0) continue;
    const aprobada = (votacion.resultado?.texto || '').startsWith('Aprob');
    const requerido = requeridoPara(votacion.quorum?.texto || '', votacion.fecha);
    const gana = (s, n) => (requerido !== null ? s >= requerido : s > n);
    if (gana(si, no) !== aprobada) continue;
    analizadas += 1;
    const porPartido = new Map();
    for (const voto of votos) {
      const p = partidoPorId.get(String(voto.diputado?.id));
      const op = voto.opcionVoto?.texto;
      if (!p || (op !== 'Afirmativo' && op !== 'En Contra')) continue;
      if (!porPartido.has(p)) porPartido.set(p, { Afirmativo: 0, 'En Contra': 0 });
      porPartido.get(p)[op] += 1;
    }
    for (const [p, c] of porPartido) {
      if (!poder.has(p)) poder.set(p, { pivotal: 0, total: 0 });
      const g = poder.get(p);
      g.total += 1;
      const siFlip = si - c.Afirmativo + c['En Contra'];
      const noFlip = no - c['En Contra'] + c.Afirmativo;
      if (gana(siFlip, noFlip) !== aprobada) g.pivotal += 1;
    }
  }

  const items = [...poder.entries()]
    .map(([alias, g]) => ({
      alias,
      nombre: nombrePartido.get(alias) || alias,
      pivotal: g.pivotal,
      total: g.total,
      poder: g.total ? Math.round((g.pivotal / g.total) * 100) : 0,
    }))
    .sort((a, b) => b.pivotal - a.pivotal || b.poder - a.poder);

  const data = { parcial, analizadas, items };
  persistirLocal(cacheKey, data);
  return data;
}

// Rebeliones coordinadas por territorio: misma región contra su partido.
export async function getBancadasTerritoriales(anno) {
  const cacheKey = `analitica.bancadas.${anno}`;
  const enCache = await leerCache(cacheKey);
  if (enCache !== undefined) return enCache;

  const perfiles = await rosterMap(anno);
  const partidoPorId = new Map(
    [...perfiles.values()].map((d) => [String(d.id), d.partido ? d.partido.alias : null]).filter(([, p]) => p)
  );
  const regionPorId = new Map([...perfiles.values()].map((d) => [String(d.id), d.region]));
  let parcial = false;
  const detalles = await detallesAnno(anno, () => {
    parcial = true;
  });

  const bloques = new Map();
  for (const { votacion, votos } of detalles) {
    const mayoria = mayoriaPartido(votos, partidoPorId);
    const porRegion = new Map();
    for (const voto of votos) {
      const id = String(voto.diputado?.id);
      const op = voto.opcionVoto?.texto;
      if (!id || (op !== 'Afirmativo' && op !== 'En Contra')) continue;
      const lado = mayoria.get(partidoPorId.get(id));
      if (!lado || op === lado) continue;
      const region = regionPorId.get(id);
      if (!region) continue;
      const clave = `${region}|${op}`;
      if (!porRegion.has(clave)) porRegion.set(clave, []);
      porRegion.get(clave).push(id);
    }
    for (const [clave, ids] of porRegion) {
      if (ids.length < 3) continue;
      const [region, direccion] = clave.split('|');
      if (!bloques.has(clave)) {
        bloques.set(clave, { region, direccion: direccion === 'Afirmativo' ? 'a favor' : 'en contra', veces: 0, ejemplos: [] });
      }
      const b = bloques.get(clave);
      b.veces += 1;
      if (b.ejemplos.length < 5) {
        b.ejemplos.push({ id: votacion.id, descripcion: votacion.descripcion, fecha: votacion.fecha, rebeldes: ids.length });
      }
    }
  }

  let items = [...bloques.values()].sort((a, b) => b.veces - a.veces);
  items = await adjuntarProyectos(items);

  const data = { parcial, items };
  persistirLocal(cacheKey, data);
  return data;
}

// Presentes que no votan: alta asistencia y alta tasa de "No Vota".
export async function getFantasmas(anno) {
  const cacheKey = `analitica.fantasmas.${anno}`;
  const enCache = await leerCache(cacheKey);
  if (enCache !== undefined) return enCache;

  const [matriz, rankings, lista] = await Promise.all([
    getVotacionMatriz(anno),
    getRankings(anno),
    fetchCachedData('WSLegislativo', 'retornarVotacionesXAnno', { prmAnno: Number(anno) }, 'collection', 300),
  ]);
  const totalVotaciones = lista.data.length;
  const asistenciaPorId = new Map(rankings.map((r) => [String(r.id), r.asistencia ? r.asistencia.pct : 0]));

  const items = Object.entries(matriz)
    .map(([id, v]) => {
      const r = rankings.find((x) => String(x.id) === id);
      const asistenciaPct = asistenciaPorId.get(id) || 0;
      return {
        id: r ? r.id : Number(id),
        nombre: r ? r.nombre : null,
        apellidoPaterno: r ? r.apellidoPaterno : null,
        partido: r ? r.partido : null,
        distrito: r ? r.distrito : null,
        asistenciaPct,
        noVota: v.noVota || 0,
        tasa: totalVotaciones ? Math.round(((v.noVota || 0) / totalVotaciones) * 100) : 0,
      };
    })
    .filter((d) => d.asistenciaPct >= 70 && d.noVota >= 5)
    .sort((a, b) => b.tasa - a.tasa || b.noVota - a.noVota);

  const data = { parcial: false, totalVotaciones, items };
  persistirLocal(cacheKey, data);
  return data;
}

// Aprobación por hora del día cruzada por iniciativa (mensaje vs moción).
export async function getHoraBruja(anno) {
  const cacheKey = `analitica.horabruja.v3.${anno}`;
  const enCache = await leerCache(cacheKey);
  if (enCache !== undefined) return enCache;

  const annoNum = Number(anno);
  const { data: votacionesAnno } = await fetchCachedData(
    'WSLegislativo', 'retornarVotacionesXAnno', { prmAnno: annoNum }, 'collection', 300
  );
  const boletinesMocion = new Set();
  const boletinesMensaje = new Set();
  let coberturaTotal = false;
  if (pgDisponible()) {
    try {
      const filas = await pg`select boletin, tipo_iniciativa from proyectos`;
      for (const f of filas) {
        if (!f.boletin) continue;
        if (/moc/i.test(f.tipo_iniciativa || '')) boletinesMocion.add(f.boletin);
        else if (/men/i.test(f.tipo_iniciativa || '')) boletinesMensaje.add(f.boletin);
      }
      coberturaTotal = filas.length > 0;
    } catch {
      // sigue a listas por año
    }
  }
  if (!coberturaTotal) {
    const annosIngreso = [];
    for (let a = annoNum; a >= 2020; a -= 1) annosIngreso.push(a);
    const listas = await Promise.all(
      annosIngreso.map(async (a) => {
        try {
          const [moc, men] = await Promise.all([
            fetchCachedData('WSLegislativo', 'retornarMocionesXAnno', { prmAnno: a }, 'collection', 300),
            fetchCachedData('WSLegislativo', 'retornarMensajesXAnno', { prmAnno: a }, 'collection', 300),
          ]);
          return { moc: moc.data || [], men: men.data || [] };
        } catch {
          return { moc: [], men: [] };
        }
      })
    );
    for (const m of listas.flatMap((l) => l.moc)) {
      if (m.numeroBoletin) boletinesMocion.add(m.numeroBoletin);
    }
    for (const m of listas.flatMap((l) => l.men)) {
      if (m.numeroBoletin) boletinesMensaje.add(m.numeroBoletin);
    }
  }

  const porHora = Array.from({ length: 24 }, (_, hora) => ({
    hora,
    total: 0,
    aprobadas: 0,
    tasa: 0,
    mociones: { total: 0, aprobadas: 0, tasa: 0 },
    mensajes: { total: 0, aprobadas: 0, tasa: 0 },
  }));
  for (const v of votacionesAnno) {
    const hora = new Date(v.fecha).getHours();
    if (Number.isNaN(hora)) continue;
    const aprobada = (v.resultado?.texto || '').startsWith('Aprob');
    const m = RE_BOLETIN.exec(String(v.descripcion || ''));
    const tipo = m && boletinesMocion.has(m[1]) ? 'mociones' : m && boletinesMensaje.has(m[1]) ? 'mensajes' : null;
    const g = porHora[hora];
    g.total += 1;
    if (aprobada) g.aprobadas += 1;
    if (tipo) {
      g[tipo].total += 1;
      if (aprobada) g[tipo].aprobadas += 1;
    }
  }
  for (const g of porHora) {
    g.tasa = g.total ? Math.round((g.aprobadas / g.total) * 100) : 0;
    for (const t of ['mociones', 'mensajes']) {
      g[t].tasa = g[t].total ? Math.round((g[t].aprobadas / g[t].total) * 100) : 0;
    }
  }

  const data = { parcial: false, items: porHora };
  persistirLocal(cacheKey, data);
  return data;
}

// Mociones con más firmas que jamás se votaron.
export async function getCementerioVip(anno) {
  const cacheKey = `analitica.cementeriovip.${anno}`;
  const enCache = await leerCache(cacheKey);
  if (enCache !== undefined) return enCache;

  const mociones = await getMocionesIndex(anno);
  const items = mociones
    .filter((m) => (m.votaciones || 0) === 0)
    .map((m) => ({
      boletin: m.boletin,
      nombre: m.nombre,
      fechaIngreso: m.fechaIngreso,
      materias: (m.materias || []).slice(0, 3).map((x) => x.nombre || x),
      autores: (m.autores || [])
        .map((a) => a.diputado || a)
        .filter((d) => d && d.id)
        .map((d) => ({ id: d.id, nombre: d.nombre, apellidoPaterno: d.apellidoPaterno })),
    }))
    .map((m) => ({ ...m, firmas: m.autores.length }))
    .sort((a, b) => b.firmas - a.firmas)
    .slice(0, 20);

  const data = { parcial: false, items };
  persistirLocal(cacheKey, data);
  return data;
}
