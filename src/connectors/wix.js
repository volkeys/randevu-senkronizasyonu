// Wix Bookings bağlantısı (Calendar Events v3 + Schedules v3).
// Kaynaklar:
//   https://dev.wix.com/docs/api-reference/business-management/calendar/events-v3/query-events
//   https://dev.wix.com/docs/api-reference/business-management/calendar/events-v3/bulk-create-event
//   https://dev.wix.com/docs/api-reference/business-management/calendar/events-v3/bulk-cancel-event
//   https://dev.wix.com/docs/api-reference/business-management/calendar/schedules-v3/create-schedule
//   https://dev.wix.com/docs/api-reference/articles/rest-authentication/rest-api-authentication
import { slot, slotKey } from '../slots.js';
import { TZ, utcToLocal } from '../time.js';

const API = 'https://www.wixapis.com';
export const BOOKINGS_APP_ID = '13d21c63-b5ec-5912-8397-c3a5ddb27a97';
const BULK_MAX = 50;

export function createWix({ apiKey, siteId, staff, blockSchedules, readOnlySchedules = {}, withContactInfo = false, log = console.log, fetchImpl = fetch }) {
  const staffByResource = new Map(staff.map(s => [s.wixResourceId, s.key]));
  const resourceByStaff = new Map(staff.map(s => [s.key, s.wixResourceId]));
  const blockScheduleIds = new Set(Object.values(blockSchedules).filter(Boolean));
  const roScheduleIds = new Set(Object.values(readOnlySchedules).filter(Boolean));

  async function call(method, path, body) {
    const res = await fetchImpl(API + path, {
      method,
      headers: {
        Authorization: apiKey,
        'wix-site-id': siteId,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      const reqId = res.headers.get('x-wix-request-id') || '';
      throw new Error(`Wix ${method} ${path} -> ${res.status} ${text.slice(0, 400)} ${reqId}`);
    }
    return text ? JSON.parse(text) : {};
  }

  async function queryEvents(from, to, filter, fields) {
    const out = [];
    const extra = fields ? { fields } : {};
    let body = {
      fromLocalDate: utcToLocal(from),
      toLocalDate: utcToLocal(to),
      timeZone: TZ,
      ...extra,
      query: { filter, cursorPaging: { limit: 1000 } },
    };
    for (let page = 0; page < 50; page++) {
      const data = await call('POST', '/calendar/v3/events/query', body);
      out.push(...(data.events || []));
      const next = data.pagingMetadata?.cursors?.next;
      if (!data.pagingMetadata?.hasNext || !next) break;
      // Sonraki sayfalarda filtre değil sadece cursor gönderilir
      body = { timeZone: TZ, ...extra, query: { cursorPaging: { limit: 1000, cursor: next } } };
    }
    return out;
  }

  function eventSlots(e, withInfo = false) {
    const ids = (e.resources || []).map(r => staffByResource.get(r.id)).filter(Boolean);
    const staffKeys = ids.length ? ids : ((e.resources || []).length ? [] : ['*']);
    const p = e.participants?.list?.[0];
    const info = withInfo ? { title: e.title, name: p?.name, phone: p?.phone, email: p?.email, eventId: e.id } : undefined;
    return staffKeys.map(k => slot(k, e.start.utcDate, e.end.utcDate, info));
  }

  const isBlocking = e => e.status === 'CONFIRMED' && e.transparency === 'OPAQUE' && e.type !== 'WORKING_HOURS';

  return {
    name: 'wix',
    canRead: true,
    canWrite: true,

    // Wix'teki gerçek randevular. Sync'in kendi blokları ve salt-okunur blok takvimleri hariç.
    // withContactInfo: müşteri adı/telefon/e-posta da okunur (Link Journal'a randevu açmak için).
    // Anahtarın kişisel veri izni yoksa (403) bilgisiz okunur.
    async listBusy(from, to) {
      const filter = { appId: { $eq: BOOKINGS_APP_ID } };
      let evs, info = withContactInfo;
      try {
        evs = await queryEvents(from, to, filter, info ? ['PI_FIELDS'] : undefined);
      } catch (e) {
        if (!info || !/-> 403/.test(String(e.message))) throw e;
        log('UYARI   Wix anahtarında kişisel veri izni yok (Read Calendar - Including PI); müşteri bilgisi olmadan okunuyor');
        info = false;
        evs = await queryEvents(from, to, filter);
      }
      return evs
        .filter(isBlocking)
        .filter(e => !blockScheduleIds.has(e.scheduleId) && !roScheduleIds.has(e.scheduleId))
        .flatMap(e => eventSlots(e, info));
    },

    // Başka bir sistemin Wix'te zaten tutulan blok takvimi (ör. eski Linkjournal takvimi)
    async listScheduleBusy(scheduleId, from, to) {
      const evs = await queryEvents(from, to, { scheduleId: { $eq: scheduleId } });
      return evs.filter(isBlocking).flatMap(e => eventSlots(e));
    },

    async listBlocks(source, from, to) {
      const scheduleId = blockSchedules[source];
      if (!scheduleId) throw new Error(`Wix blok takvimi tanımlı değil: ${source}`);
      const evs = await queryEvents(from, to, { scheduleId: { $eq: scheduleId } });
      return evs
        .filter(e => e.status === 'CONFIRMED')
        .flatMap(e => eventSlots(e).map(s => ({ id: e.id, key: slotKey(s) })));
    },

    async createBlocks(source, slots) {
      const scheduleId = blockSchedules[source];
      const title = `Upptagen (${source})`;
      const events = slots
        .filter(s => resourceByStaff.has(s.staff))
        .map(s => ({
          event: {
            scheduleId,
            title,
            start: { localDate: utcToLocal(s.start) },
            end: { localDate: utcToLocal(s.end) },
            timeZone: TZ,
            transparency: 'OPAQUE',
            resources: [{ id: resourceByStaff.get(s.staff) }],
          },
        }));
      let ok = 0;
      const failed = [];
      for (let i = 0; i < events.length; i += BULK_MAX) {
        const data = await call('POST', '/calendar/v3/bulk/events/create', {
          events: events.slice(i, i + BULK_MAX),
          returnEntity: false,
          timeZone: TZ,
        });
        ok += data.bulkActionMetadata?.totalSuccesses || 0;
        for (const r of data.results || []) if (r.itemMetadata && !r.itemMetadata.success) failed.push(r.itemMetadata);
      }
      return { ok, failed };
    },

    async cancelBlocks(source, ids) {
      let ok = 0;
      const failed = [];
      for (let i = 0; i < ids.length; i += BULK_MAX) {
        const data = await call('POST', '/calendar/v3/bulk/events/cancel', {
          eventIds: ids.slice(i, i + BULK_MAX),
          returnEntity: false,
        });
        ok += data.bulkActionMetadata?.totalSuccesses || 0;
        for (const r of data.results || []) if (r.itemMetadata && !r.itemMetadata.success) failed.push(r.itemMetadata);
      }
      return { ok, failed };
    },

    async createBlockSchedule(name) {
      const data = await call('POST', '/calendar/v3/schedules', {
        schedule: { name, appId: BOOKINGS_APP_ID },
      });
      return data.schedule.id;
    },
  };
}
