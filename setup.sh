#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ -e .env ]]; then
  echo 'File .env sudah ada. Tidak ditimpa.'
  exit 0
fi
command -v python3 >/dev/null || { echo 'python3 diperlukan untuk menyiapkan konfigurasi'; exit 1; }
python3 - <<'PY'
import secrets
from pathlib import Path
password = secrets.token_urlsafe(22)
secret = secrets.token_urlsafe(48)
admin_password = secrets.token_urlsafe(15)
text = f'''# Dihasilkan lokal; JANGAN commit ke Git / kirim ke publik.
POSTGRES_DB=nexaisp
POSTGRES_USER=nexaisp
POSTGRES_PASSWORD={password}
JWT_SECRET={secret}
ADMIN_EMAIL=admin@nexaisp.local
ADMIN_PASSWORD={admin_password}
# Akses lokal; untuk produksi gunakan reverse-proxy HTTPS.
BIND_IP=127.0.0.1
WEB_PORT=3100
'''
Path('.env').write_text(text)
Path('.env').chmod(0o600)
print('Konfigurasi .env berhasil dibuat.')
print('Admin: admin@nexaisp.local')
print('Password awal:', admin_password)
print('Simpan kredensial ini. Ubah sebelum penggunaan produksi.')
PY
