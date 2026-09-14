import { callUpstream } from '../lib/camaraClient.js';
import { parseUpstreamXml } from '../lib/xml.js';
import { upsert, logSync, bdEscrituraDisponible } from './util.js';

export async function syncComisiones() {
  const inicio = Date.now();
  if (!bdEscrituraDisponible()) return 0;

  const listas = [];
  for (const periodo of [9, 10, 11]) {
    try {
      const { xml } = await callUpstream('WSComision', 'retornarComisionesXPeriodo', { prmPeriodoId: periodo });
      listas.push(...parseUpstreamXml(xml, 'collection'));
    } catch {
      // periodo sin comisiones
    }
  }

  const comisiones = [];
  const integrantes = [];
  for (const c of listas) {
    try {
      const { xml } = await callUpstream('WSComision', 'retornarComision', { prmComisionId: Number(c.id) });
      const detalle = parseUpstreamXml(xml, 'single');
      if (!detalle || Object.keys(detalle).length === 0) continue;
      comisiones.push({
        id: detalle.id,
        nombre: detalle.nombre,
        tipo: detalle.tipo ? detalle.tipo.texto : null,
        numero: detalle.numero,
        fecha_inicio: detalle.fechaInicio ? detalle.fechaInicio.slice(0, 10) : null,
        fecha_termino: detalle.fechaTermino ? detalle.fechaTermino.slice(0, 10) : null,
        presidente_diputado_id: detalle.presidente?.id || null,
      });
      for (const i of detalle.integrantes || []) {
        if (!i.diputado?.id) continue;
        integrantes.push({
          comision_id: detalle.id,
          diputado_id: i.diputado.id,
          fecha_inicio: i.fechaInicio ? i.fechaInicio.slice(0, 10) : null,
          fecha_termino: i.fechaTermino ? i.fechaTermino.slice(0, 10) : null,
        });
      }
    } catch {
      // comisión no disponible
    }
  }

  const comisionesUnicas = new Map();
  for (const c of comisiones) {
    if (!comisionesUnicas.has(c.id)) comisionesUnicas.set(c.id, c);
  }
  const integrantesUnicos = new Map();
  for (const i of integrantes) {
    integrantesUnicos.set(`${i.comision_id}|${i.diputado_id}`, i);
  }

  await upsert('comisiones', [...comisionesUnicas.values()], 'id', 500);
  await upsert('comision_integrantes', [...integrantesUnicos.values()], 'comision_id,diputado_id', 1000);

  await logSync('comisiones', `${comisionesUnicas.size} comisiones, ${integrantesUnicos.size} integrantes`, comisionesUnicas.size, Date.now() - inicio, true);
  return comisionesUnicas.size;
}
