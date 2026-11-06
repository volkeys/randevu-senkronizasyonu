// Bağımlılıksız saat dilimi yardımcıları. Wix, iCal ve diğer sistemler yerel saat
// (Europe/Stockholm) ya da UTC kullanır; içeride her zaman UTC-ISO tutulur.

export const TZ = 'Europe/Stockholm';

function parts(date, timeZone) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const o = {};
  for (const p of f.formatToParts(date)) o[p.type] = p.value;
  return o;
}

// UTC-ISO -> verilen saat diliminde "YYYY-MM-DDTHH:mm:ss"
export function utcToLocal(iso, timeZone = TZ) {
  const p = parts(new Date(iso), timeZone);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

// Verilen saat diliminde "YYYY-MM-DDTHH:mm:ss" -> UTC-ISO
export function localToUtc(local, timeZone = TZ) {
  const asUtc = Date.parse(local + 'Z');
  // Yaz saati geçişlerinde bile iki tur yeterli
  let guess = asUtc;
  for (let i = 0; i < 2; i++) {
    const p = parts(new Date(guess), timeZone);
    const shown = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
    guess += asUtc - shown;
  }
  return new Date(guess).toISOString();
}

export function normIso(iso) {
  const d = new Date(iso);
  d.setUTCSeconds(0, 0); // Wix saniyeleri yok sayar
  return d.toISOString();
}

// UTC-ISO -> yerel saat + ofset, ör. "2026-11-04T09:00:00+01:00" (Link Journal bu biçimi bekler)
export function toOffsetIso(iso, timeZone = TZ) {
  const local = utcToLocal(iso, timeZone);
  const min = Math.round((Date.parse(local + 'Z') - Date.parse(new Date(iso).toISOString())) / 6e4);
  const sign = min < 0 ? '-' : '+';
  const a = Math.abs(min);
  return `${local}${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}
