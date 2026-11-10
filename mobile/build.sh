#!/usr/bin/env bash
# Build APK pelanggan. Pemakaian: ./build.sh [URL server] [versi]   (default http://192.168.60.4:3100 1.0.0)
# APK membuka <URL>/portal. Versi x.y.z menjadi versionCode x*10000+y*100+z; naikkan tiap rilis agar bisa dipasang sebagai update.
set -euo pipefail
cd "$(dirname "$0")"
URL="${1:-http://192.168.60.4:3100}"
URL="${URL%/}"
VERSION="${2:-1.0.0}"
[[ "$VERSION" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || { echo "Versi harus berformat x.y.z" >&2; exit 1; }
CODE=$(( BASH_REMATCH[1] * 10000 + BASH_REMATCH[2] * 100 + BASH_REMATCH[3] ))
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
printf "window.NEXAISP_URL = '%s/portal';\n" "$URL" > www/config.js
[[ -d android ]] || npx cap add android
npx cap sync android
./android-setup.sh
sed -i -E "s/versionCode [0-9]+/versionCode $CODE/; s/versionName \"[^\"]*\"/versionName \"$VERSION\"/" android/app/build.gradle
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
cp android/app/build/outputs/apk/release/app-release.apk "dist/nexaisp-pelanggan-v$VERSION.apk"
echo "APK: $(pwd)/dist/nexaisp-pelanggan-v$VERSION.apk  (versi $VERSION/$CODE, server: $URL/portal)"
