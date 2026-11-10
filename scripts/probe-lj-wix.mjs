// Teşhis (salt okunur, herkese açık log): Link Journal randevusunun hangi kaynaktan açıldığı ayırt edilebilir mi?
// Sadece alan adları ve kaynak/tip gibi kısa değerler yazılır; müşteri, hayvan ve açıklama metni yazılmaz.
const base = (process.env.LINKJOURNAL_API_URL || '').replace(/\/$/, '');
const key = process.env.LINKJOURNAL_API_KEY;
if (!base || !key) { console.log('TESHIS: LJ secret yok'); process.exit(0); }
const H = { Authorization: `Bearer ${key}`, Accept: 'application/json' };
const get = async p => (await fetch(`${base}/${p}`, { headers: H })).json();

const from = '2026-11-01';
const to = '2026-12-31';
const all = [];
for (let page = 1; page < 60; page++) {
  const j = await get(`schedule/appointments?starts_at_from=${from}&starts_at_to=${to}&per_page=100&page=${page}`);
  all.push(...(j.data ?? []).map(x => x.appointment));
  if (page >= Math.ceil((j.meta?.total ?? 0) / 100)) break;
}
const isWix = a => (a.description ?? '').startsWith('[wix]');
const live = all.filter(a => a.status !== 'cancelled');
console.log('ALANLAR', JSON.stringify(Object.keys(all[0] ?? {})));
const meta = a => Object.fromEntries(Object.entries(a).filter(([k, v]) => /source|via|origin|creat|channel|book|web|kaynak|by|sync|external|ext/i.test(k) && (typeof v !== 'object' || v === null)).map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 24) : v]));
console.log('WIX ORNEK META', JSON.stringify(live.filter(isWix).slice(0, 4).map(meta)));
console.log('UI ORNEK META', JSON.stringify(live.filter(a => !isWix(a) && a.activity_name === 'Lyckselevet').slice(0, 4).map(meta)));
// Kısa tipler: wix mi, aktivite, durum, açıklama boş mu, besök nedeni sayısı, hayvan sayısı, personel sayısı
const shape = a => [isWix(a) ? 'wix' : 'ui', a.activity_name ?? '-', a.status, (a.description ?? '') === '' ? 'bos' : 'dolu', (a.visit_reason_ids ?? []).length, (a.animal_ids ?? []).length, (a.user_ids ?? []).length].join('|');
const g = {};
for (const a of live) g[shape(a)] = (g[shape(a)] ?? 0) + 1;
console.log('TIP SAYILARI (kaynak|aktivite|durum|aciklama|besokNedeni|hayvan|personel)', JSON.stringify(g));
