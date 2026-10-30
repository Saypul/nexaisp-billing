#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p backups
chmod 700 backups
file="backups/nexaisp-$(date +%Y%m%d-%H%M%S).sql"
docker compose exec -T db sh -c 'exec pg_dump --no-owner --no-acl -U "$POSTGRES_USER" "$POSTGRES_DB"' > "$file"
chmod 600 "$file"
echo "Database backup: $file"
