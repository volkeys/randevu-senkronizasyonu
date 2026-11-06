import test from 'node:test';
import assert from 'node:assert/strict';
import { diffBlocks, slot, slotKey, expandAllStaff } from '../src/slots.js';
import { localToUtc, utcToLocal } from '../src/time.js';
import { parseIcsBusy } from '../src/ics.js';
import { runSync } from '../src/sync.js';
import { createWix } from '../src/connectors/wix.js';

test('Stockholm saati UTC\'ye ve geri, yaz/kış saati dahil', () => {
  assert.equal(localToUtc('2026-11-03T08:00:00'), '2026-11-03T07:00:00.000Z');
  assert.equal(localToUtc('2026-07-01T08:00:00'), '2026-07-01T06:00:00.000Z');
  assert.equal(localToUtc('2027-03-28T03:30:00'), '2027-03-28T01:30:00.000Z');
  assert.equal(utcToLocal('2026-11-03T07:00:00.000Z'), '2026-11-03T08:00:00');
});

test('diff: eksikler oluşturulur, geçersizler ve çiftler iptal edilir', () => {
  const a = slot('volkan', '2026-11-04T07:00:00Z', '2026-11-04T08:00:00Z');
  const b = slot('davut', '2026-11-04T09:00:00Z', '2026-11-04T09:30:00Z');
  const old = slot('volkan', '2026-11-05T07:00:00Z', '2026-11-05T08:00:00Z');
  const { toCreate, toCancel } = diffBlocks([a, b], [
    { id: 'e1', key: slotKey(a) },
    { id: 'e2', key: slotKey(a) },
    { id: 'e3', key: slotKey(old) },
  ]);
  assert.deepEqual(toCreate, [b]);
  assert.deepEqual(toCancel.sort(), ['e2', 'e3']);
});

test('"*" herkese açılır', () => {
  const s = slot('*', '2026-11-04T07:00:00Z', '2026-11-04T08:00:00Z');
  assert.deepEqual(expandAllStaff([s], ['volkan', 'davut']).map(x => x.staff), ['volkan', 'davut']);
});

test('iCal: TZID, Z, iptal ve TRANSPARENT', () => {
  const ics = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT', 'DTSTART;TZID=Europe/Stockholm:20261104T090000', 'DTEND;TZID=Europe/Stockholm:20261104T093000', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART:20261104T120000Z', 'DTEND:20261104T130000Z', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART:20261104T140000Z', 'DTEND:20261104T150000Z', 'STATUS:CANCELLED', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART:20261104T160000Z', 'DTEND:20261104T170000Z', 'TRANSP:TRANSPARENT', 'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  assert.deepEqual(parseIcsBusy(ics), [
    { start: '2026-11-04T08:00:00.000Z', end: '2026-11-04T08:30:00.000Z' },
    { start: '2026-11-04T12:00:00.000Z', end: '2026-11-04T13:00:00.000Z' },
  ]);
});

test('runSync: kaynak okunamazsa onun bloklarına dokunulmaz; güvenlik sınırı çalışır', async () => {
  const calls = [];
  const target = {
    name: 'wix',
    listBlocks: async src => [{ id: `${src}-old`, key: 'x' }],
    createBlocks: async (src, s) => { calls.push(['create', src, s.length]); return { ok: s.length, failed: [] }; },
    cancelBlocks: async (src, ids) => { calls.push(['cancel', src, ids.length]); return { ok: ids.length, failed: [] }; },
  };
  const good = { name: 'bokadirekt', listBusy: async () => [slot('volkan', '2026-11-04T07:00:00Z', '2026-11-04T08:00:00Z')] };
  const bad = { name: 'linkjournal', listBusy: async () => { throw new Error('down'); } };
  const r = await runSync({ sources: [good, bad], targets: [target], staffKeys: ['volkan'], from: '', to: '', dryRun: false, log: () => {} });
  assert.deepEqual(calls, [['create', 'bokadirekt', 1], ['cancel', 'bokadirekt', 1]]);
  assert.ok(r.errors.linkjournal);

  await assert.rejects(
    runSync({ sources: [good], targets: [target], staffKeys: ['volkan'], from: '', to: '', dryRun: false, maxCancels: 0, log: () => {} }),
    /Güvenlik sınırı/,
  );
});

test('Wix: kendi blokları ve eski Linkjournal takvimi meşgul sayılmaz; doğru başlıklar gider', async () => {
  const sent = [];
  const events = [
    { id: 'a', scheduleId: 'svc', type: 'APPOINTMENT', status: 'CONFIRMED', transparency: 'OPAQUE', start: { utcDate: '2026-11-04T07:00:00Z' }, end: { utcDate: '2026-11-04T07:45:00Z' }, resources: [{ id: 'R1' }] },
    { id: 'b', scheduleId: 'BLK', type: 'DEFAULT', status: 'CONFIRMED', transparency: 'OPAQUE', start: { utcDate: '2026-11-04T08:00:00Z' }, end: { utcDate: '2026-11-04T09:00:00Z' }, resources: [{ id: 'R1' }] },
    { id: 'c', scheduleId: 'LEG', type: 'DEFAULT', status: 'CONFIRMED', transparency: 'OPAQUE', start: { utcDate: '2026-11-04T10:00:00Z' }, end: { utcDate: '2026-11-04T11:00:00Z' }, resources: [{ id: 'R1' }] },
    { id: 'd', scheduleId: 'svc', type: 'APPOINTMENT', status: 'CANCELLED', transparency: 'OPAQUE', start: { utcDate: '2026-11-04T12:00:00Z' }, end: { utcDate: '2026-11-04T13:00:00Z' }, resources: [{ id: 'R1' }] },
  ];
  const fetchImpl = async (url, opts) => {
    sent.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
    const body = url.endsWith('/events/query') ? { events, pagingMetadata: { hasNext: false } } : { bulkActionMetadata: { totalSuccesses: 1 }, results: [] };
    return { ok: true, status: 200, text: async () => JSON.stringify(body), headers: new Map() };
  };
  const wix = createWix({
    apiKey: 'KEY', siteId: 'SITE', fetchImpl,
    staff: [{ key: 'volkan', wixResourceId: 'R1' }],
    blockSchedules: { bokadirekt: 'BLK' },
    readOnlySchedules: { legacy: 'LEG' },
  });
  const busy = await wix.listBusy('2026-11-04T00:00:00Z', '2026-11-05T00:00:00Z');
  assert.deepEqual(busy, [slot('volkan', '2026-11-04T07:00:00Z', '2026-11-04T07:45:00Z')]);
  assert.equal(sent[0].headers.Authorization, 'KEY');
  assert.equal(sent[0].headers['wix-site-id'], 'SITE');

  await wix.createBlocks('bokadirekt', [slot('volkan', '2026-11-04T13:00:00Z', '2026-11-04T14:00:00Z')]);
  const ev = sent.at(-1).body.events[0].event;
  assert.equal(ev.scheduleId, 'BLK');
  assert.equal(ev.start.localDate, '2026-11-04T14:00:00');
  assert.deepEqual(ev.resources, [{ id: 'R1' }]);
});

test('Link Journal: sayfalı okur, iptalleri ve yok sayılan aktiviteleri atlar, personeli eşler', async () => {
  const { createLinkjournal } = await import('../src/connectors/linkjournal.js');
  const appt = (id, s, e, status, users, act = 'Lyckselevet') => ({ appointment: { id, starts_at: s, ends_at: e, status, user_ids: users, activity_name: act } });
  const pages = {
    1: { data: [appt(1, '2026-11-04T09:00:00.000+01:00', '2026-11-04T09:30:00.000+01:00', 'new', [2]), appt(2, '2026-11-04T10:00:00.000+01:00', '2026-11-04T11:00:00.000+01:00', 'cancelled', [2])], meta: { total: 3, page: 1, per_page: 2 } },
    2: { data: [appt(3, '2026-11-05T08:00:00.000+01:00', '2026-11-05T17:00:00.000+01:00', 'new', [3, 1], 'Beredskap')], meta: { total: 3, page: 2, per_page: 2 } },
  };
  const urls = [];
  const fetchImpl = async (url, opts) => {
    urls.push(url);
    assert.equal(opts.headers.Authorization, 'Bearer K');
    const page = new URL(url).searchParams.get('page');
    return { ok: true, status: 200, text: async () => JSON.stringify(pages[page]) };
  };
  const staff = [{ key: 'volkan', linkjournal: 2 }, { key: 'davut', linkjournal: 3 }];
  const lj = createLinkjournal({ apiUrl: 'https://x/api/v2/', apiKey: 'K', staff, fetchImpl });
  assert.deepEqual(await lj.listBusy('2026-11-04T00:00:00Z', '2026-11-06T00:00:00Z'), [
    slot('volkan', '2026-11-04T08:00:00Z', '2026-11-04T08:30:00Z'),
    slot('davut', '2026-11-05T07:00:00Z', '2026-11-05T16:00:00Z'),
  ]);
  assert.match(urls[0], /schedule\/appointments\?starts_at_from=2026-11-04&starts_at_to=2026-11-07&per_page=100&page=1$/);
  assert.equal(urls.length, 2);

  const lj2 = createLinkjournal({ apiUrl: 'https://x/api/v2', apiKey: 'K', staff, ignoreActivities: ['beredskap'], fetchImpl });
  assert.deepEqual((await lj2.listBusy('2026-11-04T00:00:00Z', '2026-11-06T00:00:00Z')).map(s => s.staff), ['volkan']);
  assert.equal(lj.canWrite, false);
});

test('Boka Direkt: personel başına iCal linki; biri okunamazsa kaynak hata verir', async () => {
  const { createBokadirekt } = await import('../src/connectors/bokadirekt.js');
  const ics = (s, e) => ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', `DTSTART:${s}`, `DTEND:${e}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const bodies = { v: ics('20261104T080000Z', '20261104T090000Z'), d: ics('20261105T120000Z', '20261105T123000Z') };
  const fetchImpl = async url => bodies[url] ? { ok: true, text: async () => bodies[url] } : { ok: false, status: 404 };
  const bd = createBokadirekt({ icsFeeds: [{ staff: 'volkan', url: 'v' }, { staff: 'davut', url: 'd' }, { staff: '*', url: undefined }], fetchImpl });
  assert.deepEqual(await bd.listBusy('2026-11-04T00:00:00Z', '2026-11-06T00:00:00Z'), [
    slot('volkan', '2026-11-04T08:00:00Z', '2026-11-04T09:00:00Z'),
    slot('davut', '2026-11-05T12:00:00Z', '2026-11-05T12:30:00Z'),
  ]);
  assert.equal(createBokadirekt({ icsFeeds: [{ staff: '*', url: '' }] }), null);
  const broken = createBokadirekt({ icsFeeds: [{ staff: 'volkan', url: 'v' }, { staff: 'davut', url: 'x' }], fetchImpl });
  await assert.rejects(broken.listBusy('2026-11-04T00:00:00Z', '2026-11-06T00:00:00Z'), /davut/);
});

test('toOffsetIso: Stockholm ofseti, yaz/kış', async () => {
  const { toOffsetIso } = await import('../src/time.js');
  assert.equal(toOffsetIso('2026-11-04T08:00:00.000Z'), '2026-11-04T09:00:00+01:00');
  assert.equal(toOffsetIso('2027-07-01T08:00:00.000Z'), '2027-07-01T10:00:00+02:00');
});

test('matchCustomer: isim, çift isimde telefon, sadece telefon, yedek', async () => {
  const { matchCustomer } = await import('../src/connectors/linkjournal.js');
  const cs = [
    { id: 1, name: 'Andersson, Anna', first_name: 'Anna', last_name: 'Andersson', phone_numbers: [{ number: '070-111 22 33' }], emails: [] },
    { id: 2, name: 'Berg, Erik', first_name: 'Erik', last_name: 'Berg', phone_numbers: [{ number: '0702223344' }], emails: [{ address: 'erik@x.se' }] },
    { id: 3, name: 'Berg, Erik', first_name: 'Erik', last_name: 'Berg', phone_numbers: [{ number: '0705556677' }], emails: [] },
    { id: 4, name: 'Gammal Kund', first_name: 'Gammal', last_name: 'Kund', removed: true, phone_numbers: [], emails: [] },
  ];
  assert.deepEqual(matchCustomer(cs, { name: 'anna andersson' }, 293), { id: 1, how: 'isim' });
  assert.deepEqual(matchCustomer(cs, { name: 'Erik Berg', phone: '+46 70 555 66 77' }, 293), { id: 3, how: 'isim+telefon/e-posta' });
  assert.deepEqual(matchCustomer(cs, { name: 'Erik Berg' }, 293), { id: 293, how: 'yedek' });
  assert.deepEqual(matchCustomer(cs, { name: 'E. Berg', email: 'ERIK@x.se' }, 293), { id: 2, how: 'telefon/e-posta' });
  assert.deepEqual(matchCustomer(cs, { name: 'Gammal Kund' }, 293), { id: 293, how: 'yedek' });
  assert.deepEqual(matchCustomer(cs, {}, 293), { id: 293, how: 'yedek' });
});

test('Link Journal yazma: alanlar kök seviyede, kendi randevuları dolu sayılmaz, iptal /cancel ile', async () => {
  const { createLinkjournal } = await import('../src/connectors/linkjournal.js');
  const sent = [];
  const appts = [
    { id: 10, starts_at: '2026-11-04T09:00:00.000+01:00', ends_at: '2026-11-04T09:30:00.000+01:00', status: 'new', user_ids: [2], description: '[wix] Vaccination – Anna Andersson' },
    { id: 11, starts_at: '2026-11-04T10:00:00.000+01:00', ends_at: '2026-11-04T10:30:00.000+01:00', status: 'new', user_ids: [2], description: 'Vanlig' },
  ];
  const fetchImpl = async (url, opts) => {
    const u = new URL(url);
    sent.push({ method: opts.method, path: u.pathname, body: opts.body && JSON.parse(opts.body) });
    let body = {};
    if (u.pathname.endsWith('/schedule/appointments') && opts.method === 'GET') body = { data: appts.map(a => ({ appointment: a })), meta: { total: 2, per_page: 100 } };
    if (u.pathname.endsWith('/customers')) body = { data: [{ customer: { id: 1, name: 'Andersson, Anna', first_name: 'Anna', last_name: 'Andersson', phone_numbers: [], emails: [] } }], meta: { total: 1, per_page: 100 } };
    if (opts.method === 'POST') body = { data: { appointment: { id: 99 } } };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  const staff = [{ key: 'volkan', linkjournal: 2 }];
  const lj = createLinkjournal({ apiUrl: 'https://x/api/v2', apiKey: 'K', staff, writeEnabled: true, log: () => {}, fetchImpl });
  assert.equal(lj.canWrite, true);
  assert.deepEqual(lj.acceptSources, ['wix']);
  const from = '2026-11-04T00:00:00Z', to = '2026-11-05T00:00:00Z';
  assert.deepEqual(await lj.listBusy(from, to), [slot('volkan', '2026-11-04T09:00:00Z', '2026-11-04T09:30:00Z')]);
  assert.deepEqual(await lj.listBlocks('wix', from, to), [{ id: 10, key: slotKey(slot('volkan', '2026-11-04T08:00:00Z', '2026-11-04T08:30:00Z')) }]);

  const r = await lj.createBlocks('wix', [slot('volkan', '2026-11-04T12:00:00Z', '2026-11-04T12:30:00Z', { title: 'Vaccination', name: 'Anna Andersson', phone: '0701112233' })]);
  assert.equal(r.ok, 1);
  const post = sent.find(x => x.method === 'POST' && x.path.endsWith('/schedule/appointments'));
  assert.deepEqual(post.body, {
    appointment: { starts_at: '2026-11-04T13:00:00+01:00', ends_at: '2026-11-04T13:30:00+01:00', location_id: 1, customer_id: 1, activity_id: 11, description: '[wix] Vaccination – Anna Andersson, 0701112233' },
    user_ids: [2], filter_user_id: 2, visit_reason_ids: [1],
  });
  await lj.cancelBlocks('wix', [10, 10]);
  assert.deepEqual(sent.filter(x => x.path.endsWith('/cancel')).map(x => x.path), ['/api/v2/schedule/appointments/10/cancel']);
});

test('runSync: hedefin acceptSources listesi dışındaki kaynaklar yazılmaz', async () => {
  const calls = [];
  const target = { name: 'linkjournal', acceptSources: ['wix'], listBlocks: async () => [], createBlocks: async (src, s) => { calls.push(src); return { ok: s.length, failed: [] }; }, cancelBlocks: async () => ({ ok: 0, failed: [] }) };
  const mk = name => ({ name, listBusy: async () => [slot('volkan', '2026-11-04T07:00:00Z', '2026-11-04T08:00:00Z')] });
  await runSync({ sources: [mk('wix'), mk('bokadirekt')], targets: [target], staffKeys: ['volkan'], from: '', to: '', dryRun: false, log: () => {} });
  assert.deepEqual(calls, ['wix']);
});

test('runSync skipIfBusy: hedefte o saatte zaten randevu varsa açılmaz, var olan blok korunur', async () => {
  const created = [];
  const kept = slot('volkan', '2026-11-04T10:00:00Z', '2026-11-04T10:30:00Z');
  const target = {
    name: 'linkjournal', skipIfBusy: true, acceptSources: ['wix'],
    listBusy: async () => [slot('volkan', '2026-11-04T07:00:00Z', '2026-11-04T08:00:00Z'), slot('volkan', '2026-11-04T10:00:00Z', '2026-11-04T11:00:00Z')],
    listBlocks: async () => [{ id: 5, key: slotKey(kept) }],
    createBlocks: async (src, s) => { created.push(...s.map(slotKey)); return { ok: s.length, failed: [] }; },
    cancelBlocks: async (src, ids) => { created.push('cancel:' + ids); return { ok: 0, failed: [] }; },
  };
  const wix = { name: 'wix', listBusy: async () => [
    slot('volkan', '2026-11-04T07:30:00Z', '2026-11-04T08:00:00Z'), // LJ'de zaten dolu → atla
    slot('volkan', '2026-11-04T09:00:00Z', '2026-11-04T09:30:00Z'), // boş → aç
    kept,                                                          // zaten bizim blok → koru
  ] };
  await runSync({ sources: [wix, target], targets: [target], staffKeys: ['volkan'], from: '', to: '', dryRun: false, log: () => {} });
  assert.deepEqual(created, [slotKey(slot('volkan', '2026-11-04T09:00:00Z', '2026-11-04T09:30:00Z'))]);
});
