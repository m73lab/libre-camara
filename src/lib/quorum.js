// La Cámara tuvo 120 escaños hasta la reforma de 2015 (aplicada desde la
// elección de 2017, periodo 2018 en adelante) y 155 desde entonces.
// Los quórums dependen del total de miembros en ejercicio.
export function escanosPara(annoOFecha) {
  const anno = Number(String(annoOFecha || '').slice(0, 4));
  if (!Number.isNaN(anno) && anno < 2018) return 120;
  return 155;
}

function tablaPara(escanos) {
  const mitadMasUno = Math.floor(escanos / 2) + 1;
  return {
    'Quórum Calificado': mitadMasUno,
    'Reforma Constitucional 2/3': Math.ceil((escanos * 2) / 3),
    'Reforma Constitucional 3/5': Math.ceil((escanos * 3) / 5),
    'Ley Orgánica Constitucional': Math.ceil((escanos * 4) / 7),
    'Ley Interpretativa': mitadMasUno,
    '3/5': Math.ceil((escanos * 3) / 5),
    '2/5': Math.ceil((escanos * 2) / 5),
    '1/3': Math.ceil(escanos / 3),
    '2/3': Math.ceil((escanos * 2) / 3),
    'Reforma Constitucional 4/7': Math.ceil((escanos * 4) / 7),
    'Ley Interpretativa 4/7': Math.ceil((escanos * 4) / 7),
  };
}

export function requeridoPara(quorumTexto, annoOFecha) {
  const tabla = tablaPara(escanosPara(annoOFecha));
  return tabla[quorumTexto] ?? null;
}

export function calcularContrafactual(votacion, votosList, totalDiputados = null) {
  const escanos = totalDiputados ?? escanosPara(votacion.fecha);
  const listados = votosList.length;
  const ausentes = Math.max(0, escanos - listados);
  const noVotaron = votosList.filter((voto) => voto.opcionVoto?.texto === 'No Vota').length;
  const disponibles = ausentes + noVotaron;
  const si = Number(votacion.totalSi || 0);
  const no = Number(votacion.totalNo || 0);

  const textoQuorum = votacion.quorum?.texto || votacion.quorum || null;
  const requerido = requeridoPara(textoQuorum, votacion.fecha);
  let faltaron = null;
  if (requerido !== null) {
    faltaron = Math.max(0, requerido - si);
  } else if (textoQuorum === 'Quórum Simple') {
    faltaron = Math.max(0, no - si + 1);
  }

  const habrianAlcanzado = faltaron !== null && faltaron > 0 && disponibles >= faltaron;

  return {
    requerido,
    faltaron,
    ausentes,
    noVotaron,
    disponibles,
    habrianAlcanzado,
  };
}

export function clasificarAsistencia(tipoAsistencia, justificacion) {
  if (tipoAsistencia === 'Asiste') return 'presente';
  if (tipoAsistencia === 'Justificado' || justificacion) return 'justificado';
  return 'ausente';
}

export function clasificarVoto(opcionTexto) {
  if (opcionTexto === 'Afirmativo' || opcionTexto === 'En Contra' || opcionTexto === 'Abstención') {
    return 'emitido';
  }
  if (opcionTexto === 'Dispensado') return 'dispensado';
  if (opcionTexto === 'No Vota') return 'noVota';
  return 'ausente';
}
