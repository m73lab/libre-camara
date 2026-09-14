import { callUpstream } from '../src/lib/camaraClient.js';
import { parseUpstreamXml } from '../src/lib/xml.js';
import { pg, pgDisponible } from '../src/lib/pgDirecto.js';
import { logSync } from '../src/sync/util.js';
import { repararVotos } from '../src/sync/votaciones.js';
import { repararAsistencia } from '../src/sync/sesiones.js';
import { mapConcurrent } from '../src/lib/fetchCached.js';

const args = process.argv.slice(2);
const soloAnno = args.includes('--anno') ? Number(args[args.indexOf('--anno') + 1]) : null;
const reparar = args.includes('--reparar');

if (!pgDisponible()) {
  console.error('[auditoria] Sin base de datos: configura DATABASE_URL en .env');
  process.exit(2);
}

const annos = soloAnno ? [soloAnno] : [2026, 2025, 2024, 2023, 2022, 2021, 2020];
const inicio = Date.now();
let huecosTotales = 0;

async function listaUpstream(servicio, metodo, anno) {
  const { xml } = await callUpstream(servicio, metodo, { prmAnno: Number(anno) });
  return parseUpstreamXml(xml, 'collection');
}

for (const anno of annos) {
  console.log(`[auditoria] Año ${anno}…`);
  const informe = { anno, votaciones: {}, sesiones: {} };

  const listaV = await listaUpstream('WSLegislativo', 'retornarVotacionesXAnno', anno);
  const [dbV] = await pg`select count(*)::int as n from votaciones where anno = ${anno}`;
  const sinVotos = await pg`
    select v.id from votaciones v
    where v.anno = ${anno} and not exists (select 1 from votos where votacion_id = v.id)`;
  informe.votaciones = {
    lista: listaV.length,
    enBd: dbV.n,
    sinDetalle: sinVotos.map((r) => r.id),
  };
  console.log(`  votaciones: lista=${listaV.length} bd=${dbV.n} sinVotos=${sinVotos.length}`);

  const listaS = await listaUpstream('WSSala', 'retornarSesionesXAnno', anno);
  const [dbS] = await pg`select count(*)::int as n from sesiones where anno = ${anno}`;
  // Citada = convocada pero aún no celebrada: no tiene asistencia por definición
  const sinAsist = await pg`
    select s.id from sesiones s
    where s.anno = ${anno} and s.estado <> 'Citada'
      and not exists (select 1 from asistencias where sesion_id = s.id)`;
  informe.sesiones = {
    lista: listaS.length,
    enBd: dbS.n,
    sinDetalle: sinAsist.map((r) => r.id),
  };
  console.log(`  sesiones: lista=${listaS.length} bd=${dbS.n} sinAsist=${sinAsist.length}`);

  const huecos = sinVotos.length + sinAsist.length;
  huecosTotales += huecos;

  if (reparar && huecos > 0) {
    console.log(`  reparando ${huecos} huecos…`);
    let ok = 0;
    await mapConcurrent(sinVotos.map((r) => r.id), 10, async (id) => {
      try {
        await repararVotos(id);
        ok += 1;
      } catch {
        // sigue con el siguiente; queda reportado
      }
    });
    await mapConcurrent(sinAsist.map((r) => r.id), 10, async (id) => {
      try {
        await repararAsistencia(id);
        ok += 1;
      } catch {
        // sigue con el siguiente; queda reportado
      }
    });
    console.log(`  reparados ${ok}/${huecos}`);
    informe.reparados = ok;
  }

  await logSync(
    'auditoria',
    `${anno}: votaciones lista=${informe.votaciones.lista} bd=${informe.votaciones.enBd} sinVotos=${informe.votaciones.sinDetalle.length}; sesiones lista=${informe.sesiones.lista} bd=${informe.sesiones.enBd} sinAsist=${informe.sesiones.sinDetalle.length}${informe.reparados !== undefined ? `; reparados=${informe.reparados}` : ''}`,
    huecos,
    Date.now() - inicio,
    true
  );
}

console.log(`[auditoria] Huecos totales: ${huecosTotales}${reparar ? ' (con intento de reparación)' : ' (usa --reparar para corregir)'}`);
await pg.end();
process.exit(huecosTotales > 0 ? 1 : 0);
