import { callUpstream } from '../lib/camaraClient.js';
import { parseUpstreamXml } from '../lib/xml.js';
import { mapConcurrent } from '../lib/fetchCached.js';
import { upsert, logSync, bdEscrituraDisponible } from './util.js';

async function listar(servicio, metodo, prm) {
  const { xml } = await callUpstream(servicio, metodo, prm);
  return parseUpstreamXml(xml, 'collection');
}

export async function syncProyectos(anno) {
  const inicio = Date.now();
  if (!bdEscrituraDisponible()) return 0;

  const [mociones, mensajes] = await Promise.all([
    listar('WSLegislativo', 'retornarMocionesXAnno', { prmAnno: Number(anno) }),
    listar('WSLegislativo', 'retornarMensajesXAnno', { prmAnno: Number(anno) }),
  ]);

  const boletines = [...new Set([...mociones, ...mensajes].map((p) => p.numeroBoletin).filter(Boolean))];

  const proyectos = [];
  const proyectoVotaciones = [];
  let omitidos = 0;

  await mapConcurrent(boletines, 10, async (boletin) => {
    try {
      const { xml } = await callUpstream('WSLegislativo', 'retornarProyectoLey', { prmNumeroBoletin: boletin });
      const p = parseUpstreamXml(xml, 'single');
      if (!p || Object.keys(p).length === 0) return;
      proyectos.push({
        boletin: p.numeroBoletin || boletin,
        camara_id: p.id ? Number(p.id) : null,
        nombre: p.nombre,
        fecha_ingreso: p.fechaIngreso ? p.fechaIngreso.slice(0, 10) : null,
        tipo_iniciativa: p.tipoIniciativa ? p.tipoIniciativa.texto : null,
        camara_origen: p.camaraOrigen ? p.camaraOrigen.texto : null,
        admisible: p.admisible === 'true' || p.admisible === true,
        anno: Number(anno),
        autores: (p.autores || []).map((a) => ({
          id: a.diputado?.id ?? a.id,
          nombre: a.diputado?.nombre,
          apellidoPaterno: a.diputado?.apellidoPaterno,
        })),
        ministerios: (p.ministeriosPatrocinantes || []).map((m) => ({ id: m.id, nombre: m.nombre })),
        materias: (p.materias || []).map((m) => ({ id: m.id, nombre: m.nombre })),
      });
      for (const v of p.votaciones || []) {
        proyectoVotaciones.push({
          proyecto_boletin: p.numeroBoletin || boletin,
          votacion_id: v.id,
          articulo: v.articulo || null,
          tramite_constitucional: v.tramiteConstitucional ? v.tramiteConstitucional.texto : null,
          tramite_reglamentario: v.tramiteReglamentario ? v.tramiteReglamentario.texto : null,
        });
      }
    } catch {
      omitidos += 1;
    }
  });

  await upsert('proyectos', proyectos, 'boletin', 500);
  await upsert('proyecto_votaciones', proyectoVotaciones, 'proyecto_boletin,votacion_id', 1000);

  await logSync('proyectos', `${anno}: ${proyectos.length} proyectos, ${proyectoVotaciones.length} vínculos${omitidos ? `, ${omitidos} omitidos (reintentar)` : ''}`, proyectos.length, Date.now() - inicio, true);
  return proyectos.length;
}
