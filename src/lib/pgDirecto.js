import postgres from 'postgres';

let cliente = null;
if (process.env.DATABASE_URL) {
  try {
    cliente = postgres(process.env.DATABASE_URL, { max: 5, idle_timeout: 30, onnotice: () => {} });
  } catch {
    cliente = null;
  }
}

export const pg = cliente;
export const pgDisponible = () => cliente !== null;
