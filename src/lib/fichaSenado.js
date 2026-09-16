import { fetchXml } from './upstreamGet.js';
import { parseUpstreamXml } from './xml.js';
import { pg, pgDisponible } from './pgDirecto.js';

const URL_TRAMITACION = 'https://tramitacion.senado.cl/wspublico/tramitacion.php';
const HORA_MS = 3600 * 1000;
const fallos = new Map();

function campo(obj, ...nombres) {
  if (!obj || typeof obj !== 'object') return null;
  const plano = {};
  for (const [k, v] of Object.entries(obj)) {
    plano[String(k).toLowerCase().replace(/_/g, '')] = v;
  }
  for (const n of nombres) {
    const v = plano[String(n).toLowerCase().replace(/_/g, '')];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
}

function texto(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return texto(v.texto ?? v.nombre ?? null);
  const t = String(v).trim();
  return t || null;
}

function aISO(fecha) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(fecha || '').trim());
  if (!m) {
    const t = String(fecha || '').slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null;
  }
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

const comoLista = (v) => (!v ? [] : Array.isArray(v) ? v : [v]);

function normalizarFicha(p) {
  const d = p.descripcion || {};
  const tramites = comoLista(p.tramitacion?.tramite ?? p.tramitacion).map((t) => ({
    fecha: aISO(campo(t, 'fecha')),
    sesion: texto(campo(t, 'sesion')),
    descripcion: texto(campo(t, 'descripcionTramite', 'descripcion')),
    etapa: texto(campo(t, 'etapDescripcion', 'etapa')),
    camara: texto(campo(t, 'camaraTramite', 'camara')),
  }));
  const urgencias = comoLista(p.urgencias?.urgencia ?? p.urgencias).map((u) => ({
    tipo: texto(campo(u, 'tipo')),
    fechaIngreso: aISO(campo(u, 'fechaIngreso')),
    mensajeIngreso: texto(campo(u, 'mensajeIngreso')),
    fechaRetiro: aISO(campo(u, 'fechaRetiro')),
    mensajeRetiro: texto(campo(u, 'mensajeRetiro')),
  }));
  return {
    boletin: texto(campo(d, 'boletin')),
    titulo: texto(campo(d, 'titulo')),
    etapa: texto(campo(d, 'etapa')),
    subetapa: texto(campo(d, 'subetapa')),
    estado: texto(campo(d, 'estado')),
    urgencia: texto(campo(d, 'urgenciaActual', 'urgencia')),
    ley: texto(campo(d, 'leynro', 'ley')),
    diarioOficial: texto(campo(d, 'diarioOficial')),
    linkTexto: texto(campo(d, 'linkMensajeMocion', 'link')),
    tramites,
    urgencias,
  };
}

export async function obtenerFichaSenado(boletin) {
  const correlativo = String(boletin || '').split('-')[0];
  if (!correlativo) return null;
  if (pgDisponible()) {
    try {
      const [fila] = await pg`select ficha_senado from proyectos where boletin = ${String(boletin)}`;
      if (fila?.ficha_senado) return fila.ficha_senado;
    } catch {
      // sigue a upstream
    }
  }
  const fallo = fallos.get(correlativo);
  if (fallo && Date.now() - fallo < HORA_MS) return null;
  let ficha = null;
  try {
    const res = await fetchXml(URL_TRAMITACION, { boletin: correlativo });
    if (res) {
      const lista = parseUpstreamXml(res.xml, 'collection');
      const p = (lista || []).find(
        (x) => texto(campo(x.descripcion || {}, 'boletin')) === String(boletin)
      ) || lista?.[0];
      if (p) ficha = normalizarFicha(p);
    }
  } catch {
    ficha = null;
  }
  if (!ficha?.boletin) {
    fallos.set(correlativo, Date.now());
    return null;
  }
  fallos.delete(correlativo);
  if (pgDisponible()) {
    try {
      await pg`update proyectos set ficha_senado = ${pg.json(ficha)}, ficha_senado_actualizada = now() where boletin = ${String(boletin)}`;
    } catch {
      // la persistencia no debe tumbar la respuesta
    }
  }
  return ficha;
}

export async function adjuntarFichaSenado(proyecto) {
  if (!proyecto || proyecto.fichaSenado) return proyecto;
  const ficha = await obtenerFichaSenado(proyecto.numeroBoletin);
  if (!ficha) return { ...proyecto, fichaSenado: null };
  return { ...proyecto, fichaSenado: ficha };
}
