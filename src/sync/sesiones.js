import { callUpstream } from '../lib/camaraClient.js';
import { parseUpstreamXml } from '../lib/xml.js';
import { mapConcurrent } from '../lib/fetchCached.js';
import { upsert, logSync, bdEscrituraDisponible } from './util.js';

export function filasAsistenciaDe(sesionId, detalle) {
  const lista = Array.isArray(detalle?.listadoAsistencia) ? detalle.listadoAsistencia : [];
  return lista
    .filter((a) => a.diputado?.id)
    .map((a) => {
      const just = a.justificacion;
      const justObj = just && typeof just === 'object' ? just : null;
      return {
        sesion_id: sesionId,
        diputado_id: a.diputado.id,
        tipo_asistencia: a.tipoAsistencia ? a.tipoAsistencia.texto : null,
        justificacion: justObj ? justObj.nombre ?? just : just ?? null,
        rebaja_asistencia: justObj ? String(justObj.rebajaAsistencia) === 'true' : null,
        rebaja_quorum: justObj ? String(justObj.rebajaQuorum) === 'true' : null,
      };
    });
}

export async function repararAsistencia(sesionId) {
  const { xml: xmlDetalle } = await callUpstream('WSSala', 'retornarSesionAsistencia', { prmSesionId: Number(sesionId) });
  const detalle = parseUpstreamXml(xmlDetalle, 'single');
  const filas = filasAsistenciaDe(sesionId, detalle);
  if (filas.length > 0) {
    await upsert('asistencias', filas, 'sesion_id,diputado_id', 1000);
  }
  return filas.length;
}

export async function syncSesiones(anno) {
  const inicio = Date.now();
  if (!bdEscrituraDisponible()) return 0;

  const { xml } = await callUpstream('WSSala', 'retornarSesionesXAnno', { prmAnno: Number(anno) });
  const sesiones = parseUpstreamXml(xml, 'collection');

  await upsert(
    'sesiones',
    sesiones.map((s) => ({
      id: s.id,
      numero: s.numero,
      fecha_inicio: s.fechaInicio,
      fecha_termino: s.fechaTermino,
      tipo: s.tipo ? s.tipo.texto : null,
      estado: s.estado ? s.estado.texto : null,
      anno: Number(anno),
    })),
    'id',
    500
  );

  let asistencias = 0;
  let omitidas = 0;
  await mapConcurrent(sesiones, 10, async (s) => {
    try {
      asistencias += await repararAsistencia(s.id);
    } catch {
      omitidas += 1;
    }
  });

  await logSync('sesiones', `${anno}: ${sesiones.length} sesiones, ${asistencias} asistencias${omitidas ? `, ${omitidas} omitidas (reintentar)` : ''}`, sesiones.length, Date.now() - inicio, true);
  return sesiones.length;
}
