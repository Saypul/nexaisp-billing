#!/usr/bin/env bash
# Build APK pelanggan. Pemakaian: ./build.sh [URL server]   (default http://192.168.60.4:3100)
# APK membuka <URL>/portal; ganti URL ke domain HTTPS sebelum dibagikan ke pelanggan di luar jaringan lokal.
set -euo pipefail
cd "$(dirname "$0")"
URL="${1:-http://192.168.60.4:3100}"
URL="${URL%/}"
CLEARTEXT=false; [[ "$URL" == http://* ]] && CLEARTEXT=true
HOST="$(echo "$URL" | sed -E 's#^[a-z]+://([^/:]+).*#\1#')"
cat > capacitor.config.json <<JSON
{
  "appId": "id.nexaisp.pelanggan",
  "appName": "NexaISP Pelanggan",
  "webDir": "www",
  "server": {"url": "$URL/portal", "cleartext": $CLEARTEXT, "allowNavigation": ["$HOST"], "errorPath": "index.html"},
  "android": {"allowMixedContent": false}
}
JSON
sed -i "s#window.NEXAISP_URL||'/'#'$URL/portal'#" www/index.html
[[ -d android ]] || npx cap add android
npx cap sync android
./android-setup.sh
export ANDROID_HOME="${ANDROID_HOME:-/opt/android-sdk}"
# Kunci tanda tangan dibuat sekali. Update APK hanya bisa dipasang bila ditandatangani kunci yang SAMA.
KS=keystore/nexaisp-pelanggan.jks
if [[ ! -f $KS ]]; then
  mkdir -p keystore && chmod 700 keystore
  head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' > keystore/password.txt
  chmod 600 keystore/password.txt
  keytool -genkeypair -keystore "$KS" -storepass "$(cat keystore/password.txt)" -keypass "$(cat keystore/password.txt)" \
    -alias nexaisp -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=NexaISP Pelanggan, O=NexaISP, C=ID" >/dev/null
  echo "Keystore baru dibuat di mobile/$KS. SIMPAN CADANGANNYA (beserta keystore/password.txt)."
fi
PW="$(cat keystore/password.txt)"
(cd android && ./gradlew --no-daemon -q assembleRelease \
  -Pandroid.injected.signing.store.file="$(pwd)/../$KS" -Pandroid.injected.signing.store.password="$PW" \
  -Pandroid.injected.signing.key.alias=nexaisp -Pandroid.injected.signing.key.password="$PW")
mkdir -p dist
cp android/app/build/outputs/apk/release/app-release.apk "dist/nexaisp-pelanggan.apk"
echo "APK: $(pwd)/dist/nexaisp-pelanggan.apk  (server: $URL/portal)"
