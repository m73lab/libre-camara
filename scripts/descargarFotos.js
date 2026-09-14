import { callUpstream } from '../src/lib/camaraClient.js';
import { parseUpstreamXml } from '../src/lib/xml.js';
import { descargarFotos } from '../src/lib/fotos.js';

console.log('Descargando fotos de TODOS los diputados históricos…');

const xml = await callUpstream('WSDiputado', 'retornarDiputados', {});
const data = parseUpstreamXml(xml, 'collection');
const ids = data.map((d) => d.id).filter(Boolean);
console.log(`Encontrados ${ids.length} diputados históricos.`);

const ok = await descargarFotos(ids, (n) => {
  if (n % 25 === 0) console.log(`…${n}/${ids.length}`);
});
console.log(`[fotos] Listo: ${ok}/${ids.length} fotos guardadas en disco.`);
process.exit(0);
