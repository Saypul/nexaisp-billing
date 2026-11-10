#!/usr/bin/env bash
# Penyesuaian proyek Android setelah `cap add/sync`: ikon NexaISP dan izin HTTP (hanya bila URL server http://).
set -euo pipefail
cd "$(dirname "$0")"
RES=android/app/src/main/res
node icons.cjs "$RES"
printf '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#0E8495</color>\n</resources>\n' > "$RES/values/ic_launcher_background.xml"
MANIFEST=android/app/src/main/AndroidManifest.xml
if grep -q '"cleartext": true' capacitor.config.json; then
  grep -q usesCleartextTraffic "$MANIFEST" || sed -i 's#<application#<application android:usesCleartextTraffic="true"#' "$MANIFEST"
else
  sed -i 's# android:usesCleartextTraffic="true"##' "$MANIFEST"
fi
