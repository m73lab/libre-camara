import { fetchXml } from './upstreamGet.js';
import { parseUpstreamXml } from './xml.js';
import { pg, pgDisponible } from './pgDirecto.js';
import { derivarEtapa } from './legible.js';

const URL_DETALLE = 'https://opendata.camara.cl/wscamaradiputados.asmx/getVotacion_Detalle';
const HORA_MS = 3600 * 1000;
const fallos = new Map();

function normalizarFicha(d) {
  const s = d.sesion && typeof d.sesion === 'object' ? d.sesion : {};
  const sesion = s.id
    ? {
        id: Number(s.id),
        numero: s.numero ? Number(s.numero) : null,
        fecha: s.fecha || null,
        tipo: s.tipo?.texto || (typeof s.tipo === 'string' ? s.tipo : null),
      }
    : null;
  const ficha = {
    sesion,
    boletin: d.boletin || null,
    articulo: d.articulo || null,
    tramite: d.tramite?.texto || (typeof d.tramite === 'string' ? d.tramite : null),
    informe: d.informe?.texto || (typeof d.informe === 'string' ? d.informe : null),
    tipoVotacion: d.tipo?.texto || (typeof d.tipo === 'string' ? d.tipo : null),
  };
  if (!ficha.sesion && !ficha.boletin && !ficha.tramite && !ficha.articulo) return null;
  return ficha;
}

export async function obtenerFichaVotacion(id) {
  const clave = String(id);
  if (pgDisponible()) {
    try {
      const [fila] = await pg`select ficha from votaciones where id = ${Number(id)}`;
      if (fila?.ficha) return fila.ficha;
    } catch {
      // sigue a upstream
    }
  }
  const fallo = fallos.get(clave);
  if (fallo && Date.now() - fallo < HORA_MS) return null;
  let ficha = null;
  try {
    const res = await fetchXml(URL_DETALLE, { prmVotacionID: Number(id) });
    if (res) {
      const d = parseUpstreamXml(res.xml, 'single');
      if (d && Object.keys(d).length > 0) ficha = normalizarFicha(d);
    }
  } catch {
    ficha = null;
  }
  if (!ficha) {
    fallos.set(clave, Date.now());
    return null;
  }
  fallos.delete(clave);
  if (pgDisponible()) {
    try {
      await pg`update votaciones set ficha = ${pg.json(ficha)}, ficha_actualizada = now() where id = ${Number(id)}`;
    } catch {
      // la persistencia no debe tumbar la respuesta
    }
  }
  return ficha;
}

export async function adjuntarFichaVotacion(votacion) {
  if (!votacion || votacion.ficha) return votacion;
  const ficha = await obtenerFichaVotacion(votacion.id);
  if (!ficha) return { ...votacion, ficha: null };
  const salida = { ...votacion, ficha };
  if (!salida.etapa && ficha.articulo) {
    salida.etapa = derivarEtapa(ficha.articulo);
  }
  if (!salida.proyecto && ficha.boletin) {
    const { resolverProyecto } = await import('./legible.js');
    salida.proyecto = await resolverProyecto(ficha.boletin);
  }
  return salida;
}
