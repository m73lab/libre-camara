import express from 'express';
import { catalog } from './catalog.js';
import { cache, fetchCachedData, mapConcurrent } from './lib/fetchCached.js';
import { UpstreamError } from './lib/camaraClient.js';
import { enriquecerConDistrito } from './lib/distritos.js';
import { calcularContrafactual } from './lib/quorum.js';
import {
  getMocionesIndex,
  getComisionesIndex,
  getContrafactuales,
  getRankings,
  getCementerio,
  getCohesion,
  getDieta,
  getHorarios,
  getBrechas,
  getAfinidad,
  getTransfuguismo,
  getPartidos,
  getPartidoDetalle,
  getTrayectoria,
  getAnalisisTemporal,
  getVotosDecisivos,
  getVelocidadLey,
  getMateriasCementerio,
  getAfinidadPartidos,
  getFiscalizacion,
  getAgendaEjecutivo,
  getFaltasPorPartido,
  getCambiosDeVoto,
  getEdadCongreso,
  getDistritosRepresentacion,
  getCurvaFatiga,
  getBloques,
} from './lib/analitica.js';
import { detectarCambios } from './lib/freshness.js';
import { obtenerFotoDiputado } from './lib/fotos.js';
import { obtenerLogoPartido } from './lib/logos.js';
import { enriquecerVotacion, enriquecerVotaciones, enriquecerVotosConPerfil } from './lib/legible.js';
import { adjuntarFichaVotacion } from './lib/fichaVotacion.js';
import { adjuntarFichaSenado } from './lib/fichaSenado.js';

const cacheEstado = (clave) => (cache.get(clave) !== undefined ? 'HIT' : 'MISS');
import { config } from './config.js';

function groupByPath(entries) {
  const groups = new Map();
  for (const entry of entries) {
    if (!groups.has(entry.path)) groups.set(entry.path, []);
    groups.get(entry.path).push(entry);
  }
  return groups;
}

function priority(entry) {
  const hasParam = entry.path.includes(':');
  const segments = entry.path.split('/').length;
  return [hasParam ? 1 : 0, -segments];
}

function collectParams(req, entry) {
  const out = {};
  for (const param of entry.params) {
    const raw = param.from === 'query' ? req.query[param.key] : req.params[param.key];
    if (raw === undefined || raw === '' || Array.isArray(raw)) {
      if (param.required) return null;
      continue;
    }
    if (param.type === 'int' && !/^\d+$/.test(String(raw))) return null;
    out[param.upstream] = param.type === 'int' ? Number(raw) : String(raw);
  }
  return out;
}

function describeParams(entry) {
  return entry.params
    .map((param) => (param.from === 'query' ? `?${param.key}=` : `/:${param.key}`))
    .join(' ');
}

function makeHandler(entries) {
  return async (req, res, next) => {
    try {
      let match = null;
      let params = null;
      for (const entry of entries) {
        const candidate = collectParams(req, entry);
        if (candidate !== null) {
          match = entry;
          params = candidate;
          break;
        }
      }

      if (!match) {
        const expected = entries.map(describeParams).join(' | ');
        return res.status(400).json({ error: `Faltan parámetros requeridos o son inválidos. Esperado: ${expected}` });
      }

      const started = Date.now();
      let { data, hit } = await fetchCachedData(
        match.service,
        match.method,
        params,
        match.shape,
        match.ttl ?? config.defaultTtl
      );

      if (
        match.flatten &&
        Array.isArray(data) &&
        data.some((item) => item && item[match.flatten] === undefined)
      ) {
        cache.eliminarDonde((k) => k === `${match.service}.${match.method}.${JSON.stringify(params)}`);
        const resultado = await fetchCachedData(
          match.service,
          match.method,
          params,
          match.shape,
          match.ttl ?? config.defaultTtl
        );
        data = resultado.data;
        hit = false;
      }

      let payload =
        match.flatten && Array.isArray(data)
          ? data.map((item) => (item && item[match.flatten] !== undefined ? item[match.flatten] : item))
          : data;

      if (match.enrich === 'distrito' && Array.isArray(payload)) {
        payload = enriquecerConDistrito(payload);
      }

      if (match.legible) {
        payload = Array.isArray(payload)
          ? await enriquecerVotaciones(payload)
          : await enriquecerVotacion(payload);
      }

      if (match.votosPerfil) {
        payload = await enriquecerVotosConPerfil(payload);
      }

      if (match.fichaVotacion && payload && !Array.isArray(payload)) {
        payload = await adjuntarFichaVotacion(payload);
      }

      if (match.fichaSenado && payload && !Array.isArray(payload)) {
        payload = await adjuntarFichaSenado(payload);
      }

      res.set('X-Cache', hit ? 'HIT' : 'MISS');
      res.set('X-Total-Ms', String(Date.now() - started));
      return res.json(envelope(match, payload));
    } catch (err) {
      return next(err);
    }
  };
}

function envelope(entry, data) {
  const body = { data };
  if (Array.isArray(data)) body.meta = { count: data.length };
  return body;
}

function makeDiputadoVotacionesHandler() {
  return async (req, res, next) => {
    try {
      const { id } = req.params;
      const anno = req.query.anno || String(new Date().getFullYear());
      if (!/^\d+$/.test(id) || !/^\d{4}$/.test(anno)) {
        return res.status(400).json({ error: ':id debe ser entero y ?anno=AAAA' });
      }

      await detectarCambios(anno);

      const cacheKey = `diputado.${id}.votaciones.${anno}`;
      const cached = cache.get(cacheKey);
      if (cached !== undefined) {
        res.set('X-Cache', 'HIT');
        return res.json({ data: cached.data, meta: { count: cached.data.length, anno } });
      }

      const started = Date.now();
      const votaciones = await fetchCachedData(
        'WSLegislativo',
        'retornarVotacionesXAnno',
        { prmAnno: Number(anno) },
        'collection',
        300
      );

      const filas = await mapConcurrent(votaciones.data, 20, async (votacion) => {
        const detalle = await fetchCachedData(
          'WSLegislativo',
          'retornarVotacionDetalle',
          { prmVotacionId: Number(votacion.id) },
          'single',
          600
        );
        const miVoto = (detalle.data.votos || []).find(
          (voto) => voto.diputado && String(voto.diputado.id) === String(id)
        );
        if (!miVoto) return null;

        const esRechazada = (votacion.resultado?.texto || '').startsWith('Rechaz');
        const noParticipo = !miVoto.opcionVoto || miVoto.opcionVoto.texto === 'No Vota';
        const contrafactual =
          esRechazada && noParticipo
            ? calcularContrafactual(votacion, detalle.data.votos || [])
            : null;

        return {
          id: votacion.id,
          descripcion: votacion.descripcion,
          fecha: votacion.fecha,
          quorum: votacion.quorum ? votacion.quorum.texto : null,
          resultado: votacion.resultado ? votacion.resultado.texto : null,
          articulo: votacion.articulo || null,
          totales: {
            si: votacion.totalSi,
            no: votacion.totalNo,
            abstencion: votacion.totalAbstencion,
            dispensado: votacion.totalDispensado,
          },
          miVoto: miVoto.opcionVoto ? miVoto.opcionVoto.texto : null,
          contrafactual:
            contrafactual && contrafactual.faltaron !== null ? contrafactual : null,
        };
      });

      const data = filas
        .filter(Boolean)
        .sort((a, b) => new Date(b.fecha) - new Date(a.fecha));

      const dataLegible = await enriquecerVotaciones(data);

      cache.set(cacheKey, { data: dataLegible }, 3600);
      res.set('X-Cache', 'MISS');
      res.set('X-Total-Ms', String(Date.now() - started));
      return res.json({ data: dataLegible, meta: { count: dataLegible.length, anno } });
    } catch (err) {
      return next(err);
    }
  };
}

function makeDiputadoAsistenciaHandler() {
  return async (req, res, next) => {
    try {
      const { id } = req.params;
      const anno = req.query.anno || String(new Date().getFullYear());
      if (!/^\d+$/.test(id) || !/^\d{4}$/.test(anno)) {
        return res.status(400).json({ error: ':id debe ser entero y ?anno=AAAA' });
      }

      await detectarCambios(anno);

      const cacheKey = `diputado.${id}.asistencia.${anno}`;
      const cached = cache.get(cacheKey);
      if (cached !== undefined) {
        res.set('X-Cache', 'HIT');
        return res.json({ data: cached.data, meta: cached.meta });
      }

      const started = Date.now();
      const sesiones = await fetchCachedData(
        'WSSala',
        'retornarSesionesXAnno',
        { prmAnno: Number(anno) },
        'collection',
        300
      );

      const filas = await mapConcurrent(sesiones.data, 20, async (sesion) => {
        const detalle = await fetchCachedData(
          'WSSala',
          'retornarSesionAsistencia',
          { prmSesionId: Number(sesion.id) },
          'single',
          600
        );
        const lista = detalle.data.listadoAsistencia || [];
        const asiento = lista.find(
          (a) => a.diputado && String(a.diputado.id) === String(id)
        );
        if (!asiento) return null;
        const just = asiento.justificacion;
        const justObj = just && typeof just === 'object' ? just : null;
        const justificacion = justObj ? justObj.nombre ?? just : just;
        const rebajaAsistencia = justObj ? String(justObj.rebajaAsistencia) === 'true' : null;
        const tipo = asiento.tipoAsistencia ? asiento.tipoAsistencia.texto : null;
        const clasificacion =
          tipo === 'Asiste'
            ? 'presente'
            : tipo === 'Justificado' || justificacion
              ? 'justificado'
              : 'ausente';
        return {
          sesionId: sesion.id,
          numero: sesion.numero,
          fechaInicio: sesion.fechaInicio,
          fechaTermino: sesion.fechaTermino,
          tipoSesion: sesion.tipo ? sesion.tipo.texto : null,
          estado: sesion.estado ? sesion.estado.texto : null,
          tipoAsistencia: tipo,
          clasificacion,
          justificacion,
          rebajaAsistencia,
        };
      });

      const data = filas
        .filter(Boolean)
        .sort((a, b) => new Date(b.fechaInicio) - new Date(a.fechaInicio));

      const resumen = { presente: 0, ausente: 0, justificado: 0, sinJustificar: 0, justificadoSinRebaja: 0, justificadoConRebaja: 0, cobroSinEstar: 0 };
      for (const fila of data) {
        if (fila.clasificacion === 'presente') resumen.presente += 1;
        else if (fila.clasificacion === 'justificado') {
          resumen.justificado += 1;
          if (fila.rebajaAsistencia === true) resumen.justificadoConRebaja += 1;
          else resumen.justificadoSinRebaja += 1;
        } else resumen.ausente += 1;
      }
      resumen.sinJustificar = resumen.ausente;
      resumen.cobroSinEstar = resumen.sinJustificar + resumen.justificadoSinRebaja;

      const horarios = await getHorarios(anno);
      const dietaMensual = Number(process.env.DIETA_MENSUAL || 8900000);
      const totalSesiones = horarios.sesiones.length;
      resumen.valorPorSesion = totalSesiones ? Math.round((dietaMensual * 12) / totalSesiones) : 0;
      resumen.cobroEstimado = resumen.cobroSinEstar * resumen.valorPorSesion;

      const meta = { anno, count: data.length, resumen };
      cache.set(cacheKey, { data, meta }, 3600);
      res.set('X-Cache', 'MISS');
      res.set('X-Total-Ms', String(Date.now() - started));
      return res.json({ data, meta });
    } catch (err) {
      return next(err);
    }
  };
}

export function buildApp() {
  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', 'public, max-age=60');
    next();
  });

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()), cache: cache.stats() });
  });

  const router = express.Router();

  router.get('/diputados/:id/votaciones', makeDiputadoVotacionesHandler());
  router.get('/diputados/:id/asistencia', makeDiputadoAsistenciaHandler());

  router.get('/diputados/:id/mociones', async (req, res, next) => {
    try {
      const { id } = req.params;
      const anno = req.query.anno || '2025';
      if (!/^\d+$/.test(id) || !/^\d{4}$/.test(anno)) {
        return res.status(400).json({ error: ':id debe ser entero y ?anno=AAAA' });
      }

      await detectarCambios(anno);

      const cacheKey = `diputado.${id}.mociones.${anno}`;
      const cached = cache.get(cacheKey);
      if (cached !== undefined) {
        res.set('X-Cache', 'HIT');
        return res.json({ data: cached.data, meta: { count: cached.data.length, anno } });
      }
      const index = await getMocionesIndex(anno);
      const data = index
        .filter((m) => m.autores.some((a) => String(a.diputado?.id ?? a.id) === String(id)))
        .sort((a, b) => new Date(b.fechaIngreso) - new Date(a.fechaIngreso));
      cache.set(cacheKey, { data }, 3600);
      res.set('X-Cache', 'MISS');
      return res.json({ data, meta: { count: data.length, anno } });
    } catch (err) {
      return next(err);
    }
  });

  router.get('/diputados/:id/foto', async (req, res, next) => {
    try {
      const { id } = req.params;
      if (!/^\d+$/.test(id)) {
        return res.status(400).json({ error: ':id debe ser entero' });
      }
      const foto = await obtenerFotoDiputado(id);
      if (!foto) {
        return res.status(404).json({ error: 'Foto no disponible' });
      }
      res.set('Content-Type', foto.tipo);
      res.set('Cache-Control', 'public, max-age=3600');
      return res.send(foto.buf);
    } catch (err) {
      return next(err);
    }
  });

  router.get('/diputados/:id/comisiones', async (req, res, next) => {
    try {
      const { id } = req.params;
      if (!/^\d+$/.test(id)) {
        return res.status(400).json({ error: ':id debe ser entero' });
      }
      const cacheKey = `diputado.${id}.comisiones`;
      const cached = cache.get(cacheKey);
      if (cached !== undefined) {
        res.set('X-Cache', 'HIT');
        return res.json({ data: cached.data, meta: { count: cached.data.length } });
      }
      const comisiones = await getComisionesIndex();
      const data = comisiones
        .map((c) => {
          const integra = c.integrantes.some((i) => String(i.diputadoId) === String(id));
          const preside = c.presidente && String(c.presidente.diputadoId) === String(id);
          if (!integra && !preside) return null;
          return {
            id: c.id,
            nombre: c.nombre,
            tipo: c.tipo,
            numero: c.numero,
            cargo: integra && preside ? 'preside e integra' : preside ? 'preside' : 'integra',
            fechaInicio: (c.integrantes.find((i) => String(i.diputadoId) === String(id)) || {}).fechaInicio,
          };
        })
        .filter(Boolean);
      cache.set(cacheKey, { data }, 6 * 3600);
      res.set('X-Cache', 'MISS');
      return res.json({ data, meta: { count: data.length } });
    } catch (err) {
      return next(err);
    }
  });

  router.get('/contrafactuales', async (req, res, next) => {
    try {
      const anno = req.query.anno || String(new Date().getFullYear());
      if (!/^\d{4}$/.test(anno)) {
        return res.status(400).json({ error: '?anno=AAAA' });
      }
      await detectarCambios(anno);
      res.set('X-Cache', cacheEstado(`analitica.contrafactuales.v2.${anno}`));
      const { items, parcial } = await getContrafactuales(anno);
      const data = await enriquecerVotaciones(items);
      return res.json({ data, meta: { count: data.length, anno, parcial } });
    } catch (err) {
      return next(err);
    }
  });

  router.get('/rankings', async (req, res, next) => {
    try {
      const anno = req.query.anno || '2026';
      if (!/^\d{4}$/.test(anno)) {
        return res.status(400).json({ error: '?anno=AAAA' });
      }
      await detectarCambios(anno);
      res.set('X-Cache', cacheEstado(`analitica.rankings.${anno}`));
      const data = await getRankings(anno);
      return res.json({ data, meta: { count: data.length, anno } });
    } catch (err) {
      return next(err);
    }
  });

  router.get('/cementerio', async (req, res, next) => {
    try {
      const anno = req.query.anno || '2020';
      if (!/^\d{4}$/.test(anno)) {
        return res.status(400).json({ error: '?anno=AAAA' });
      }
      await detectarCambios(anno);
      res.set('X-Cache', cacheEstado(`analitica.cementerio.${anno}`));
      const data = await getCementerio(anno);
      return res.json({ data, meta: { count: data.length, anno } });
    } catch (err) {
      return next(err);
    }
  });

  router.get('/cohesion', async (req, res, next) => {
    try {
      const anno = req.query.anno || '2026';
      if (!/^\d{4}$/.test(anno)) {
        return res.status(400).json({ error: '?anno=AAAA' });
      }
      await detectarCambios(anno);
      res.set('X-Cache', cacheEstado(`analitica.cohesion.${anno}`));
      const data = await getCohesion(anno);
      return res.json({ data, meta: { count: data.length, anno } });
    } catch (err) {
      return next(err);
    }
  });

  router.get('/dieta', async (req, res, next) => {
    try {
      const anno = req.query.anno || '2026';
      if (!/^\d{4}$/.test(anno)) {
        return res.status(400).json({ error: '?anno=AAAA' });
      }
      await detectarCambios(anno);
      res.set('X-Cache', cacheEstado(`analitica.dieta.${anno}`));
      const { data, valorPorSesion, dietaMensual, totalSesiones } = await getDieta(anno);
      return res.json({ data, meta: { count: data.length, anno, valorPorSesion, dietaMensual, totalSesiones } });
    } catch (err) {
      return next(err);
    }
  });

  router.get('/horarios', async (req, res, next) => {
    try {
      const anno = req.query.anno || '2026';
      if (!/^\d{4}$/.test(anno)) {
        return res.status(400).json({ error: '?anno=AAAA' });
      }
      await detectarCambios(anno);
      res.set('X-Cache', cacheEstado(`analitica.horarios.${anno}`));
      const data = await getHorarios(anno);
      return res.json({ data, meta: { anno } });
    } catch (err) {
      return next(err);
    }
  });

  router.get('/brechas', async (req, res, next) => {
    try {
      const anno = req.query.anno || '2026';
      if (!/^\d{4}$/.test(anno)) {
        return res.status(400).json({ error: '?anno=AAAA' });
      }
      await detectarCambios(anno);
      res.set('X-Cache', cacheEstado(`analitica.brechas.${anno}`));
      const data = await getBrechas(anno);
      return res.json({ data, meta: { anno } });
    } catch (err) {
      return next(err);
    }
  });

  router.get('/afinidad', async (req, res, next) => {
    try {
      const anno = req.query.anno || '2026';
      if (!/^\d{4}$/.test(anno)) {
        return res.status(400).json({ error: '?anno=AAAA' });
      }
      await detectarCambios(anno);
      res.set('X-Cache', cacheEstado(`analitica.afinidad.${anno}`));
      const data = await getAfinidad(anno);
      return res.json({ data, meta: { count: data.length, anno } });
    } catch (err) {
      return next(err);
    }
  });

  router.get('/diputados/:id/afinidad', async (req, res, next) => {
    try {
      const { id } = req.params;
      const anno = req.query.anno || '2026';
      if (!/^\d+$/.test(id) || !/^\d{4}$/.test(anno)) {
        return res.status(400).json({ error: ':id entero y ?anno=AAAA' });
      }
      await detectarCambios(anno);
      const data = await getAfinidad(anno, id);
      res.set('X-Cache', 'MISS');
      return res.json({ data, meta: { count: data.length, anno } });
    } catch (err) {
      return next(err);
    }
  });

  router.get('/transfuguismo', async (req, res, next) => {
    try {
      const data = await getTransfuguismo();
      res.set('X-Cache', 'MISS');
      return res.json({ data, meta: { count: data.length } });
    } catch (err) {
      return next(err);
    }
  });

  router.get('/partidos', async (req, res, next) => {
    try {
      const anno = req.query.anno || '2026';
      if (!/^\d{4}$/.test(anno)) {
        return res.status(400).json({ error: '?anno=AAAA' });
      }
      await detectarCambios(anno);
      res.set('X-Cache', cacheEstado(`analitica.partidos.${anno}`));
      const data = await getPartidos(anno);
      return res.json({ data, meta: { count: data.length, anno } });
    } catch (err) {
      return next(err);
    }
  });

  router.get('/partidos/:alias/foto', async (req, res, next) => {
    try {
      const { alias } = req.params;
      const buf = await obtenerLogoPartido(alias);
      if (!buf) {
        return res.status(404).json({ error: 'Logo no disponible' });
      }
      const tipo =
        buf[0] === 0x89 && buf[1] === 0x50 ? 'image/png' : 'image/jpeg';
      res.set('Content-Type', tipo);
      res.set('Cache-Control', 'public, max-age=86400');
      return res.send(buf);
    } catch (err) {
      return next(err);
    }
  });

  router.get('/partidos/:alias', async (req, res, next) => {
    try {
      const { alias } = req.params;
      const anno = req.query.anno || '2026';
      if (!/^\d{4}$/.test(anno)) {
        return res.status(400).json({ error: '?anno=AAAA' });
      }
      await detectarCambios(anno);
      const data = await getPartidoDetalle(alias.toUpperCase(), anno);
      if (!data) {
        return res.status(404).json({ error: `No se encontró el partido "${alias}"` });
      }
      res.set('X-Cache', cacheEstado(`analitica.partido.${alias.toUpperCase()}.${anno}`));
      return res.json({ data, meta: { anno } });
    } catch (err) {
      return next(err);
    }
  });

  router.get('/trayectoria', async (req, res, next) => {
    try {
      const anno = req.query.anno || '2026';
      if (!/^\d{4}$/.test(anno)) {
        return res.status(400).json({ error: '?anno=AAAA' });
      }
      await detectarCambios(anno);
      res.set('X-Cache', cacheEstado(`analitica.trayectoria.${anno}`));
      const { data, promedio } = await getTrayectoria(anno);
      return res.json({ data, meta: { count: data.length, anno, promedio } });
    } catch (err) {
      return next(err);
    }
  });

  function validarRango(req, res) {
    const { desde, hasta } = req.query;
    const re = /^\d{4}-\d{2}-\d{2}$/;
    if (!re.test(desde || '') || !re.test(hasta || '')) {
      res.status(400).json({ error: '?desde=AAAA-MM-DD&hasta=AAAA-MM-DD obligatorios' });
      return null;
    }
    const d = new Date(desde);
    const h = new Date(hasta);
    if (Number.isNaN(d.getTime()) || Number.isNaN(h.getTime())) {
      res.status(400).json({ error: 'Fechas inválidas' });
      return null;
    }
    if (d > h) {
      res.status(400).json({ error: 'desde no puede ser posterior a hasta' });
      return null;
    }
    if (h.getFullYear() - d.getFullYear() > 3) {
      res.status(400).json({ error: 'El rango máximo es de 3 años' });
      return null;
    }
    return { desde, hasta };
  }

  router.get('/analitica-temporal', async (req, res, next) => {
    try {
      const rango = validarRango(req, res);
      if (!rango) return undefined;
      if (new Date(rango.hasta).getFullYear() === new Date().getFullYear()) {
        await detectarCambios(String(new Date().getFullYear()));
      }
      res.set('X-Cache', cacheEstado(`analitica.temporal.${rango.desde}.${rango.hasta}`));
      const data = await getAnalisisTemporal(rango.desde, rango.hasta);
      return res.json({ data, meta: { desde: rango.desde, hasta: rango.hasta } });
    } catch (err) {
      return next(err);
    }
  });

  router.get('/votos-decisivos', async (req, res, next) => {
    try {
      const rango = validarRango(req, res);
      if (!rango) return undefined;
      if (new Date(rango.hasta).getFullYear() === new Date().getFullYear()) {
        await detectarCambios(String(new Date().getFullYear()));
      }
      res.set('X-Cache', cacheEstado(`analitica.decisivos.v3.${rango.desde}.${rango.hasta}`));
      const { items, parcial } = await getVotosDecisivos(rango.desde, rango.hasta);
      return res.json({ data: items, meta: { count: items.length, desde: rango.desde, hasta: rango.hasta, parcial } });
    } catch (err) {
      return next(err);
    }
  });

  router.get('/velocidad-ley', async (req, res, next) => {
    try {
      const rango = validarRango(req, res);
      if (!rango) return undefined;
      if (new Date(rango.hasta).getFullYear() === new Date().getFullYear()) {
        await detectarCambios(String(new Date().getFullYear()));
      }
      res.set('X-Cache', cacheEstado(`analitica.velocidad.${rango.desde}.${rango.hasta}`));
      const data = await getVelocidadLey(rango.desde, rango.hasta);
      return res.json({ data, meta: { desde: rango.desde, hasta: rango.hasta } });
    } catch (err) {
      return next(err);
    }
  });

  router.get('/cruces/materias', async (req, res, next) => {
    try {
      const anno = req.query.anno || '2020';
      if (!/^\d{4}$/.test(anno)) return res.status(400).json({ error: '?anno=AAAA' });
      await detectarCambios(anno);
      res.set('X-Cache', cacheEstado(`analitica.materiasCemento.${anno}`));
      const data = await getMateriasCementerio(anno);
      return res.json({ data, meta: { count: data.length, anno } });
    } catch (err) {
      return next(err);
    }
  });

  router.get('/cruces/afinidad-partidos', async (req, res, next) => {
    try {
      const anno = req.query.anno || '2026';
      if (!/^\d{4}$/.test(anno)) return res.status(400).json({ error: '?anno=AAAA' });
      await detectarCambios(anno);
      res.set('X-Cache', cacheEstado(`analitica.afinidadPartidos.${anno}`));
      const data = await getAfinidadPartidos(anno);
      return res.json({ data, meta: { count: data.length, anno } });
    } catch (err) {
      return next(err);
    }
  });

  router.get('/cruces/fiscalizacion', async (req, res, next) => {
    try {
      res.set('X-Cache', cacheEstado('analitica.fiscalizacion'));
      const data = await getFiscalizacion();
      return res.json({ data, meta: {} });
    } catch (err) {
      return next(err);
    }
  });

  router.get('/cruces/agenda', async (req, res, next) => {
    try {
      const anno = req.query.anno || '2026';
      if (!/^\d{4}$/.test(anno)) return res.status(400).json({ error: '?anno=AAAA' });
      await detectarCambios(anno);
      res.set('X-Cache', cacheEstado(`analitica.agenda.${anno}`));
      const data = await getAgendaEjecutivo(anno);
      return res.json({ data, meta: { count: data.length, anno } });
    } catch (err) {
      return next(err);
    }
  });

  router.get('/cruces/faltas', async (req, res, next) => {
    try {
      const anno = req.query.anno || '2026';
      if (!/^\d{4}$/.test(anno)) return res.status(400).json({ error: '?anno=AAAA' });
      await detectarCambios(anno);
      res.set('X-Cache', cacheEstado(`analitica.faltasPartido.${anno}`));
      const data = await getFaltasPorPartido(anno);
      return res.json({ data, meta: { count: data.length, anno } });
    } catch (err) {
      return next(err);
    }
  });

  router.get('/cruces/cambios-voto', async (req, res, next) => {
    try {
      const anno = req.query.anno || '2026';
      if (!/^\d{4}$/.test(anno)) return res.status(400).json({ error: '?anno=AAAA' });
      await detectarCambios(anno);
      res.set('X-Cache', cacheEstado(`analitica.cambios.${anno}`));
      const { data, meta } = await getCambiosDeVoto(anno);
      return res.json({ data, meta: { count: data.length, anno, ...meta } });
    } catch (err) {
      return next(err);
    }
  });

  router.get('/cruces/edad', async (req, res, next) => {
    try {
      const anno = req.query.anno || '2026';
      if (!/^\d{4}$/.test(anno)) return res.status(400).json({ error: '?anno=AAAA' });
      await detectarCambios(anno);
      res.set('X-Cache', cacheEstado(`analitica.edad.${anno}`));
      const data = await getEdadCongreso(anno);
      return res.json({ data, meta: { anno } });
    } catch (err) {
      return next(err);
    }
  });

  router.get('/cruces/distritos', async (req, res, next) => {
    try {
      const anno = req.query.anno || '2026';
      if (!/^\d{4}$/.test(anno)) return res.status(400).json({ error: '?anno=AAAA' });
      await detectarCambios(anno);
      res.set('X-Cache', cacheEstado(`analitica.distritos.${anno}`));
      const data = await getDistritosRepresentacion(anno);
      return res.json({ data, meta: { count: data.length, anno } });
    } catch (err) {
      return next(err);
    }
  });

  router.get('/cruces/fatiga', async (req, res, next) => {
    try {
      const anno = req.query.anno || '2026';
      if (!/^\d{4}$/.test(anno)) return res.status(400).json({ error: '?anno=AAAA' });
      await detectarCambios(anno);
      res.set('X-Cache', cacheEstado(`analitica.fatiga.${anno}`));
      const data = await getCurvaFatiga(anno);
      return res.json({ data, meta: { anno } });
    } catch (err) {
      return next(err);
    }
  });

  router.get('/cruces/bloques', async (req, res, next) => {
    try {
      const anno = req.query.anno || '2026';
      if (!/^\d{4}$/.test(anno)) return res.status(400).json({ error: '?anno=AAAA' });
      await detectarCambios(anno);
      res.set('X-Cache', cacheEstado(`analitica.bloques.${anno}`));
      const data = await getBloques(anno);
      return res.json({ data, meta: { count: data.length, anno } });
    } catch (err) {
      return next(err);
    }
  });

  router.get('/distritos', async (req, res, next) => {
    try {
      const { divisionElectoral } = await import('./data/distritos.js');
      const data = divisionElectoral.map((d) => ({
        numero: d.numero,
        region: d.region,
        comunas: d.comunas,
      }));
      return res.json({ data, meta: { count: data.length } });
    } catch (err) {
      return next(err);
    }
  });

  router.get('/comunas/:nombre/diputados', async (req, res, next) => {
    try {
      const { nombre } = req.params;
      const norm = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
      const objetivo = norm(nombre);
      if (!objetivo) return res.status(400).json({ error: 'Ingresa el nombre de una comuna' });

      const { divisionElectoral } = await import('./data/distritos.js');
      const division = divisionElectoral.find((d) =>
        d.comunas.some((c) => norm(c) === objetivo)
      );
      if (!division) {
        return res.status(404).json({ error: `No se encontró la comuna "${nombre}". Revisa la ortografía.` });
      }

      const { data: roster } = await fetchCachedData(
        'WSDiputado',
        'retornarDiputadosPeriodoActual',
        {},
        'collection',
        600
      );
      const diputados = enriquecerConDistrito(
        roster.map((d) => d.diputado ?? d)
      ).filter((d) => d.distrito && d.distrito.numero === division.numero);

      const comuna = division.comunas.find((c) => norm(c) === objetivo);
      return res.json({
        data: {
          comuna,
          distrito: division,
          diputados,
        },
        meta: { count: diputados.length },
      });
    } catch (err) {
      return next(err);
    }
  });

  const groups = [...groupByPath(catalog).values()].sort(
    (a, b) => priority(a[0]) - priority(b[0])
  );

  for (const entries of groups) {
    router.get(entries[0].path, makeHandler(entries));
  }

  app.use('/api/v1', router);

  app.use((req, res) => {
    res.status(404).json({ error: 'Ruta no encontrada' });
  });

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof UpstreamError) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error(err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  });

  return app;
}
