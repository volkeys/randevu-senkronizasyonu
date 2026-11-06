// Link Journal bağlantısı (API v2, Authorization: Bearer <anahtar>).
// Link Journal'da webhook yok, bu yüzden her saat başı API'den okunur (polling):
// her çalışmada önümüzdeki N gün baştan okunur ve fark hesaplanır.
//
// Okuma: GET /schedule/appointments?starts_at_from=&starts_at_to= (sayfalı).
//   İptal edilen randevular (status "cancelled") ve sync'in kendi açtığı randevular dolu sayılmaz.
// Yazma (writeEnabled): Wix randevuları Link Journal'da gerçek randevu olarak açılır.
//   POST /schedule/appointments — personel (user_ids, filter_user_id) ve besök nedeni (visit_reason_ids)
//   "appointment" nesnesinin DIŞINDA, kök seviyede gönderilmeli; içeride yok sayılıyor (2026-11-04).
//   İptal: POST /schedule/appointments/{id}/cancel (DELETE yok, PATCH status değiştirmiyor).
//   Müşteri: isimle eşleşir (birden çok varsa telefon/e-posta ile seçilir); isim bulunamazsa tek bir
//   telefon/e-posta eşleşmesi; yoksa yedek müşteri (#293 Volkan Bilmez).
//   Açıklama "[<kaynak>] " ile başlar; sync kendi randevularını bu işaretle tanır.
// "staff" değeri config/staff.json'daki "key"dir; Link Journal kullanıcı ID'si "linkjournal" alanından eşlenir.
import { slot, slotKey } from '../slots.js';
import { toOffsetIso } from '../time.js';

const norm = s => String(s ?? '').toLowerCase().normalize('NFC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const tokens = s => norm(s).split(' ').filter(Boolean).sort().join(' ');
const digits = p => {
  let d = String(p ?? '').replace(/\D/g, '');
  if (d.startsWith('0046')) d = '0' + d.slice(4);
  else if (d.startsWith('46') && d.length >= 11) d = '0' + d.slice(2);
  return d;
};

// customers: Link Journal müşteri nesneleri. Dönen: { id, how } — how: isim | isim+telefon/e-posta | telefon/e-posta | yedek
export function matchCustomer(customers, { name, phone, email } = {}, fallbackId) {
  const live = customers.filter(c => !c.removed);
  const tel = digits(phone);
  const mail = norm(email);
  const contactHit = c =>
    (tel.length >= 7 && (c.phone_numbers ?? []).some(p => digits(p.number) === tel)) ||
    (mail && (c.emails ?? []).some(e => norm(e.address) === mail));
  const want = tokens(name);
  if (want) {
    const byName = live.filter(c => tokens(c.name) === want || tokens(`${c.first_name} ${c.last_name}`) === want);
    if (byName.length === 1) return { id: byName[0].id, how: 'isim' };
    const both = byName.filter(contactHit);
    if (both.length === 1) return { id: both[0].id, how: 'isim+telefon/e-posta' };
  }
  const byContact = live.filter(contactHit);
  if (byContact.length === 1) return { id: byContact[0].id, how: 'telefon/e-posta' };
  return { id: fallbackId, how: 'yedek' };
}

export function createLinkjournal({
  apiUrl, apiKey, staff = [], ignoreActivities = [],
  writeEnabled = false, acceptSources = ['wix'],
  fallbackCustomerId = 293, locationId = 1, activityId = 11, visitReasonId = 1,
  log = console.log, fetchImpl = fetch,
}) {
  if (!apiUrl || !apiKey) return null;
  const base = apiUrl.replace(/\/$/, '');
  const staffByLjId = new Map(staff.filter(s => s.linkjournal != null).map(s => [String(s.linkjournal), s.key]));
  const ljIdByStaff = new Map(staff.filter(s => s.linkjournal != null).map(s => [s.key, s.linkjournal]));
  const ignored = new Set(ignoreActivities.map(a => a.trim().toLowerCase()).filter(Boolean));
  const marker = src => `[${src}]`;
  const isOwn = a => /^\[[a-z]+\]/.test(a.description ?? '');

  async function api(method, path, body) {
    const r = await fetchImpl(`${base}/${path}`, {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`Link Journal ${method} ${path.split('?')[0]} → ${r.status}: ${text.slice(0, 120)}`);
    return text ? JSON.parse(text) : {};
  }
  const get = path => api('GET', path);

  async function listAppointments(from, to) {
    // starts_at_to tarih olarak verilir; bitiş gününü de kapsamak için bir gün ileri alınır
    const fromDate = from.slice(0, 10);
    const toDate = new Date(Date.parse(to) + 864e5).toISOString().slice(0, 10);
    const out = [];
    for (let page = 1; ; page++) {
      const j = await get(`schedule/appointments?starts_at_from=${fromDate}&starts_at_to=${toDate}&per_page=100&page=${page}`);
      out.push(...(j.data ?? []).map(x => x.appointment));
      if (page >= Math.ceil((j.meta?.total ?? 0) / (j.meta?.per_page ?? 100)) || !(j.data ?? []).length) break;
      if (page > 200) throw new Error('Link Journal: beklenmedik sayıda sayfa');
    }
    return out.filter(a => Date.parse(a.ends_at) > Date.parse(from) && Date.parse(a.starts_at) < Date.parse(to));
  }

  let customerCache = null;
  async function customers() {
    if (customerCache) return customerCache;
    const out = [];
    for (let page = 1; page <= 200; page++) {
      const j = await get(`customers?per_page=100&page=${page}`);
      out.push(...(j.data ?? []).map(x => Object.values(x)[0]));
      if (page >= Math.ceil((j.meta?.total ?? 0) / (j.meta?.per_page ?? 100)) || !(j.data ?? []).length) break;
    }
    return (customerCache = out);
  }

  function description(source, info = {}) {
    const who = [info.name, info.phone, info.email].filter(Boolean).join(', ');
    return [marker(source), info.title, who && `– ${who}`].filter(Boolean).join(' ');
  }

  return {
    name: 'linkjournal',
    canRead: true,
    canWrite: writeEnabled,
    acceptSources,
    skipIfBusy: true,

    async listBusy(from, to) {
      const busy = [];
      for (const a of await listAppointments(from, to)) {
        if (a.status === 'cancelled' || isOwn(a)) continue;
        if (a.activity_name && ignored.has(a.activity_name.toLowerCase())) continue;
        if (!a.starts_at || !a.ends_at) continue;
        for (const uid of a.user_ids ?? []) {
          const key = staffByLjId.get(String(uid));
          if (key) busy.push(slot(key, a.starts_at, a.ends_at));
        }
      }
      return busy;
    },

    async listBlocks(source, from, to) {
      return (await listAppointments(from, to))
        .filter(a => a.status !== 'cancelled' && (a.description ?? '').startsWith(marker(source)))
        .flatMap(a => (a.user_ids ?? []).map(uid => staffByLjId.get(String(uid))).filter(Boolean)
          .map(k => ({ id: a.id, key: slotKey(slot(k, a.starts_at, a.ends_at)) })));
    },

    // Dry run'da: kaç randevu hangi yolla müşteriye bağlanacak (kişisel veri yazılmaz)
    async preview(source, slots) {
      const cs = await customers();
      const n = {};
      for (const s of slots) { const { how } = matchCustomer(cs, s.info, fallbackCustomerId); n[how] = (n[how] ?? 0) + 1; }
      return `${slots.length} randevu açılacak; müşteri eşleşmesi ${JSON.stringify(n)}`;
    },

    async createBlocks(source, slots) {
      const cs = await customers();
      let ok = 0;
      const failed = [];
      for (const s of slots) {
        const userId = ljIdByStaff.get(s.staff);
        if (!userId) { failed.push({ staff: s.staff, error: 'Link Journal kullanıcısı yok' }); continue; }
        const { id: customerId, how } = matchCustomer(cs, s.info, fallbackCustomerId);
        try {
          await api('POST', 'schedule/appointments', {
            appointment: {
              starts_at: toOffsetIso(s.start),
              ends_at: toOffsetIso(s.end),
              location_id: locationId,
              customer_id: customerId,
              activity_id: activityId,
              description: description(source, s.info),
            },
            user_ids: [userId],
            filter_user_id: userId,
            visit_reason_ids: [visitReasonId],
          });
          ok++;
          log(`açıldı  linkjournal <- ${source}: ${s.staff} (müşteri: ${how})`);
        } catch (e) {
          // Depo herkese açık: kayıtlara randevu saati ya da yanıt içeriği yazılmaz
          failed.push({ staff: s.staff, error: (String(e.message).match(/→ \d{3}/) || ['hata'])[0] });
        }
      }
      return { ok, failed };
    },

    async cancelBlocks(source, ids) {
      let ok = 0;
      const failed = [];
      for (const id of new Set(ids)) {
        try { await api('POST', `schedule/appointments/${id}/cancel`, {}); ok++; } catch (e) { failed.push({ id, error: (String(e.message).match(/→ \d{3}/) || ['hata'])[0] }); }
      }
      return { ok, failed };
    },
  };
}
