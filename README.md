# NexaISP Billing v0.1.0 — Core Billing MVP

Sistem **multi-service ISP billing** yang berjalan melalui Docker Compose, dengan tampilan dashboard navy/turquoise mengikuti preview NexaISP sebelumnya.

**Status:** implementasi awal untuk uji internal. *Belum production-ready* untuk tagihan riil tanpa penyesuaian pajak, pembayaran, kontrak, migrasi DB, backup terjadwal, observability, audit trail, serta pengujian staging.

## Isi rilis v0.1.0

- **Web Admin responsif:** login, dashboard live database, pelanggan Residential/Business/Corporate, paket FTTH/Metro-E/VPN/Dedicated, subscription dan circuit ID.
- **Core Billing:** satu pelanggan bisa mempunyai beberapa subscription; satu invoice gabungan per pelanggan/periode; line item snapshot; perhitungan MRC; proteksi duplikasi invoice.
- **Pembayaran manual:** transfer, cash, QRIS manual (catat bukti transaksi sendiri), pembayaran parsial, status lunas otomatis setelah total diterima. **Tidak melakukan settlement ke gateway.**
- **Security baseline:** Argon2 untuk password, token JWT kedaluwarsa 8 jam, API membutuhkan autentikasi admin, Nginx login rate limit, PostgreSQL tidak dipublikasikan, frontend hanya bind ke localhost secara default.
- **Sumber data:** data riil dari PostgreSQL, bukan angka palsu. Demo seed tersedia opsional.
- **Work Order Telegram:** ticket dapat ditugaskan ke User ID teknisi; admin dan teknisi mencatat progres dengan riwayat aktor. Menu Telegram menampilkan Bot ID dan mengatur token bot; n8n tersedia pada port 5679 untuk alur notifikasi setelah workflow dikonfigurasi.

**Belum tersedia:** FreeRADIUS, NAS monitoring SNMP, IPAM/OLT provisioning, payment gateway, perpajakan, prorata, kontrak & SLA, role multiuser, portal pelanggan login, mobile native APK.

## Integrasi MikroTik (v0.3.0)

Backend terhubung ke router MikroTik lewat **RouterOS classic API** (port 8728, atau 8729 dengan TLS; RouterOS v6.43+ dan v7). Menu **Network & RADIUS**:

- **Router:** tambah NAS/BRAS (password API disimpan terenkripsi), uji koneksi (identity, versi, CPU, jumlah sesi PPP), lihat sesi PPP aktif yang dicocokkan ke pelanggan.
- **Pemetaan layanan:** tiap layanan dipetakan ke satu router + username PPPoE (default = Service ID; password dibuat otomatis bila kosong). NOC juga bisa memilih router saat aktivasi ticket; secret dibuat setelah aktivasi tersimpan.
- **Provisioning:** PPP secret dibuat/diperbarui (`service=pppoe`, profile dari kolom *PPP Profile* paket di Katalog; kosong = `default`).
- **Isolir manual:** mengubah status layanan ke Suspended/Terminasi meng-isolir (disable secret, atau pindah ke profile isolir per router) dan memutus sesi aktif; status Aktif memulihkan.
- **Isolir otomatis (nonaktif secara default):** setiap jam, layanan aktif yang terpetakan dengan invoice belum lunas melewati toleransi hari akan diisolir, dibatasi maksimal N per putaran. Pelunasan membuka isolir tunggakan segera. Isolir manual oleh admin tidak dibuka oleh pembayaran. Selalu cek **pratinjau** sebelum mengaktifkan.
- **Audit:** setiap aksi router (termasuk gagal) dan setiap akses kredensial PPPoE tercatat di log audit.

Kegagalan router tidak pernah membatalkan aktivasi, perubahan status, atau pembayaran; layanan ditandai *Gagal sinkron* dan bisa di-*Provision ulang*.

Saran keamanan di router: buat user khusus, misalnya `/user group add name=nexaisp policy=read,write,api,test` lalu `/user add name=nexaisp group=nexaisp address=<IP server billing>`, batasi `/ip service set api address=<IP server billing>`, dan pakai `api-ssl` bila melewati jaringan yang tidak tepercaya.

## Deploy Ubuntu 22.04 / 24.04 (Docker Compose 2.x)

1. Pasang Docker Engine dan Docker Compose plugin jika belum tersedia.
2. Unggah `nexaisp-billing-v0.1.0.zip` ke server lalu jalankan `sudo unzip nexaisp-billing-v0.1.0.zip -d /opt` (arsip membuat folder `/opt/nexaisp-billing`). Jangan taruh di dalam project ZTE NMS agar container/volume terpisah.
3. Jalankan:

```bash
cd /opt/nexaisp-billing
chmod +x setup.sh scripts/backup.sh scripts/smoke.sh
./setup.sh
# Catat password admin yang dicetak ke terminal.
docker compose up -d --build
docker compose ps
./scripts/smoke.sh  # memeriksa Compose, container, dan API health
```

Port default: **3100/TCP**, bind **127.0.0.1** (hanya localhost) agar aman untuk pengujian. Database hanya berada di dalam Docker network; backend tidak mempublikasikan port host.

### Akses dari laptop (rekomendasi pengujian)

Di terminal laptop/PC (sesuaikan IP server):

```bash
ssh -L 3100:127.0.0.1:3100 root@IP_SERVER
```

Buka **http://localhost:3100**, login menggunakan `ADMIN_EMAIL` dan `ADMIN_PASSWORD` yang ditampilkan oleh `./setup.sh`/tersimpan pada `.env` server. Jangan mengirim `.env` ke pihak lain.

**Untuk domain produksi**, gunakan reverse proxy HTTPS + firewall/VPN, rate limiting dan keamanan akses jaringan. Jangan langsung membuka UI HTTP beserta sesi autentikasi ke Internet. `BIND_IP=0.0.0.0` hanya jika Anda memahami konsekuensi akses publik/LAN; disarankan tetap localhost di belakang reverse proxy HTTPS.

### Setelah login

1. **Pelanggan** → tambah Residential, Business, atau Corporate; ID pelanggan numerik 10 digit dan ticket onboarding dibuat otomatis. Paket layanan pertama boleh dipilih saat pendaftaran.
2. **Katalog Layanan** → tambah paket FTTH, Metro-E, VPN, Dedicated; tetapkan MRC dan OTC sebagai harga awal.
3. **Ticketing / Work Order** → catat progres Open → Survey → Instalasi → Siap Aktivasi → Closed; tugaskan teknisi memakai Telegram User ID, dan lihat riwayat perubahan. Teknisi yang ditugaskan dapat mengubah status dari chat pribadi bot. Paket, prepaid/postpaid, MRC, OTC, dan cara invoice dapat diatur sebelum penutupan. Layanan tetap pending sampai ticket Closed. [Panduan setup Telegram dan n8n](automation/README.md).
4. **Layanan Aktif** → tampilkan layanan yang sudah diaktivasi melalui ticketing. Layanan tambahan dibuat sebagai ticket baru. Service ID Metro Ethernet baru memakai awalan `ETH-`.
5. **Billing & Invoices** → layanan dapat memilih invoice Manual atau Otomatis; FTTH baru default Otomatis. Invoice Manual dibuat dari tombol, sedangkan invoice Otomatis dicoba saat backend mulai dan setiap jam untuk periode berjalan. Jatuh tempo otomatis adalah tanggal 20 atau 7 hari sejak dibuat, mana yang lebih akhir. Pembayaran tetap dicatat manual.

Invoice dikelompokkan per pelanggan, bulan, dan cara pembuatan. Bila layanan baru aktif setelah invoice bulan itu dibuat, item baru ditambahkan ke invoice yang belum dibayar; jika sudah ada pembayaran, sistem membuat invoice susulan. **Prepaid** menagih MRC bulan invoice; **postpaid** menagih MRC bulan sebelumnya. OTC registrasi/instalasi ditagih sekali pada invoice pertama layanan. Setelah invoice dibuat, perubahan layanan tidak mengubah nominal item historis. Penghapusan invoice hanya untuk invoice tanpa pembayaran; penghapusan pelanggan atau layanan yang sudah direferensikan invoice dibatasi. Saat backend mulai, layanan lama memakai prepaid dan invoice Manual agar periode tagihannya tetap, dan kode pelanggan lama yang nonnumerik diganti ID numerik. Pajak, diskon, prorata, dan SLA credits belum dihitung.

### Demo data (hanya server uji dengan database kosong)

```bash
docker compose exec -e DEMO_SEED_ALLOWED=1 backend python -m app.seed_demo
```

Demo menambahkan pelanggan fiktif, paket semua kategori, contoh 1 pelanggan corporate dengan beberapa layanan, serta invoice dan pembayaran contoh. Seed diblokir jika sudah ada pelanggan.

### Operasional

```bash
cd /opt/nexaisp-billing
docker compose ps
docker compose logs -f --tail=100 backend
docker compose logs -f --tail=100 frontend
./scripts/backup.sh             # Simpan dump SQL ke backups/ (jangan unggah ke publik)
docker compose up -d --build     # Update aplikasi
docker compose down              # Stop tanpa menghapus data
```

**Jangan jalankan `docker compose down -v` di server berdata**, karena volume PostgreSQL akan terhapus.

### Ubah password administrator

Edit `ADMIN_PASSWORD=` pada `.env` dengan password baru minimal 12 karakter, kemudian:

```bash
docker compose up -d --force-recreate backend
```

Password user admin awal diselaraskan ulang dari environment saat container backend mulai; setelah restart hanya password baru yang diterima untuk login baru (JWT aktif yang sudah diterbitkan tetap hidup sampai expiry 8 jam). Untuk produksi, implementasikan revocation token dan manajemen akun/role.

### Restore database (hanya jika dibutuhkan dan dengan backup terverifikasi)

Hentikan aktivitas write aplikasi lebih dulu dan gunakan salinan/staging sebelum melakukan restore. Contoh restore ke database **kosong**:

```bash
cat backups/nexaisp-YYYYMMDD-HHMMSS.sql | docker compose exec -T db sh -c 'exec psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" "$POSTGRES_DB"'
```

Jangan restore dump ke database berisi data aktif tanpa prosedur migrasi/restore yang aman.

## Arsitektur

```text
Web Admin (React/Vite → Nginx :8080 container; host localhost:3100)
       |
       +-- /api/* -> FastAPI :8000 (internal Docker network)
                         |
                         +-- PostgreSQL 16 (persistent Docker volume)
```

Network adapter RADIUS/Juniper/Huawei/OLT, portal customer dan mobile Android/iOS dipisahkan sebagai milestone berikutnya.

## Keamanan dan keterbatasan

- `setup.sh` membuat secret database/JWT/admin secara acak dan menaruhnya di `.env` (mode 0600).
- Jangan commit `.env`, expose database PostgreSQL, atau gunakan kredensial produksi di demo seed.
- MVP menggunakan `Base.metadata.create_all()` untuk bootstrap skema. Versi lanjut harus memakai Alembic migrations.
- Billing generation adalah tombol manual, bukan task scheduler. Metode QRIS **manual** bukan bukti settlement otomatis.
- JWT disimpan di `sessionStorage` browser; hardening CSP, audit log, RBAC, MFA, session revocation, backup offsite, monitoring dan pengetesan penetration/security perlu untuk produksi.
- Frontend Docker build mengunduh dependensi npm saat deploy; backend mengunduh dependensi pip saat build. Server memerlukan akses ke registry Docker, npm dan PyPI.

## Testing yang sudah dijalankan sebelum paket ini dikirim

- Syntax check backend menggunakan `python -m compileall`.
- FastAPI integration smoke test dengan SQLite terisolasi (`backend/tests/test_flows.py`) untuk login, otorisasi, pelanggan corporate, dua produk, subscription, invoice idempotent, invoice gabungan, partial payment, pembayaran duplikat dan dashboard.
- Docker image build, PostgreSQL integration, dan build frontend Vite **belum dapat diuji di lingkungan pembuatan paket** (tidak tersedia Docker dan registry npm tidak merespons). Jalankan smoke test sesudah deployment pada server Anda.
