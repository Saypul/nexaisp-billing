# Work Order Telegram

Setiap pelanggan baru otomatis membuat ticket **Open** di menu Ticketing. Bila admin memilih layanan saat registrasi, layanan tetap **Pending** sampai ticket **Closed**. Setelah admin mengisi **Chat ID Grup Teknisi** di menu Telegram, bot mengirim WO baru langsung ke grup. Semua WO yang belum Closed juga dikirim sekali ketika Chat ID grup pertama kali disimpan.

## 1. Bot dan grup teknisi

1. Buat bot melalui [@BotFather](https://t.me/BotFather), lalu simpan token di menu **Telegram** billing. Worker memverifikasi bot dan menyimpan token terenkripsi.
2. Tambahkan bot ke grup teknisi. Kirim `/chatid` di grup; salin angka negatif yang dibalas bot ke kolom **Chat ID Grup Teknisi**, lalu simpan.
3. Pesan WO Open memiliki tombol **📥 Ambil WO**. Hanya satu akun Telegram yang dapat mengambil tiap WO; penugasan lain tetap dapat diatur admin melalui web.
4. Teknisi yang mengambil WO menekan tombol progres sesuai tahap: **🔎 Mulai Survey → 🛠 Mulai Instalasi → 🧪 Siap Aktivasi → ✅ Closed & Aktifkan Layanan**. Tombol **📷 Catatan / Foto** meminta teknisi membalas pesan bot dengan teks, foto, atau foto dengan caption. Batas foto 10 MB; format JPG, PNG, dan WebP. Setiap foto disimpan pada riwayat tahap WO saat dikirim dan terlihat di detail Ticketing billing. Bot hanya menerima tindakan dari grup yang dikonfigurasi atau chat pribadi teknisi yang ditugaskan. Admin dapat memantau dan memperbarui ticket dari web.
5. Saat ticket **Closed**, layanan menjadi **Active** dan masuk ke menu Layanan Aktif. Riwayat WO mencatat pengambil dan setiap perubahan progres.

Perintah teks `/pickup`, `/status`, dan `/note` tetap tersedia sebagai cadangan. Jika bot memakai privacy mode Telegram, gunakan `/chatid@NamaBot` untuk konfigurasi grup. Chat ID grup dapat berubah saat grup dimigrasikan menjadi supergroup; perbarui ID di menu Telegram bila itu terjadi.

## 2. Alur pesan

- **Keluar (notifikasi WO):** `telegram_worker` mengirim langsung ke Telegram Bot API. Event yang gagal terkirim disimpan dan dicoba ulang otomatis (maksimal 20 kali).
- **Masuk (tombol, perintah, foto dari teknisi):** Telegram mengirim update lewat **webhook** ke `https://<BILLING_DOMAIN>/api/telegram/webhook`. Setiap request diverifikasi dengan header `X-Telegram-Bot-Api-Secret-Token`; update diproses berurutan (`max_connections=1`) dan update yang dikirim ulang Telegram tidak diproses dua kali.
- Worker mendaftarkan webhook secara otomatis saat start, saat token bot diganti, dan memeriksanya setiap 5 menit. Bila `BILLING_DOMAIN` di `.env` kosong, worker melepas webhook dan kembali ke **polling**.

Tidak ada layanan perantara (n8n tidak lagi dipakai). Jangan memasang webhook lain untuk bot yang sama, karena Telegram hanya mengizinkan satu webhook per bot dan worker akan menimpanya kembali.

Foto dokumentasi disalin dari Telegram ke volume Docker `work_order_photos`, sehingga tetap dapat ditampilkan melalui API billing yang memerlukan login administrator. Volume ini perlu dipertahankan bersama database saat memindahkan server.

Jika notifikasi gagal, event WO disimpan dan worker mencoba ulang; status ticket yang sudah tersimpan tidak dibatalkan. Lihat log dengan `docker compose logs --tail=100 telegram_worker`.
