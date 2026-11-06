// Giriş noktası: node src/index.js [--dry-run] [--setup-wix]
import { readFileSync } from 'node:fs';
import { createWix } from './connectors/wix.js';
import { createLinkjournal } from './connectors/linkjournal.js';
import { createBokadirekt } from './connectors/bokadirekt.js';
import { runSync } from './sync.js';
import { slotKey } from './slots.js';

// Eski Linkjournal -> Wix sync'inin yazdığı takvim (2026-09-01'den beri). Okunur, asla yazılmaz.
const LEGACY_LINKJOURNAL_SCHEDULE = 'a888e3fa-1f9e-4b00-9d72-caae3efc706c';

const env = process.env;
const args = new Set(process.argv.slice(2));
// Wix -> Link Journal randevu açma: LINKJOURNAL_WRITE=true ile açılır; dry run'da her zaman önizlenir
const ljWrite = env.LINKJOURNAL_WRITE === 'true' || args.has('--dry-run');
const { staff } = JSON.parse(readFileSync(new URL('../config/staff.json', import.meta.url), 'utf8'));

function need(name) {
  if (!env[name]) throw new Error(`${name} ortam değişkeni eksik (bkz. .env.example)`);
  return env[name];
}

const blockSchedules = {
  linkjournal: env.WIX_BLOCK_SCHEDULE_LINKJOURNAL,
  bokadirekt: env.WIX_BLOCK_SCHEDULE_BOKADIREKT,
};
const legacySchedule = env.WIX_LEGACY_LINKJOURNAL_SCHEDULE ?? LEGACY_LINKJOURNAL_SCHEDULE;

const wix = createWix({
  apiKey: need('WIX_API_KEY'),
  siteId: need('WIX_SITE_ID'),
  staff,
  blockSchedules,
  readOnlySchedules: { legacyLinkjournal: legacySchedule },
  withContactInfo: ljWrite,
});

if (args.has('--setup-wix')) {
  for (const [source, id] of Object.entries(blockSchedules)) {
    if (id) { console.log(`${source}: zaten var (${id})`); continue; }
    const newId = await wix.createBlockSchedule(`Sync – ${source}`);
    console.log(`WIX_BLOCK_SCHEDULE_${source.toUpperCase()}=${newId}`);
  }
  console.log('Bu değerleri GitHub Secrets\'a (ya da .env dosyasına) ekle.');
  process.exit(0);
}

const linkjournal = createLinkjournal({
  apiUrl: env.LINKJOURNAL_API_URL,
  apiKey: env.LINKJOURNAL_API_KEY,
  staff,
  ignoreActivities: (env.LINKJOURNAL_IGNORE_ACTIVITIES ?? '').split(','),
  writeEnabled: ljWrite,
  fallbackCustomerId: Number(env.LINKJOURNAL_FALLBACK_CUSTOMER || 293),
});
const bokadirekt = createBokadirekt({
  icsFeeds: [
    ...staff.map(s => ({ staff: s.key, url: env[`BOKADIREKT_ICS_${s.key.toUpperCase()}`] })),
    { staff: env.BOKADIREKT_ICS_STAFF || '*', url: env.BOKADIREKT_ICS_URL },
  ],
  apiUrl: env.BOKADIREKT_API_URL,
  apiKey: env.BOKADIREKT_API_KEY,
});

const sources = [wix];
if (linkjournal) sources.push(linkjournal);
else if (legacySchedule) {
  // Link Journal API'si gelene kadar: eski sync'in Wix'e yazdığı bloklar Link Journal'ın
  // dolu saatleri sayılır. Veri zaten Wix'te olduğu için Wix'e tekrar yazılmaz.
  sources.push({ name: 'linkjournal', origin: 'wix', listBusy: (f, t) => wix.listScheduleBusy(legacySchedule, f, t) });
}
if (bokadirekt) sources.push(bokadirekt);

const targets = [wix, linkjournal, bokadirekt].filter(c => c && c.canWrite);

const days = Number(env.SYNC_DAYS_AHEAD || 90);
const from = new Date().toISOString();
const to = new Date(Date.now() + days * 864e5).toISOString();

try {
  const report = await runSync({
    sources, targets,
    staffKeys: staff.map(s => s.key),
    from, to,
    dryRun: args.has('--dry-run'),
    maxCancels: Number(env.SYNC_MAX_CANCELS || 60),
  });
  console.log(JSON.stringify(report, null, 2));
  if (args.has('--dry-run') && linkjournal && legacySchedule) {
    // Geçiş kontrolü: eski sync'in Wix'e yazdıkları ile Link Journal API'sinden okunanlar ne kadar örtüşüyor?
    const [api, legacy] = await Promise.all([linkjournal.listBusy(from, to), wix.listScheduleBusy(legacySchedule, from, to)]);
    const a = new Set(api.map(slotKey)), l = new Set(legacy.map(slotKey));
    console.log(`karşılaştırma  API: ${a.size}, eski takvim: ${l.size}, ikisinde de: ${[...a].filter(k => l.has(k)).length}, ` +
      `sadece API'de: ${[...a].filter(k => !l.has(k)).length}, sadece eski takvimde: ${[...l].filter(k => !a.has(k)).length}`);
  }
  if (Object.keys(report.errors).length) process.exitCode = 1;
  if (linkjournal && legacySchedule) {
    // Eski sync kapatıldı (2026-11-04). Eski takvimde yeniden gelecek blok belirirse hâlâ çalışıyordur:
    // iş başarısız sayılır, GitHub e-posta ile haber verir.
    const legacy = await wix.listScheduleBusy(legacySchedule, from, to);
    if (legacy.length) {
      console.error(`UYARI   eski Linkjournal sync'i hâlâ yazıyor: eski takvimde ${legacy.length} gelecek blok var`);
      process.exitCode = 1;
    }
  }
} catch (e) {
  console.error(e.message || e);
  process.exitCode = 1;
}
