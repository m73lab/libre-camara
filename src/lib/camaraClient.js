import { config } from '../config.js';

export class UpstreamError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

export class BadRequestUpstreamError extends UpstreamError {
  constructor(message) {
    super(message, 400);
  }
}

const utf8Strict = new TextDecoder('utf-8', { fatal: true });
const latinDecoder = new TextDecoder('windows-1252');

function decodeXmlBytes(buf) {
  try {
    return utf8Strict.decode(buf);
  } catch {
    return latinDecoder.decode(buf);
  }
}

export async function callUpstream(service, method, params = {}) {
  const url = new URL(`${config.upstreamBase}/${service}.asmx/${method}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }

  const espera = (ms) => new Promise((r) => setTimeout(r, ms));
  let ultimoError = null;

  for (let intento = 0; intento < 3; intento += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    const started = Date.now();

    let res;
    try {
      res = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'text/xml' },
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new UpstreamError(`Tiempo de espera agotado (${config.timeoutMs}ms)`, 504);
      }
      ultimoError = new UpstreamError(`Error de red: ${err.message}`, 502);
      await espera(600 * (intento + 1));
      continue;
    } finally {
      clearTimeout(timer);
    }

    const upstreamMs = Date.now() - started;

    if (!res.ok) {
      const body = await res.text();
      if (/Falta el par[áa]metro/i.test(body)) {
        throw new BadRequestUpstreamError('Faltan parámetros requeridos para el método upstream');
      }
      ultimoError = new UpstreamError(`El servicio upstream respondió ${res.status}`, 502);
      await espera(800 * (intento + 1));
      continue;
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 500) {
      ultimoError = new UpstreamError('Respuesta vacía del upstream (rate-limit)', 502);
      await espera(1200 * (intento + 1));
      continue;
    }
    return { xml: decodeXmlBytes(buf), upstreamMs };
  }

  throw ultimoError || new UpstreamError('El upstream no respondió correctamente', 502);
}
