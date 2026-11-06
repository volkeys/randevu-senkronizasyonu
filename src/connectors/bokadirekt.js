// Boka Direkt bağlantısı.
// Boka Direkt'in herkese açık bir API dokümanı yok (2026-11-03). İki yol destekleniyor:
//   1) iCal linkleri: sadece okuma. Her personelin kendi linki var (Inställningar → Användare →
//      Platsuppgifter → ICal synkronisering; link aynı pencerede düğmenin altında görünür).
//      Boka Direkt'teki randevular Wix'e ve Link Journal'a blok olarak yazılır, ama Boka Direkt'e
//      geri yazılamaz. Linkler BOKADIREKT_ICS_<PERSONEL> (ör. BOKADIREKT_ICS_VOLKAN) olarak verilir;
//      eski tek link biçimi (BOKADIREKT_ICS_URL + BOKADIREKT_ICS_STAFF) de çalışır.
//   2) API (BOKADIREKT_API_URL + BOKADIREKT_API_KEY): Boka Direkt erişim verince
//      listBusy/listBlocks/createBlocks/cancelBlocks onların dokümanına göre doldurulacak.
import { parseIcsBusy } from '../ics.js';
import { slot } from '../slots.js';

// icsFeeds: [{ staff, url }] — staff "*" ise tüm klinik
export function createBokadirekt({ icsFeeds = [], apiUrl, apiKey, fetchImpl = fetch }) {
  if (apiUrl && apiKey) {
    const todo = () => { throw new Error('Boka Direkt API henüz bağlanmadı: dokümanları gelince src/connectors/bokadirekt.js doldurulacak'); };
    return { name: 'bokadirekt', canRead: true, canWrite: true, listBusy: todo, listBlocks: todo, createBlocks: todo, cancelBlocks: todo };
  }
  const feeds = icsFeeds.filter(f => f.url);
  if (!feeds.length) return null;
  return {
    name: 'bokadirekt',
    canRead: true,
    canWrite: false,
    async listBusy(from, to) {
      const f = Date.parse(from), t = Date.parse(to);
      const all = [];
      // Bir link okunamazsa tüm kaynak hata verir: yarım veriyle blok iptal edilmesin
      for (const feed of feeds) {
        const res = await fetchImpl(feed.url);
        if (!res.ok) throw new Error(`Boka Direkt iCal (${feed.staff}) -> ${res.status}`);
        all.push(...parseIcsBusy(await res.text())
          .filter(e => Date.parse(e.end) > f && Date.parse(e.start) < t)
          .map(e => slot(feed.staff, e.start, e.end)));
      }
      return all;
    },
  };
}
