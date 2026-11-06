// Senkronizasyon çekirdeği. Her sistemden dolu saatleri okur, her yazılabilir hedefe
// diğer sistemlerin dolu saatlerini blok olarak yazar, artık geçersiz blokları iptal eder.
import { diffBlocks, expandAllStaff, slotKey } from './slots.js';

// sources: [{ name, origin?, listBusy(from, to) }]  — origin: verinin fiziksel olarak durduğu sistem
// targets: [{ name, listBlocks, createBlocks, cancelBlocks }]
export async function runSync({ sources, targets, staffKeys, from, to, dryRun = true, maxCancels = 60, log = console.log }) {
  const busy = {};
  const errors = {};
  for (const s of sources) {
    try {
      busy[s.name] = { origin: s.origin || s.name, slots: expandAllStaff(await s.listBusy(from, to), staffKeys) };
      log(`okundu  ${s.name}: ${busy[s.name].slots.length} dolu slot`);
    } catch (e) {
      errors[s.name] = String(e.message || e);
      log(`HATA    ${s.name} okunamadı, bu kaynağın bloklarına dokunulmayacak: ${errors[s.name]}`);
    }
  }

  const plans = [];
  for (const t of targets) {
    for (const [src, b] of Object.entries(busy)) {
      if (src === t.name || b.origin === t.name) continue;
      if (t.acceptSources && !t.acceptSources.includes(src)) continue;
      try {
        const existing = await t.listBlocks(src, from, to);
        let want = b.slots;
        // skipIfBusy: hedefte o personel o saatte zaten doluysa (ör. randevu elle girilmişse) yeni kayıt açılmaz
        if (t.skipIfBusy && busy[t.name]) {
          const own = busy[t.name].slots;
          const kept = existing.map(e => e.key);
          want = want.filter(w => kept.includes(slotKey(w)) ||
            !own.some(o => o.staff === w.staff && Date.parse(o.start) < Date.parse(w.end) && Date.parse(o.end) > Date.parse(w.start)));
          if (want.length < b.slots.length) log(`atlandı ${t.name} <- ${src}: ${b.slots.length - want.length} randevu hedefte zaten dolu saatte`);
        }
        plans.push({ target: t, source: src, ...diffBlocks(want, existing) });
      } catch (e) {
        errors[`${t.name}<-${src}`] = String(e.message || e);
        log(`HATA    ${t.name} <- ${src} blokları okunamadı: ${errors[`${t.name}<-${src}`]}`);
      }
    }
  }

  const totalCancels = plans.reduce((n, p) => n + p.toCancel.length, 0);
  for (const p of plans) log(`plan    ${p.target.name} <- ${p.source}: +${p.toCreate.length} blok, -${p.toCancel.length} blok`);
  if (totalCancels > maxCancels) {
    throw new Error(`Güvenlik sınırı: ${totalCancels} blok iptal edilecekti (sınır ${maxCancels}). Hiçbir şey yazılmadı; kaynak verisini kontrol et.`);
  }

  const results = [];
  if (!dryRun) {
    for (const p of plans) {
      const created = p.toCreate.length ? await p.target.createBlocks(p.source, p.toCreate) : { ok: 0, failed: [] };
      const cancelled = p.toCancel.length ? await p.target.cancelBlocks(p.source, p.toCancel) : { ok: 0, failed: [] };
      results.push({ target: p.target.name, source: p.source, created, cancelled });
      log(`yazıldı ${p.target.name} <- ${p.source}: +${created.ok} -${cancelled.ok}` +
        (created.failed.length || cancelled.failed.length ? ` (hata: ${created.failed.length + cancelled.failed.length})` : ''));
    }
  } else {
    for (const p of plans) if (p.target.preview && p.toCreate.length) log(`önizleme ${p.target.name} <- ${p.source}: ${await p.target.preview(p.source, p.toCreate)}`);
    log('deneme  --dry-run: hiçbir şey yazılmadı');
  }

  return {
    plans: plans.map(p => ({ target: p.target.name, source: p.source, create: p.toCreate.length, cancel: p.toCancel.length })),
    results,
    errors,
  };
}
