export const BLOQUES = {
  izquierda: { nombre: 'Izquierda', partidos: ['FA', 'PC', 'PS', 'PPD', 'PL', 'FRVS', 'PAH', 'PR'] },
  centro: { nombre: 'Centro', partidos: ['DC', 'PDC'] },
  derecha: { nombre: 'Derecha', partidos: ['UDI', 'RN', 'EVOP', 'PREP', 'PNL', 'PSC'] },
  otros: { nombre: 'Otros', partidos: ['PDG'] },
  independientes: { nombre: 'Independientes', partidos: ['IND'] },
};

export const GOBIERNO = {
  nombre: 'Gobierno',
  partidos: [...BLOQUES.derecha.partidos, ...BLOQUES.otros.partidos],
};

export const OPOSICION = {
  nombre: 'Oposición',
  partidos: [...BLOQUES.izquierda.partidos, ...BLOQUES.centro.partidos],
};

export const AGRUPACIONES = [
  { clave: 'gobierno', ...GOBIERNO },
  { clave: 'oposicion', ...OPOSICION },
  { clave: 'independientes', ...BLOQUES.independientes },
];
