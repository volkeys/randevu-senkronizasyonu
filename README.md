# Randevu senkronizasyonu

Wix Bookings, Link Journal ve Boka Direkt arasında **dolu saatleri** her saat başı senkronize eder.
Bir sistemde alınan randevu, diğer sistemlerde o personelin o saatini kapatır. Hasta ya da müşteri bilgisi taşınmaz;
sadece "kim, ne zaman dolu" bilgisi aktarılır.

## Durum (2026-11-03)

| Sistem | Okuma | Yazma (saat kapatma) | Durum |
|---|---|---|---|
| Wix Bookings | ✅ | ✅ | Hazır, sadece API anahtarı gerekiyor |
| Link Journal | ⏳ | ⏳ | API erişimi bekleniyor. Webhook gerekmiyor, her saat API'den okunuyor |
| Boka Direkt | ⏳ iCal ya da API | ⏳ sadece API ile | Boka Direkt'e sorulacak |

Link Journal API'si gelene kadar, eski sync'in Wix'e yazdığı **"Linkjournal (extern bokning)"** takvimi
Link Journal'ın dolu saatleri olarak okunur. Bu takvim hiçbir zaman değiştirilmez.

## Nasıl çalışır

1. Her sistemden önümüzdeki 90 günün dolu saatleri okunur.
2. Her hedef sistemde, diğer sistemlerin dolu saatleri için birer **blok** olmalıdır. Wix'te bu bloklar
   her kaynak için ayrı bir takvimde durur: `Sync – linkjournal` ve `Sync – bokadirekt`.
3. Eksik bloklar oluşturulur. Artık geçerli olmayanlar (iptal edilen randevular) ile çift kopyalar iptal edilir.
4. Sync'in kendi yazdığı bloklar "dolu" sayılmaz, böylece sistemler arasında döngü oluşmaz.
5. Bir kaynak okunamazsa, o kaynağa ait bloklara dokunulmaz.
6. Bir çalışma 60'tan fazla bloğu iptal etmek isterse hiçbir şey yazılmaz (`SYNC_MAX_CANCELS`).

Webhook yoktur: her saat baştan okunup fark hesaplandığı için kaçırılan bir değişiklik bir sonraki saatte yakalanır.

## Gizlilik

Depo herkese açıktır. Anahtarlar ve iCal linkleri sadece GitHub secret'larında durur; kayıtlara müşteri adı,
randevu saati ya da API yanıt içeriği yazılmaz, sadece sayılar.

## Kurulum

1. **Wix API anahtarı:** manage.wix.com → Hesap ayarları → API Keys. Bir anahtar oluştur ve **Manage Calendars**
   (Wix Bookings / Calendar) iznini ver.
2. **Blok takvimlerini oluştur** (tek seferlik):
   ```bash
   WIX_API_KEY=... WIX_SITE_ID=21200a6c-2c33-404e-9b19-6b6a7756c9f5 npm run setup:wix
   ```
   Çıkan iki `WIX_BLOCK_SCHEDULE_...` değerini not al.
3. **GitHub'a yükle:** Bu klasörden özel (private) bir GitHub deposu oluştur. Settings → Secrets and variables → Actions
   altına `.env.example` dosyasındaki değerleri ekle.
4. **Deneme:** Actions → "Randevu senkronizasyonu" → Run workflow ("dry run" işaretli). Plan loglarda görünür, hiçbir şey yazılmaz.
5. Plan doğruysa saatlik döngüyü başlat: Actions → "Randevu senkronizasyonu (saatlik döngü)" → Run workflow.
   Bu iş ~6 saat açık kalır, her saat :07'de (UTC) senkronize eder ve kendini yeniden başlatır; 2 saatte bir
   zamanlanmış başlatma, zincir koparsa onu geri getirir. (GitHub'ın kendi saatlik zamanlaması ücretsiz depolarda
   saatlerce gecikiyor; bu yüzden döngü kullanılıyor. Depo herkese açık olduğu için Actions dakikaları ücretsiz.)
   Durdurmak için: Actions → bu iş → "Disable workflow".

## Link Journal API'si gelince

`src/connectors/linkjournal.js` içindeki dört fonksiyon API dokümanına göre doldurulacak. Dokümanları ve test
anahtarını Claude'a vermen yeterli. Ayrıca `config/staff.json` içinde her personelin Link Journal ID'si doldurulacak.

**Önemli:** Yeni Link Journal bağlantısı açıldığında, şu an "Linkjournal (extern bokning)" takvimine yazan eski sync
kapatılmalı. Yoksa aynı saatler Wix'te iki kez kapanır. Bu zararsızdır ama gereksizdir.

## Boka Direkt

Boka Direkt'in açık bir API'si yok; her personelin **iCal linki** okunur (sadece okuma: Boka Direkt randevuları
Wix'te saati kapatır, ters yön çalışmaz).

1. Boka Direkt portal → Inställningar → Användare → personel → Platsuppgifter (düzenle) → **ICal synkronisering** aç, kaydet.
2. Aynı pencereyi tekrar aç: düğmenin altındaki linki sağdaki düğmeyle kopyala.
3. GitHub secret olarak ekle: `BOKADIREKT_ICS_VOLKAN`, `BOKADIREKT_ICS_DAVUT` (adı `config/staff.json`'daki `key`'in büyük harflisi).
4. Elle dry run ile kontrol et; doğruysa `BOKADIREKT_LIVE=true` değişkeniyle saatlik çalışmaya aç.

Not: Link Journal randevuları Boka Direkt'e başka bir sistem tarafından "[LJ#…] Ej bokbar tid" olarak yazılıyor;
bunlar iCal linkinde yer almıyor, yani tekrar Wix'e kopyalanmıyor.

## Komutlar

```bash
npm test            # birim testleri
npm run sync:dry    # sadece planı göster
npm run sync        # senkronize et
```
