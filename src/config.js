export const config = {
  port: Number(process.env.PORT || 3000),
  upstreamBase: process.env.UPSTREAM_BASE || 'https://opendata.camara.cl/camaradiputados/WServices',
  timeoutMs: Number(process.env.UPSTREAM_TIMEOUT_MS || 30000),
  defaultTtl: Number(process.env.CACHE_TTL_SECONDS || 300),
};
