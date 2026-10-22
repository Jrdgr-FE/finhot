#!/bin/bash
set -euo pipefail
umask 077
target="/var/lib/finhot/backups/finhot-$(date -u +%Y%m%dT%H%M%SZ).dump"
/usr/lib/postgresql/18/bin/pg_dump --format=custom --file="$target" "$DATABASE_URL"
/usr/lib/postgresql/18/bin/pg_restore --list "$target" >/dev/null
# Only expire this application's own dumps after a new verified backup exists.
find /var/lib/finhot/backups -maxdepth 1 -type f -name 'finhot-*.dump' -mmin +10080 -delete
printf 'Backup verified: %s\n' "$(basename "$target")"
