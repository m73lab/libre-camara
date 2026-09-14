import { TtlCache } from './cache.js';
import { callUpstream } from './camaraClient.js';
import { parseUpstreamXml } from './xml.js';

export const cache = new TtlCache();

const BD_VACIO = Symbol('bd-vacio');

const PERMITIDOS_UPSTREAM = new Set([
  'WSProyectosAcuerdo|retornarProyectosAcuerdoXAnno',
  'WSProyectosResolucion|retornarProyectosResolucionXAnno',
]);

async function desdeBd(service, method, params) {
  const { fuente, usarBd } = await import('../modules/fuente.js');
  if (!usarBd()) return undefined;
  const clave = `${service}|${method}`;
  if (PERMITIDOS_UPSTREAM.has(clave)) return undefined;
  const resolutor = fuente[clave];
  if (!resolutor) return BD_VACIO;
  const resultado = await resolutor(params);
  return resultado === undefined ? BD_VACIO : resultado;
}

export async function fetchCachedData(service, method, params, shape, ttl) {
  const cacheKey = `${service}.${method}.${JSON.stringify(params)}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return { data: cached, hit: true };

  const bd = await desdeBd(service, method, params);
  if (bd === BD_VACIO) {
    const vacio = shape === 'collection' ? [] : {};
    cache.set(cacheKey, vacio, 60);
    return { data: vacio, hit: true };
  }
  if (bd !== undefined) {
    cache.set(cacheKey, bd, ttl);
    return { data: bd, hit: true };
  }

  const { xml } = await callUpstream(service, method, params);
  const data = parseUpstreamXml(xml, shape);
  cache.set(cacheKey, data, ttl);
  return { data, hit: false };
}

export async function mapConcurrent(items, limit, fn) {
  const results = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
