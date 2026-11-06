// "Slot" bir kişinin dolu olduğu zaman aralığıdır: { staff, start, end }, UTC-ISO.
// İsteğe bağlı "info" (hizmet, müşteri adı/telefon/e-posta) sadece randevu kaydı açan hedefler
// için taşınır (Wix -> Link Journal); karşılaştırma anahtarına girmez.
import { normIso } from './time.js';

export function slot(staff, start, end, info) {
  const s = { staff, start: normIso(start), end: normIso(end) };
  if (info) s.info = info;
  return s;
}

export function slotKey(s) {
  return `${s.staff}|${s.start}|${s.end}`;
}

export function uniqueSlots(slots) {
  const m = new Map();
  for (const s of slots) if (Date.parse(s.end) > Date.parse(s.start)) m.set(slotKey(s), s);
  return [...m.values()];
}

// desired: bloklanması gereken slotlar. existing: hedefte zaten olan bloklar [{ id, key }].
// Eksik olanları ve iptal edilecekleri (artık geçersiz olanlar + çiftler) döndürür.
export function diffBlocks(desired, existing) {
  const want = new Map(uniqueSlots(desired).map(s => [slotKey(s), s]));
  const seen = new Set();
  const toCancel = [];
  for (const b of existing) {
    if (!want.has(b.key) || seen.has(b.key)) toCancel.push(b.id);
    else seen.add(b.key);
  }
  const toCreate = [...want.entries()].filter(([k]) => !seen.has(k)).map(([, s]) => s);
  return { toCreate, toCancel };
}

// "*" tüm kliniğin dolu olduğu anlamına gelir; bilinen herkese açılır.
export function expandAllStaff(slots, staffKeys) {
  return slots.flatMap(s => s.staff === '*' ? staffKeys.map(k => ({ ...s, staff: k })) : [s]);
}
