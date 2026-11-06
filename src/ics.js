// Basit iCal (RFC 5545) okuyucu: yalnızca dolu zaman aralıklarını çıkarır.
// Tekrarlayan kurallar (RRULE) açılmaz; rezervasyon sistemlerinin dışa aktardığı
// takvimlerde her randevu ayrı VEVENT olarak gelir.
import { localToUtc, TZ } from './time.js';

function unfold(text) {
  return text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
}

function parseDate(value, params) {
  // 20261103T080000Z | 20261103T080000 (+TZID) | 20261103 (tüm gün)
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h = '00', mi = '00', s = '00', z] = m;
  const local = `${y}-${mo}-${d}T${h}:${mi}:${s}`;
  if (z) return new Date(local + 'Z').toISOString();
  return localToUtc(local, params.TZID || TZ);
}

export function parseIcsBusy(text) {
  const out = [];
  let cur = null;
  for (const line of unfold(text)) {
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') {
      if (cur && cur.start && cur.end && cur.status !== 'CANCELLED' && cur.transp !== 'TRANSPARENT') {
        out.push({ start: cur.start, end: cur.end });
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const [name, ...rawParams] = line.slice(0, i).split(';');
    const params = Object.fromEntries(rawParams.map(p => p.split('=')));
    const value = line.slice(i + 1).trim();
    if (name === 'DTSTART') cur.start = parseDate(value, params);
    else if (name === 'DTEND') cur.end = parseDate(value, params);
    else if (name === 'STATUS') cur.status = value.toUpperCase();
    else if (name === 'TRANSP') cur.transp = value.toUpperCase();
  }
  return out;
}
