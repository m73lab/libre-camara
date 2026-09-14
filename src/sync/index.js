import { syncCatalogos } from './catalogos.js';
import { syncDiputados, syncPeriodos } from './diputados.js';
import { syncVotaciones } from './votaciones.js';
import { syncSesiones } from './sesiones.js';
import { syncProyectos } from './proyectos.js';
import { syncComisiones } from './comisiones.js';
import { bdEscrituraDisponible } from './util.js';

const ANNOS = [2026, 2025, 2024, 2023, 2022, 2021, 2020];

export async function syncTodo({ entidades = null, annos = null } = {}) {
  if (!bdEscrituraDisponible()) {
    console.error('[sync] Sin base de datos: configura DATABASE_URL en .env');
    return;
  }

  const hacer = (nombre, fn) => async () => {
    console.log(`[sync] ${nombre}…`);
    try {
      const filas = await fn();
      console.log(`[sync] ✓ ${nombre} (${filas} filas)`);
    } catch (err) {
      console.error(`[sync] ✗ ${nombre}: ${err.message}`);
    }
  };

  const pasos = {
    catalogos: hacer('catálogos', syncCatalogos),
    diputados: hacer('diputados', syncDiputados),
    periodos: hacer('periodos', syncPeriodos),
    comisiones: hacer('comisiones', syncComisiones),
  };
  const annosSync = annos || ANNOS;
  for (const anno of annosSync) {
    pasos[`votaciones-${anno}`] = hacer(`votaciones ${anno}`, () => syncVotaciones(anno));
    pasos[`sesiones-${anno}`] = hacer(`sesiones ${anno}`, () => syncSesiones(anno));
    pasos[`proyectos-${anno}`] = hacer(`proyectos ${anno}`, () => syncProyectos(anno));
  }

  for (const [nombre, paso] of Object.entries(pasos)) {
    if (entidades && !entidades.includes(nombre.split('-')[0])) continue;
    await paso();
  }
  console.log('[sync] Proceso completado');
}
