import { execFile } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { LOGOS_PARTIDOS } from '../data/logosPartidos.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const dir = resolve(
  process.env.LOGOS_DIR || join(fileURLToPath(new URL('../../', import.meta.url)), 'data', 'partidos')
);

function esImagen(buf) {
  return (
    buf &&
    buf.length > 1024 &&
    ((buf[0] === 0xff && buf[1] === 0xd8) || (buf[0] === 0x89 && buf[1] === 0x50))
  );
}

function ejecutar(curl, args, timeout = 25000) {
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

function rutaLogo(alias) {
  return join(dir, `${alias.toUpperCase()}.jpg`);
}

async function descargar(alias) {
  const urlInterna = LOGOS_PARTIDOS[alias.toUpperCase()];
  if (!urlInterna) return null;
  const url = `https://www.bcn.cl/historiapolitica/getimagenbiografia?url=${encodeURIComponent(urlInterna)}`;
  for (const curl of ['curl.exe', 'curl']) {
    const out = await ejecutar(curl, ['-s', '-L', '-A', UA, url]);
    if (esImagen(out)) return out;
  }
  return null;
}

export async function obtenerLogoPartido(alias) {
  if (!alias) return null;
  try {
    const buf = await readFile(rutaLogo(alias));
    if (esImagen(buf)) return buf;
  } catch {
    // descargar
  }
  const buf = await descargar(alias);
  if (!buf) return null;
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(rutaLogo(alias), buf);
  } catch {
    // igual se sirve
  }
  return buf;
}

export async function descargarTodosLosLogos() {
  await mkdir(dir, { recursive: true });
  let ok = 0;
  for (const alias of Object.keys(LOGOS_PARTIDOS)) {
    const buf = await obtenerLogoPartido(alias);
    if (buf) ok += 1;
  }
  console.log(`[logos] ${ok}/${Object.keys(LOGOS_PARTIDOS).length} logos de partidos en disco`);
  return ok;
}
