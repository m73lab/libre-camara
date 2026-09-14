import { buildApp } from './routes.js';
import { catalog } from './catalog.js';
import { config } from './config.js';
import { iniciarBot } from './lib/bot.js';
import { descargarFotos } from './lib/fotos.js';
import { descargarTodosLosLogos } from './lib/logos.js';
import { calentarLegible } from './lib/legible.js';
import { fetchCachedData } from './lib/fetchCached.js';

const app = buildApp();

app.listen(config.port, () => {
  const groups = new Set(catalog.map((entry) => entry.path));
  console.log(`API Cámara de Diputados escuchando en http://localhost:${config.port}/api/v1`);
  console.log(`${catalog.length} operaciones upstream en ${groups.size} rutas`);
  iniciarBot();
  calentarFotos();
  descargarTodosLosLogos().catch((err) => console.error('[logos] falló:', err.message));
  calentarLegible(String(new Date().getFullYear())).catch((err) =>
    console.error('[legible] warm-up falló:', err.message)
  );
  calentarAnaliticas();
});

async function calentarAnaliticas() {
  try {
    const {
      getRankings,
      getTrayectoria,
      getPartidos,
      getBloques,
      getContrafactuales,
      getDieta,
      getCohesion,
      getBrechas,
      getAnalisisTemporal,
    } = await import('./lib/analitica.js');
    const anno = String(new Date().getFullYear());
    console.log(`[warm] Calculando analíticas de ${anno} en segundo plano…`);
    const sw = Date.now();
    await Promise.allSettled([
      getRankings(anno),
      getTrayectoria(anno),
      getPartidos(anno),
      getBloques(anno),
      getContrafactuales(anno),
      getDieta(anno),
      getCohesion(anno),
      getBrechas(anno),
      getAnalisisTemporal(`${anno}-01-01`, `${anno}-12-31`),
    ]);
    console.log(`[warm] Analíticas listas en ${Math.round((Date.now() - sw) / 1000)}s`);
  } catch (err) {
    console.error('[warm] Error:', err.message);
  }
}

async function calentarFotos() {
  try {
    const { data } = await fetchCachedData(
      'WSDiputado',
      'retornarDiputadosPeriodoActual',
      {},
      'collection',
      600
    );
    const ids = data.map((d) => d.diputado?.id ?? d.id).filter(Boolean);
    console.log(`[fotos] Descargando ${ids.length} fotos del periodo actual…`);
    const ok = await descargarFotos(ids, (n, id) => {
      if (n % 20 === 0) console.log(`[fotos] ${n}/${ids.length} (último: ${id})`);
    });
    console.log(`[fotos] ${ok}/${ids.length} fotos guardadas en disco`);
  } catch (err) {
    console.error('[fotos] warm-up falló:', err.message);
  }
}
