import { supabase } from '../config/supabase.js';
import { pg, pgDisponible } from '../lib/pgDirecto.js';

export const bdEscrituraDisponible = () => pgDisponible() || supabase !== null;

const ident = (s) => `"${String(s).replace(/"/g, '""')}"`;
const normalizar = (v) => (v === undefined ? null : v);

async function upsertPg(tabla, lote, onConflict) {
  if (lote.length === 0) return 0;
  const cols = [...new Set(lote.flatMap((f) => Object.keys(f)))];
  const conflicto = onConflict.split(',').map((s) => s.trim()).filter(Boolean);
  const resto = cols.filter((c) => !conflicto.includes(c));
  const accion =
    resto.length === 0
      ? 'do nothing'
      : `do update set ${resto.map((c) => `${ident(c)} = excluded.${ident(c)}`).join(', ')}`;
  const params = [];
  const filas = lote
    .map(
      (f) =>
        `(${cols
          .map((c) => {
            params.push(normalizar(f[c]));
            return `$${params.length}`;
          })
          .join(', ')})`
    )
    .join(', ');
  await pg.unsafe(
    `insert into ${ident(tabla)} (${cols.map(ident).join(', ')}) values ${filas} ` +
      `on conflict (${conflicto.map(ident).join(', ')}) ${accion}`,
    params
  );
  return lote.length;
}

async function insertarPg(tabla, lote) {
  if (lote.length === 0) return 0;
  const cols = [...new Set(lote.flatMap((f) => Object.keys(f)))];
  const params = [];
  const filas = lote
    .map(
      (f) =>
        `(${cols
          .map((c) => {
            params.push(normalizar(f[c]));
            return `$${params.length}`;
          })
          .join(', ')})`
    )
    .join(', ');
  await pg.unsafe(`insert into ${ident(tabla)} (${cols.map(ident).join(', ')}) values ${filas}`, params);
  return lote.length;
}

async function borrarPg(tabla, filtro) {
  if (!filtro || Object.keys(filtro).length === 0) {
    await pg.unsafe(`delete from ${ident(tabla)}`);
    return;
  }
  const params = [];
  const conds = Object.entries(filtro).map(([k, v]) => {
    params.push(normalizar(v));
    return `${ident(k)} = $${params.length}`;
  });
  await pg.unsafe(`delete from ${ident(tabla)} where ${conds.join(' and ')}`, params);
}

export async function upsert(tabla, filas, onConflict, chunk = 1000) {
  if (filas.length === 0) return 0;
  if (pgDisponible()) {
    let insertadas = 0;
    for (let i = 0; i < filas.length; i += chunk) {
      insertadas += await upsertPg(tabla, filas.slice(i, i + chunk), onConflict);
    }
    return insertadas;
  }
  if (!supabase) return 0;
  let insertadas = 0;
  for (let i = 0; i < filas.length; i += chunk) {
    const lote = filas.slice(i, i + chunk);
    const { error } = await supabase.from(tabla).upsert(lote, { onConflict });
    if (error) throw new Error(`${tabla}: ${error.message}`);
    insertadas += lote.length;
  }
  return insertadas;
}

export async function reemplazarTodo(tabla, filtro, filas, chunk = 1000) {
  if (pgDisponible()) {
    await borrarPg(tabla, filtro);
    let insertadas = 0;
    for (let i = 0; i < filas.length; i += chunk) {
      insertadas += await insertarPg(tabla, filas.slice(i, i + chunk));
    }
    return insertadas;
  }
  if (!supabase) return 0;
  if (filtro) {
    await supabase.from(tabla).delete().match(filtro);
  } else {
    await supabase.from(tabla).delete().neq('id', 0);
  }
  let insertadas = 0;
  for (let i = 0; i < filas.length; i += chunk) {
    const lote = filas.slice(i, i + chunk);
    const { error } = await supabase.from(tabla).insert(lote);
    if (error) throw new Error(`${tabla}: ${error.message}`);
    insertadas += lote.length;
  }
  return insertadas;
}

export async function limpiar(tabla, filtro) {
  if (pgDisponible()) {
    await borrarPg(tabla, filtro);
    return;
  }
  if (!supabase) return;
  await supabase.from(tabla).delete().match(filtro);
}

export async function logSync(entidad, detalle, filas, duracionMs, ok, error = null) {
  if (pgDisponible()) {
    try {
      await pg`insert into sync_log (entidad, detalle, filas, duracion_ms, ok, error) values (${entidad}, ${detalle}, ${filas}, ${duracionMs}, ${ok}, ${error})`;
    } catch {
      // el log no debe tumbar el sync
    }
    return;
  }
  if (!supabase) return;
  try {
    await supabase.from('sync_log').insert({
      entidad,
      detalle,
      filas,
      duracion_ms: duracionMs,
      ok,
      error,
    });
  } catch {
    // el log no debe tumbar el sync
  }
}
