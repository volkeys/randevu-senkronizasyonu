// Teşhis (salt okunur, herkese açık log): Wix'ten açılan Link Journal randevuları Boka Direkt'e geçiyor mu?
// Kişisel veri yazılmaz: sadece sayılar, kimlik bayrakları ve kısa etiketler.
const base = (process.env.LINKJOURNAL_API_URL || '').replace(/\/$/, '');
const key = process.env.LINKJOURNAL_API_KEY;
if (!base || !key) { console.log('TESHIS: LJ secret yok'); process.exit(0); }
const H = { Authorization: `Bearer ${key}`, Accept: 'application/json' };
const get = async p => (await fetch(`${base}/${p}`, { headers: H })).json();

const from = '2026-11-06';
const to = '2026-12-31';
const all = [];
for (let page = 1; page < 60; page++) {
  const j = await get(`schedule/appointments?starts_at_from=${from}&starts_at_to=${to}&per_page=100&page=${page}`);
  all.push(...(j.data ?? []).map(x => x.appointment));
  if (page >= Math.ceil((j.meta?.total ?? 0) / 100)) break;
}
const live = all.filter(a => a.status !== 'cancelled');
const wix = live.filter(a => (a.description ?? '').startsWith('[wix]'));
const other = live.filter(a => !(a.description ?? '').startsWith('[wix]'));
console.log('TOPLAM', all.length, 'iptal olmayan', live.length, 'wix-işaretli', wix.length);
const sig = a => ({
  durum: a.status,
  aktivite: a.activity_name ?? '(boş)',
  personel: (a.user_ids ?? []).join('+'),
  musteri293: a.customer_id === 293,
  besokNedeni: (a.visit_reason_ids ?? []).length,
  hayvan: (a.animal_ids ?? []).length,
  olusturma: (a.created_at ?? '').slice(0, 10),
  aciklamaBasi: (a.description ?? '').slice(0, 6),
  sureDk: Math.round((Date.parse(a.ends_at) - Date.parse(a.starts_at)) / 6e4),
});
console.log('WIX-ISARETLI ORNEKLER', JSON.stringify(wix.slice(0, 12).map(sig)));
console.log('DIGER AKTIVITE SAYILARI', JSON.stringify(other.reduce((m, a) => ((m[a.activity_name ?? '(boş)'] = (m[a.activity_name ?? '(boş)'] ?? 0) + 1), m), {})));
console.log('DIGER ORNEKLER', JSON.stringify(other.slice(0, 8).map(sig)));
console.log('WIX-ISARETLI olusturma tarihleri', JSON.stringify(wix.reduce((m, a) => ((m[(a.created_at || '').slice(0, 10)] = (m[(a.created_at || '').slice(0, 10)] ?? 0) + 1), m), {})));
