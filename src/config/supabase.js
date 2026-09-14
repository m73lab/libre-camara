import { createClient } from '@supabase/supabase-js';

export const supabase = crearClienteSupabase();

function crearClienteSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.log('[supabase] No configurado: se usa el modo upstream+caché');
    return null;
  }
  try {
    const cliente = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      db: { schema: 'public' },
    });
    console.log('[supabase] Cliente inicializado');
    return cliente;
  } catch (err) {
    console.error('[supabase] Error al inicializar:', err.message);
    return null;
  }
}
