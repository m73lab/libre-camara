import { XMLParser } from 'fast-xml-parser';

const PLURAL_CONTAINERS = new Set([
  'militancias',
  'votos',
  'sesiones',
  'asistencias',
  'comunas',
  'diputados',
  'regiones',
  'provincias',
  'distritos',
  'ministerios',
  'partidos',
  'partidospoliticos',
  'tramites',
  'materias',
  'legislaturas',
  'periodos',
  'mociones',
  'mensajes',
  'proyectos',
  'acuerdos',
  'resoluciones',
  'votaciones',
  'respuestas',
  'autores',
  'parlamentarios',
  'urgencias',
  'informes',
  'hitos',
  'integrantes',
  'miembros',
  'justificaciones',
  'discursos',
  'listadoasistencia',
]);

const parser = new XMLParser({
  ignoreAttributes: false,
  ignoreDeclaration: true,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseTagValue: false,
  trimValues: true,
});

function camelKey(key) {
  const leading = key.match(/^[A-Z]+/);
  if (!leading) return key;
  return leading[0].toLowerCase() + key.slice(leading[0].length);
}

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value === null || typeof value !== 'object') return value;

  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (key === '@_Valor') {
      out.valor = /^\d+$/.test(String(val)) ? Number(val) : String(val);
    } else if (key === '#text') {
      out.texto = val;
    } else if (key.startsWith('@_')) {
      continue;
    } else {
      out[camelKey(key)] = normalize(val);
    }
  }
  return Object.keys(out).length === 0 ? null : out;
}

function isPlural(key) {
  const k = key.toLowerCase();
  return k.endsWith('coleccion') || PLURAL_CONTAINERS.has(k);
}

function unwrap(value, plural = false) {
  if (Array.isArray(value)) return value.map((item) => unwrap(item));
  if (value === null || typeof value !== 'object') return plural ? [] : value;

  const keys = Object.keys(value);
  if (plural) {
    if (keys.length === 1) {
      const inner = unwrap(value[keys[0]]);
      return Array.isArray(inner) ? inner : [inner];
    }
    return [value];
  }
  if (keys.length === 1) {
    const key = keys[0];
    return unwrap(value[key], isPlural(key));
  }
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    out[key] = unwrap(val, isPlural(key));
  }
  return out;
}

export function parseUpstreamXml(xml, shape) {
  const parsed = parser.parse(xml);
  let payload = unwrap(normalize(parsed));

  if (payload === null || payload === undefined || payload === '' || typeof payload !== 'object') {
    return shape === 'collection' ? [] : {};
  }
  if (Object.keys(payload).length === 0) {
    return shape === 'collection' ? [] : {};
  }
  if (shape === 'collection' && !Array.isArray(payload)) {
    payload = [payload];
  }
  return payload;
}
