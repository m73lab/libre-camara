import { pg, pgDisponible } from '../lib/pgDirecto.js';

export async function guardarAnalitica(clave, data) {
  if (!pgDisponible()) return;
  try {
    const anno = /\.(\d{4})$/.exec(clave)?.[1];
    await pg`
      insert into analiticas (clave, anno, data, calculado_en)
      values (${clave}, ${anno ? Number(anno) : null}, ${pg.json(data)}, ${new Date().toISOString()})
      on conflict (clave) do update set
        anno = excluded.anno, data = excluded.data, calculado_en = excluded.calculado_en`;
  } catch {
    // la persistencia no debe tumbar el cálculo
  }
}

export async function leerAnalitica(clave) {
  if (!pgDisponible()) return undefined;
  try {
    const [fila] = await pg`select data from analiticas where clave = ${clave}`;
    return fila?.data;
  } catch {
    return undefined;
  }
}
