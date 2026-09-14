import { callUpstream } from '../lib/camaraClient.js';
import { parseUpstreamXml } from '../lib/xml.js';
import { mapConcurrent } from '../lib/fetchCached.js';
import { upsert, logSync, bdEscrituraDisponible } from './util.js';

const RE_BOLETIN = /^Bolet\u00edn\s*N[\u00b0\u00ba]\s*(\S+)/i;

export function filasVotosDe(votacionId, detalle) {
  return ((detalle && detalle.votos) || [])
    .filter((voto) => voto.diputado?.id)
    .map((voto) => ({
      votacion_id: votacionId,
      diputado_id: voto.diputado.id,
      opcion_voto: voto.opcionVoto ? voto.opcionVoto.texto : null,
    }));
}

export async function repararVotos(votacionId) {
  const { xml: xmlDetalle } = await callUpstream('WSLegislativo', 'retornarVotacionDetalle', { prmVotacionId: Number(votacionId) });
  const detalle = parseUpstreamXml(xmlDetalle, 'single');
  const filas = filasVotosDe(votacionId, detalle);
  if (filas.length > 0) {
    await upsert('votos', filas, 'votacion_id,diputado_id', 1000);
  }
  return filas.length;
}

export async function syncVotaciones(anno) {
  const inicio = Date.now();
  if (!bdEscrituraDisponible()) return 0;

  const { xml } = await callUpstream('WSLegislativo', 'retornarVotacionesXAnno', { prmAnno: Number(anno) });
  const votaciones = parseUpstreamXml(xml, 'collection');

  const filasVotaciones = votaciones.map((v) => {
    const m = RE_BOLETIN.exec(String(v.descripcion || ''));
    return {
      id: v.id,
      descripcion: v.descripcion,
      fecha: v.fecha,
      total_si: v.totalSi ?? 0,
      total_no: v.totalNo ?? 0,
      total_abstencion: v.totalAbstencion ?? 0,
      total_dispensado: v.totalDispensado ?? 0,
      quorum: v.quorum ? v.quorum.texto : null,
      resultado: v.resultado ? v.resultado.texto : null,
      tipo: v.tipo ? v.tipo.texto : null,
      anno: Number(anno),
      boletin: m ? m[1] : null,
    };
  });
  await upsert('votaciones', filasVotaciones, 'id', 500);

  let votos = 0;
  const omitidas = [];
  await mapConcurrent(votaciones, 10, async (v) => {
    try {
      const n = await repararVotos(v.id);
      votos += n;
    } catch {
      omitidas.push(v.id);
    }
  });

  await logSync('votaciones', `${anno}: ${votaciones.length} votaciones, ${votos} votos${omitidas.length ? `, ${omitidas.length} omitidas (reintentar: ${omitidas.slice(0, 10).join(',')}${omitidas.length > 10 ? '…' : ''})` : ''}`, votaciones.length, Date.now() - inicio, true);
  return votaciones.length;
}
