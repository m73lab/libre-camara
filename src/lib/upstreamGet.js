import { config } from '../config.js';
import { UpstreamError } from './camaraClient.js';

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

function decodificar(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

// GET-XML genérico para fuentes fuera de WServices (sistema antiguo de la
// Cámara, Senado). A diferencia de callUpstream, una respuesta vacía o nil
// devuelve null en vez de lanzar: significa "sin datos", no error.
export async function fetchXml(urlBase, params = {}, { timeoutMs = null, intentos = 3, minBytes = 500 } = {}) {
  const url = new URL(urlBase);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }
  const limite = timeoutMs ?? config.timeoutMs;
  let ultimoError = null;

  for (let intento = 0; intento < intentos; intento += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limite);

    let res;
    try {
      res = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'text/xml' },
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new UpstreamError(`Tiempo de espera agotado (${limite}ms)`, 504);
      }
      ultimoError = new UpstreamError(`Error de red: ${err.message}`, 502);
      await espera(600 * (intento + 1));
      continue;
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      ultimoError = new UpstreamError(`El servicio upstream respondió ${res.status}`, 502);
      await espera(800 * (intento + 1));
      continue;
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < minBytes) return null;
    return { xml: decodificar(buf) };
  }

  throw ultimoError || new UpstreamError('El upstream no respondió correctamente', 502);
}
