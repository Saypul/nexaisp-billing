# Work Order Telegram dan n8n

Setiap pelanggan baru otomatis membuat ticket **Open** di menu Ticketing. Bila admin memilih layanan saat registrasi, layanan tetap **Pending** sampai ticket **Closed**. Setelah admin mengisi **Chat ID Grup Teknisi** di menu Telegram, n8n mengirim WO baru ke grup. Semua WO yang belum Closed juga dikirim sekali ketika Chat ID grup pertama kali disimpan.

## 1. Bot dan grup teknisi

1. Buat bot melalui [@BotFather](https://t.me/BotFather), lalu simpan token di menu **Telegram** billing. Worker memverifikasi bot dan menyimpan token terenkripsi.
2. Tambahkan bot ke grup teknisi. Kirim `/chatid` di grup; salin angka negatif yang dibalas bot ke kolom **Chat ID Grup Teknisi**, lalu simpan.
3. Pesan WO Open memiliki tombol **📥 Ambil WO**. Hanya satu akun Telegram yang dapat mengambil tiap WO; penugasan lain tetap dapat diatur admin melalui web.
4. Teknisi yang mengambil WO menekan tombol progres sesuai tahap: **🔎 Mulai Survey → 🛠 Mulai Instalasi → 🧪 Siap Aktivasi → ✅ Closed & Aktifkan Layanan**. Tombol **📷 Catatan / Foto** meminta teknisi membalas pesan bot dengan teks, foto, atau foto dengan caption. Batas foto 10 MB; format JPG, PNG, dan WebP. Setiap foto disimpan pada riwayat tahap WO saat dikirim dan terlihat di detail Ticketing billing. Bot hanya menerima tindakan dari grup yang dikonfigurasi atau chat pribadi teknisi yang ditugaskan. Admin dapat memantau dan memperbarui ticket dari web.
5. Saat ticket **Closed**, layanan menjadi **Active** dan masuk ke menu Layanan Aktif. Riwayat WO mencatat pengambil dan setiap perubahan progres.

Perintah teks `/pickup`, `/status`, dan `/note` tetap tersedia sebagai cadangan. Jika bot memakai privacy mode Telegram, gunakan `/chatid@NamaBot` untuk konfigurasi grup. Chat ID grup dapat berubah saat grup dimigrasikan menjadi supergroup; perbarui ID di menu Telegram bila itu terjadi.

Bot menerima pesan masuk dengan polling. Workflow n8n hanya mengirim notifikasi keluar; jangan mengaktifkan Telegram Trigger n8n untuk bot yang sama karena polling dan webhook Telegram tidak dapat dipakai bersamaan.

## 2. n8n untuk notifikasi WO

n8n berjalan pada port `5679` di seluruh antarmuka jaringan server dengan data persisten. Buka `http://IP_SERVER:5679` dari perangkat di jaringan yang dapat mencapai server, lalu buat akun owner n8n. Port ini dipilih karena `5678` sudah digunakan aplikasi lain di server. Akses dari jaringan lain tetap mengikuti firewall/router server. Untuk akses lewat Internet, pasang HTTPS melalui reverse proxy sebelum memasukkan kredensial sensitif.

Workflow **NexaISP Work Order to Telegram** sudah **terpublish** di n8n dengan alur **Webhook internal → Telegram Send Message** dan keyboard tombol inline dinamis. Kredensial Header Auth webhook dan Telegram API sudah terhubung. Worker billing memakai `N8N_WO_WEBHOOK_URL=http://n8n:5678/webhook/nexaisp-work-order`, sehingga notifikasi WO dikirim melalui n8n. Salinan workflow ada di [work-order-telegram.json](n8n/work-order-telegram.json).

Pesan masuk dari teknisi tetap diterima melalui polling worker; riwayat progres tersimpan di database NexaISP. Jika token bot diganti di menu Telegram billing, perbarui juga kredensial **NexaISP WO Telegram Bot** di n8n sebelum mengirim WO berikutnya. Jangan mengimpor ulang JSON ke instance yang sama karena ID workflow tetap dapat menimpa konfigurasi kredensial yang dipilih di UI.

Foto dokumentasi disalin dari Telegram ke volume Docker `work_order_photos`, sehingga tetap dapat ditampilkan melalui API billing yang memerlukan login administrator. Volume ini perlu dipertahankan bersama database saat memindahkan server.

Jika notifikasi gagal, event WO disimpan dan worker mencoba ulang; status ticket yang sudah tersimpan tidak dibatalkan. Lihat log dengan `docker compose logs --tail=100 telegram_worker`.
