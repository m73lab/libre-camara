import { callUpstream } from '../lib/camaraClient.js';
import { parseUpstreamXml } from '../lib/xml.js';
import { upsert, logSync, bdEscrituraDisponible } from './util.js';
import { divisionElectoral, diputadosPorDistrito } from '../data/distritos.js';
import { LOGOS_PARTIDOS } from '../data/logosPartidos.js';

export async function syncCatalogos() {
  const inicio = Date.now();
  if (!bdEscrituraDisponible()) return 0;

  await upsert(
    'distritos',
    divisionElectoral.map((d) => ({
      numero: d.numero,
      region: d.region,
      circunscripcion: d.circunscripcion,
      senadores: d.senadores,
      diputados: d.diputados,
      comunas: d.comunas,
    })),
    'numero'
  );

  const partidos = new Map();
  for (const [distrito, nombre, partido] of diputadosPorDistrito) {
    void distrito;
    partidos.set(partido, { alias: partido, nombre, tiene_logo: false });
  }
  for (const alias of Object.keys(LOGOS_PARTIDOS)) {
    if (!partidos.has(alias)) partidos.set(alias, { alias, nombre: alias, tiene_logo: true });
    partidos.get(alias).tiene_logo = true;
  }
  await upsert(
    'partidos',
    [...partidos.values()].map((p) => ({
      alias: p.alias,
      nombre: p.nombre,
      bloque: null,
      tiene_logo: p.tiene_logo,
    })),
    'alias'
  );

  const catalogos = [
    ['regiones', 'retornarRegiones'],
    ['provincias', 'retornarProvincias'],
    ['comunas', 'retornarComunas'],
    ['distritos-api', 'retornarDistritos'],
    ['ministerios', 'retornarMinisterios'],
    ['partidos-api', 'retornarPartidosPoliticos'],
    ['tipos-asistencia', 'retornarTiposAsistencia'],
    ['tipos-quorum', 'retornarTiposQuorumVotacion'],
    ['tipos-resultado', 'retornarTiposResultadoVotacion'],
    ['tipos-votacion', 'retornarTiposVotacion'],
    ['tipos-justificaciones', 'retornarTiposJustificacionesInasistencia'],
    ['tipos-sexo', 'retornarTiposSexo'],
    ['tipos-iniciativa', 'retornarTiposIniciativaProyectoLey'],
    ['tipos-estado', 'retornarTiposEstado'],
    ['tipos-legislatura', 'retornarTiposLegislatura'],
    ['tipos-opcion-voto', 'retornarTiposOpcionVoto'],
  ];
  for (const [tipo, metodo] of catalogos) {
    try {
      const { xml } = await callUpstream('WSComun', metodo, {});
      const data = parseUpstreamXml(xml, 'collection');
      await upsert(
        'catalogos',
        data.map((item) => ({ tipo, clave: String(item.id ?? item.valor ?? JSON.stringify(item)), data: item })),
        'tipo,clave'
      );
    } catch (err) {
      await logSync('catalogos', tipo, 0, Date.now() - inicio, false, err.message);
    }
  }

  const filas = divisionElectoral.length + partidos.size;
  await logSync('catalogos', 'completo', filas, Date.now() - inicio, true);
  return filas;
}
