#!/usr/bin/env bash

set -Eeuo pipefail

readonly retention_minutes="${ROBINHOOD_BACKUP_RETENTION_MINUTES:-2880}"
readonly backup_root="${ROBINHOOD_BACKUP_ROOT:-/var/backups/robinhood-radar}"
readonly lock_file="${ROBINHOOD_BACKUP_RETENTION_LOCK_FILE:-/run/robinhood-backup-retention.lock}"

[[ "$retention_minutes" =~ ^[1-9][0-9]*$ ]] || {
  echo "ROBINHOOD_BACKUP_RETENTION_MINUTES must be a positive integer." >&2
  exit 1
}
[[ -d "$backup_root" ]] || {
  echo "Skipping missing Robinhood backup directory: $backup_root"
  exit 0
}

canonical_root="$(realpath -- "$backup_root")"
case "$canonical_root" in
  /|/var|/var/backups)
    echo "Refusing unsafe backup root: $canonical_root" >&2
    exit 1
    ;;
esac

install -d -m 0755 "$(dirname "$lock_file")"
if ! mkdir "$lock_file" 2>/dev/null; then
  echo "Robinhood backup retention is already running; skipping this pass."
  exit 0
fi
trap 'rmdir "$lock_file" 2>/dev/null || true' EXIT

before_kib="$(du -sk -- "$canonical_root" | awk 'NR == 1 { print $1 }')"
deleted=0
while IFS= read -r -d '' candidate; do
  name="$(basename -- "$candidate")"
  [[ "$name" == stable-* ]] && continue
  rm -rf -- "$candidate"
  deleted=$((deleted + 1))
done < <(
  find -P "$canonical_root" -mindepth 1 -maxdepth 1 -xdev \
    -mmin "+${retention_minutes}" ! -name 'stable-*' -print0
)
after_kib="$(du -sk -- "$canonical_root" | awk 'NR == 1 { print $1 }')"

printf 'Robinhood backup retention: root=%s deleted=%d freed_kib=%d retained_minutes=%d\n' \
  "$canonical_root" "$deleted" "$((before_kib - after_kib))" "$retention_minutes"
