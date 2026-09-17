import { callUpstream } from '../lib/camaraClient.js';
import { parseUpstreamXml } from '../lib/xml.js';
import { upsert, reemplazarTodo, logSync, bdEscrituraDisponible } from './util.js';
import { buscarDiputado } from '../lib/distritos.js';
import { LOGOS_PARTIDOS } from '../data/logosPartidos.js';
import { nombrePartido } from '../data/partidosCanonicos.js';

function partidoActual(diputado) {
  const militancias = diputado.militancias || [];
  if (militancias.length === 0) return null;
  const validas = militancias.filter((m) => m.fechaInicio && !Number.isNaN(new Date(m.fechaInicio).getTime()));
  if (validas.length === 0) return null;
  return [...validas].sort((a, b) => new Date(b.fechaInicio) - new Date(a.fechaInicio))[0].partido || null;
}

function aFilaDiputado(d) {
  const alias = partidoActual(d)?.alias || null;
  const match = buscarDiputado(d);
  return {
    id: d.id,
    nombre: d.nombre,
    nombre2: d.nombre2 || null,
    apellido_paterno: d.apellidoPaterno,
    apellido_materno: d.apellidoMaterno || null,
    fecha_nacimiento: d.fechaNacimiento ? d.fechaNacimiento.slice(0, 10) : null,
    rut: d.rut || null,
    rutdv: d.rutdv || null,
    sexo: d.sexo ? d.sexo.texto : null,
    distrito_numero: match ? match.distrito : null,
    partido_actual: alias,
  };
}

function aFilaMilitancia(diputadoId, m) {
  return {
    diputado_id: diputadoId,
    partido_alias: m.partido?.alias || null,
    fecha_inicio: m.fechaInicio ? m.fechaInicio.slice(0, 10) : null,
    fecha_termino: m.fechaTermino ? m.fechaTermino.slice(0, 10) : null,
  };
}

export async function syncDiputados() {
  const inicio = Date.now();
  if (!bdEscrituraDisponible()) return 0;

  const { xml } = await callUpstream('WSDiputado', 'retornarDiputados', {});
  const diputados = parseUpstreamXml(xml, 'collection');

  const partidos = new Map();
  for (const d of diputados) {
    for (const m of d.militancias || []) {
      if (m.partido?.alias) {
        partidos.set(m.partido.alias, {
          alias: m.partido.alias,
          nombre: nombrePartido(m.partido.alias, m.partido.nombre),
        });
      }
    }
  }
  await upsert(
    'partidos',
    [...partidos.values()].map((p) => ({
      alias: p.alias,
      nombre: p.nombre,
      bloque: null,
      tiene_logo: Boolean(LOGOS_PARTIDOS[p.alias]),
    })),
    'alias'
  );

  const filas = diputados.map(aFilaDiputado);
  await upsert('diputados', filas, 'id', 500);

  const militancias = [];
  for (const d of diputados) {
    for (const m of d.militancias || []) {
      const inicio = m.fechaInicio ? m.fechaInicio.slice(0, 10) : null;
      const termino = m.fechaTermino ? m.fechaTermino.slice(0, 10) : null;
      if (inicio && termino && inicio > termino) continue;
      militancias.push({
        diputado_id: d.id,
        partido_alias: m.partido?.alias || null,
        fecha_inicio: inicio,
        fecha_termino: termino,
      });
    }
  }
  await reemplazarTodo('militancias', null, militancias, 1000);

  await logSync('diputados', `${diputados.length} diputados, ${militancias.length} militancias`, filas.length, Date.now() - inicio, true);
  return filas.length;
}

export async function syncPeriodos() {
  const inicio = Date.now();
  if (!bdEscrituraDisponible()) return 0;

  const { xml: xmlP } = await callUpstream('WSLegislativo', 'retornarPeriodosLegislativos', {});
  const periodos = parseUpstreamXml(xmlP, 'collection');
  await upsert(
    'periodos_legislativos',
    periodos.map((p) => ({
      id: p.id,
      nombre: p.nombre,
      fecha_inicio: p.fechaInicio ? p.fechaInicio.slice(0, 10) : null,
      fecha_termino: p.fechaTermino ? p.fechaTermino.slice(0, 10) : null,
    })),
    'id'
  );

  const membresias = [];
  for (const periodo of periodos) {
    try {
      const { xml } = await callUpstream('WSDiputado', 'retornarDiputadosXPeriodo', { prmPeriodoID: Number(periodo.id) });
      const data = parseUpstreamXml(xml, 'collection');
      for (const item of data) {
        const id = item.diputado?.id ?? item.id;
        if (id) membresias.push({ periodo_id: periodo.id, diputado_id: id });
      }
    } catch {
      // periodo no disponible, se omite
    }
  }
  await upsert('periodo_diputados', membresias, 'periodo_id,diputado_id', 1000);

  await logSync('periodos', `${periodos.length} periodos, ${membresias.length} membresías`, membresias.length, Date.now() - inicio, true);
  return membresias.length;
}
