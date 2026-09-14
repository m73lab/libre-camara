import { fetchCachedData } from './fetchCached.js';

let ultimoEnviado = null;

function formatoClp(valor) {
  return new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 }).format(valor);
}

export async function resumenDeHoy() {
  const anno = String(new Date().getFullYear());
  const hoy = new Date();
  const claveDia = hoy.toISOString().slice(0, 10);

  const { data: votaciones } = await fetchCachedData(
    'WSLegislativo',
    'retornarVotacionesXAnno',
    { prmAnno: Number(anno) },
    'collection',
    300
  );

  const fechaStr = (fecha) =>
    fecha instanceof Date ? fecha.toISOString() : String(fecha || '');

  const deHoy = votaciones.filter((v) => fechaStr(v.fecha).slice(0, 10) === claveDia);
  if (deHoy.length === 0) return null;

  const lineas = [`📋 Resumen legislativo del ${hoy.toLocaleDateString('es-CL')}`, ''];
  for (const v of deHoy.slice(0, 12)) {
    const resultado = v.resultado?.texto || '';
    const aprobada = resultado.startsWith('Aprob');
    const rechazada = resultado.startsWith('Rechaz');
    const emoji = aprobada ? '✅' : rechazada ? '❌' : '⚪';
    const estrecho = rechazada ? ' ⚠️' : '';
    lineas.push(
      `${emoji} ${v.descripcion}${estrecho}\n   ${fechaStr(v.fecha).slice(11, 16)} · ${v.quorum?.texto || ''} · ${v.totalSi} sí / ${v.totalNo} no`
    );
  }
  lineas.push('', '#CámaraALaLupa #DatosAbiertos');
  return { claveDia, texto: lineas.join('\n'), n: deHoy.length };
}

export async function enviarTelegram(texto) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.log('[bot] Telegram no configurado. Resumen:\n' + texto);
    return false;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: texto }),
    });
    if (!res.ok) {
      console.error('[bot] Telegram respondió ' + res.status);
      return false;
    }
    console.log('[bot] Resumen enviado a Telegram');
    return true;
  } catch (err) {
    console.error('[bot] Error al enviar: ' + err.message);
    return false;
  }
}

export function iniciarBot() {
  const intervaloMin = Number(process.env.BOT_INTERVAL_MIN || 15);
  console.log(`[bot] Vigilante activo: revisa cada ${intervaloMin} min (Telegram ${process.env.TELEGRAM_BOT_TOKEN ? 'configurado' : 'sin configurar'})`);
  setInterval(async () => {
    try {
      const resumen = await resumenDeHoy();
      if (!resumen) return;
      if (ultimoEnviado === resumen.claveDia) return;
      ultimoEnviado = resumen.claveDia;
      await enviarTelegram(resumen.texto);
    } catch (err) {
      console.error('[bot] Error en vigilante: ' + err.message);
    }
  }, intervaloMin * 60 * 1000);
}
