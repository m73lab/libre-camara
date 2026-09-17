// Nombres canónicos de partidos. El upstream a veces devuelve el nombre de
// otro diputado en `partido.nombre` (datos sucios), y como el sync hacía
// upsert ciego por alias, el último en escribir ganaba y envenenaba la tabla.
// Con este mapa el nombre siempre sale de aquí; el upstream solo aporta
// alias nuevos (que además quedan visibles en auditoría).
export const PARTIDOS_CANONICOS = {
  AMA: 'Movimiento Amarillos por Chile',
  AMPL: 'Amplitud',
  COMUNES: 'Partido Comunes',
  DC: 'Partido Demócrata Cristiano',
  PDC: 'Partido Demócrata Cristiano',
  DEM: 'Demócratas',
  EVOP: 'Evolución Política',
  'Evópoli': 'Evolución Política',
  FA: 'Frente Amplio',
  FREVS: 'Federación Regionalista Verde Social',
  FRVS: 'Federación Regionalista Verde Social',
  IC: 'Izquierda Ciudadana',
  IGUAL: 'Partido Igualdad',
  IND: 'Independientes',
  Ind: 'Independientes',
  LIBERAL: 'Partido Liberal de Chile',
  PAH: 'Partido Acción Humanista',
  PC: 'Partido Comunista de Chile',
  PCCh: 'Partido Comunista de Chile',
  PCC: 'Partido Conservador Cristiano',
  PCCH: 'Partido Cristiano de Chile',
  PCS: 'Partido Convergencia Social',
  PDG: 'Partido de la Gente',
  PEV: 'Partido Ecologista Verde',
  PH: 'Partido Humanista',
  PL: 'Partido Liberal',
  PNL: 'Partido Nacional Libertario',
  PPD: 'Partido Por la Democracia',
  PR: 'Partido Radical',
  PRCh: 'Partido Republicano de Chile',
  PREP: 'Partido Republicano',
  PRI: 'Partido Regionalista Independiente',
  PRO: 'Partido Progresista',
  PS: 'Partido Socialista',
  PSC: 'Partido Social Cristiano',
  RD: 'Revolución Democrática',
  RN: 'Renovación Nacional',
  UCP: 'Unión de Centro Progresista',
  UDI: 'Unión Demócrata Independiente',
};

export function nombrePartido(alias, alternativa = null) {
  if (!alias) return alternativa;
  if (PARTIDOS_CANONICOS[alias]) return PARTIDOS_CANONICOS[alias];
  if (/^ind-/i.test(alias)) return 'Independientes';
  return alternativa || alias;
}
