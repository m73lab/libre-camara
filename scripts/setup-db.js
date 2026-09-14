import { readFile, readdir } from 'node:fs/promises';
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('[db:setup] Falta DATABASE_URL (cadena de conexión Postgres).');
  process.exit(1);
}

const sql = postgres(url, { max: 2, onnotice: () => {} });

try {
  const dir = new URL('../migrations/', import.meta.url);
  const archivos = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const archivo of archivos) {
    const contenido = await readFile(new URL(`../migrations/${archivo}`, import.meta.url), 'utf8');
    console.log(`[db:setup] Ejecutando migrations/${archivo}…`);
    await sql.unsafe(contenido);
  }
  console.log('[db:setup] ✓ Esquema aplicado');
  const rows = await sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`;
  console.log('[db:setup] Tablas:', rows.map((r) => r.table_name).join(', '));
} catch (err) {
  console.error('[db:setup] ✗ Error:', err.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
