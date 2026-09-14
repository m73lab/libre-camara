import { cache, fetchCachedData } from './fetchCached.js';

const ultimoEstado = new Map();

function maxFecha(items, campo) {
  return items.reduce((maximo, item) => {
    const tiempo = item[campo] ? new Date(item[campo]).getTime() : 0;
    return Number.isNaN(tiempo) ? maximo : Math.max(maximo, tiempo);
  }, 0);
}

export async function detectarCambios(anno) {
  if (String(anno) !== String(new Date().getFullYear())) return 0;

  const [votaciones, sesiones] = await Promise.all([
    fetchCachedData('WSLegislativo', 'retornarVotacionesXAnno', { prmAnno: Number(anno) }, 'collection', 300),
    fetchCachedData('WSSala', 'retornarSesionesXAnno', { prmAnno: Number(anno) }, 'collection', 300),
  ]);

  const clave = `${maxFecha(votaciones.data, 'fecha')}|${maxFecha(sesiones.data, 'fechaInicio')}`;
  const previo = ultimoEstado.get(anno);
  ultimoEstado.set(anno, clave);

  if (previo !== undefined && previo !== clave) {
    const eliminadas = cache.eliminarDonde(
      (key) =>
        (key.startsWith('analitica.') || key.startsWith('diputado.')) && key.includes(`.${anno}`)
    );
    console.log(`[fresco] Datos de ${anno} cambiaron en el upstream: purgadas ${eliminadas} entradas`);
    return eliminadas;
  }
  return 0;
}
