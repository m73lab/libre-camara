import { supabase } from '../config/supabase.js';
import { pg, pgDisponible } from '../lib/pgDirecto.js';

export async function guardarAnalitica(clave, data) {
  if (pgDisponible()) {
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
    return;
  }
  if (!supabase) return;
  try {
    const anno = /\.(\d{4})$/.exec(clave)?.[1];
    await supabase.from('analiticas').upsert(
      { clave, anno: anno ? Number(anno) : null, data, calculado_en: new Date().toISOString() },
      { onConflict: 'clave' }
    );
  } catch {
    // la persistencia no debe tumbar el cálculo
  }
}

export async function leerAnalitica(clave) {
  if (pgDisponible()) {
    try {
      const [fila] = await pg`select data from analiticas where clave = ${clave}`;
      return fila?.data;
    } catch {
      return undefined;
    }
  }
  if (!supabase) return undefined;
  try {
    const { data } = await supabase.from('analiticas').select('data').eq('clave', clave).maybeSingle();
    return data?.data;
  } catch {
    return undefined;
  }
}
