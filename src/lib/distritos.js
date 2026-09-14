import { divisionElectoral, diputadosPorDistrito } from '../data/distritos.js';

const distritoPorNumero = new Map(divisionElectoral.map((d) => [d.numero, d]));

const indiceNombres = new Map();
for (const [distrito, nombre, partido, nacimiento] of diputadosPorDistrito) {
  const key = normalizar(nombre);
  if (!indiceNombres.has(key)) {
    indiceNombres.set(key, []);
  }
  indiceNombres.get(key).push({ distrito, partido, nacimiento });
}

function normalizar(texto) {
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function buscar(diputado) {
  const palabras = [...String(diputado.nombre || '').split(' '), ...String(diputado.nombre2 || '').split(' ')]
    .filter(Boolean);
  const candidatos = [];
  if (diputado.nombre2) {
    candidatos.push(`${diputado.nombre} ${diputado.nombre2} ${diputado.apellidoPaterno}`);
  }
  candidatos.push(`${diputado.nombre} ${diputado.apellidoPaterno}`);
  for (const palabra of palabras) {
    candidatos.push(`${palabra} ${diputado.apellidoPaterno}`);
  }

  const nacimiento = diputado.fechaNacimiento ? new Date(diputado.fechaNacimiento).getFullYear() : null;

  let mejor = null;
  for (const candidato of candidatos) {
    const posibles = indiceNombres.get(normalizar(candidato));
    if (!posibles) continue;
    if (posibles.length === 1) {
      mejor = posibles[0];
      break;
    }
    const conAnno = nacimiento ? posibles.find((p) => p.nacimiento === nacimiento) : null;
    if (conAnno) {
      mejor = conAnno;
      break;
    }
  }
  return mejor;
}

export function buscarDiputado(diputado) {
  const palabras = [...String(diputado.nombre || '').split(' '), ...String(diputado.nombre2 || '').split(' ')]
    .filter(Boolean);
  const candidatos = [];
  if (diputado.nombre2) {
    candidatos.push(`${diputado.nombre} ${diputado.nombre2} ${diputado.apellidoPaterno}`);
  }
  candidatos.push(`${diputado.nombre} ${diputado.apellidoPaterno}`);
  for (const palabra of palabras) {
    candidatos.push(`${palabra} ${diputado.apellidoPaterno}`);
  }

  const nacimiento = diputado.fechaNacimiento ? new Date(diputado.fechaNacimiento).getFullYear() : null;

  let mejor = null;
  for (const candidato of candidatos) {
    const posibles = indiceNombres.get(normalizar(candidato));
    if (!posibles) continue;
    if (posibles.length === 1) {
      mejor = posibles[0];
      break;
    }
    const conAnno = nacimiento ? posibles.find((p) => p.nacimiento === nacimiento) : null;
    if (conAnno) {
      mejor = conAnno;
      break;
    }
  }
  return mejor;
}

export function distritoDe(diputado) {
  const match = buscarDiputado(diputado);
  if (!match) return null;
  const division = distritoPorNumero.get(match.distrito);
  if (!division) return null;
  return {
    numero: match.distrito,
    region: division.region,
    circunscripcion: division.circunscripcion,
    senadores: division.senadores,
    diputados: division.diputados,
    comunas: division.comunas,
  };
}

export function enriquecerConDistrito(diputados) {
  let sinDistrito = 0;
  const enriquecidos = diputados.map((diputado) => {
    const distrito = distritoDe(diputado);
    if (!distrito) {
      sinDistrito += 1;
      return { ...diputado, distrito: null };
    }
    return { ...diputado, distrito };
  });
  console.log(`[distritos] ${diputados.length} diputados procesados, ${sinDistrito} sin emparejar`);
  return enriquecidos;
}
