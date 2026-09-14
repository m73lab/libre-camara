import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const dir = resolve(
  process.env.FOTOS_DIR || join(fileURLToPath(new URL('../../', import.meta.url)), 'data', 'fotos')
);
const jar = join(tmpdir(), 'camara-cookies.txt');

let cookieOk = false;
let cookiePromise = null;

let activas = 0;
const esperas = [];

function conLimite(tarea) {
  return new Promise((resolve) => {
    const ejecutar = () => {
      activas += 1;
      tarea().then(
        (v) => {
          activas -= 1;
          const siguiente = esperas.shift();
          if (siguiente) siguiente();
          resolve(v);
        },
        () => {
          activas -= 1;
          const siguiente = esperas.shift();
          if (siguiente) siguiente();
          resolve(null);
        }
      );
    };
    if (activas < 6) ejecutar();
    else esperas.push(ejecutar);
  });
}

function esJpeg(buf) {
  return buf && buf.length > 1024 && buf[0] === 0xff && buf[1] === 0xd8;
}

function ejecutar(curl, args, timeout = 20000) {
  return new Promise((resolve) => {
    execFile(
      curl,
      args,
      { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024, timeout, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null);
        resolve(stdout);
      }
    );
  });
}

function curlCookie() {
  if (cookiePromise) return cookiePromise;
  cookiePromise = (async () => {
    for (const curl of ['curl.exe', 'curl']) {
      const out = await ejecutar(curl, ['-s', '-c', jar, '-o', 'NUL', '-A', UA, 'https://www.camara.cl/index.aspx']);
      if (out !== null) return true;
    }
    return false;
  })().finally(() => {
    cookiePromise = null;
  });
  return cookiePromise;
}

async function curlImagen(id) {
  if (!cookieOk) {
    cookieOk = await curlCookie();
  }
  return conLimite(async () => {
    for (const curl of ['curl.exe', 'curl']) {
      const out = await ejecutar(curl, [
        '-s',
        '-b',
        jar,
        '-A',
        UA,
        '-e',
        'https://www.camara.cl/',
        `https://www.camara.cl/img.aspx?prmID=GRCL${id}`,
      ]);
      if (esJpeg(out)) {
        return { buf: out, tipo: 'image/jpeg' };
      }
    }
    return null;
  });
}

async function waybackImagen(id) {
  try {
    const controlador = new AbortController();
    const timer = setTimeout(() => controlador.abort(), 20000);
    const res = await fetch(
      `https://web.archive.org/web/2024im_/https://www.camara.cl/img.aspx?prmID=GRCL${id}`,
      { signal: controlador.signal, headers: { 'User-Agent': UA } }
    );
    clearTimeout(timer);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!esJpeg(buf)) return null;
    return { buf, tipo: res.headers.get('content-type') || 'image/jpeg' };
  } catch {
    return null;
  }
}

async function descargar(id) {
  let foto = await curlImagen(id);
  if (!foto) {
    if (cookieOk) {
      cookieOk = false;
      cookieOk = await curlCookie();
      foto = await curlImagen(id);
    }
    if (!foto) foto = await waybackImagen(id);
  }
  return foto;
}

export function rutaFoto(id) {
  return join(dir, `${id}.jpg`);
}

export async function obtenerFotoDiputado(id) {
  try {
    const buf = await readFile(rutaFoto(id));
    if (esJpeg(buf)) return { buf, tipo: 'image/jpeg' };
  } catch {
    // no está o está corrupto: descargar
  }
  const foto = await descargar(id);
  if (!foto) return null;
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(rutaFoto(id), foto.buf);
  } catch {
    // si no se pudo guardar, igual se sirve
  }
  return foto;
}

export async function descargarFotos(ids, onProgress) {
  await mkdir(dir, { recursive: true });
  let ok = 0;
  for (const id of ids) {
    if (!id) continue;
    try {
      const buf = await readFile(rutaFoto(id));
      if (esJpeg(buf)) {
        ok += 1;
        continue;
      }
    } catch {
      // no está: descargar
    }
    const foto = await descargar(id);
    if (foto) {
      await writeFile(rutaFoto(id), foto.buf).catch(() => {});
      ok += 1;
    }
    if (onProgress) onProgress(ok, id);
  }
  return ok;
}
