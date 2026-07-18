#!/usr/bin/env bash

set -Eeuo pipefail

readonly retention_minutes=2880
readonly lock_file="${DQDAI_RETENTION_LOCK_FILE:-/run/dqdai-prediction-backup-retention.lock}"
readonly default_backup_dirs=(
  "/opt/dqdai-1/site/assets/prediction_backups"
  "/opt/dqdai-2/site/assets/prediction_backups"
  "/opt/dqdai-3/site/assets/prediction_backups"
)

backup_dirs=("${default_backup_dirs[@]}")
if [[ -n "${DQDAI_PREDICTION_BACKUP_DIRS:-}" ]]; then
  IFS=: read -r -a backup_dirs <<< "$DQDAI_PREDICTION_BACKUP_DIRS"
fi

install -d -m 0755 "$(dirname "$lock_file")"
exec 9>"$lock_file"
if ! flock -n 9; then
  echo "Prediction backup retention is already running; skipping this pass."
  exit 0
fi

for backup_dir in "${backup_dirs[@]}"; do
  if [[ ! -d "$backup_dir" ]]; then
    echo "Skipping missing prediction backup directory: $backup_dir"
    continue
  fi

  before_bytes="$(du -sb -- "$backup_dir" | awk 'NR == 1 { print $1 }')"
  stale_count="$(find -P "$backup_dir" -maxdepth 1 -xdev -type f \
    -name 'all_predictions-*.json' -mmin "+${retention_minutes}" -print | wc -l)"

  if (( stale_count > 0 )); then
    find -P "$backup_dir" -maxdepth 1 -xdev -type f \
      -name 'all_predictions-*.json' -mmin "+${retention_minutes}" -delete
  fi

  after_bytes="$(du -sb -- "$backup_dir" | awk 'NR == 1 { print $1 }')"
  freed_bytes=$((before_bytes - after_bytes))
  printf 'Prediction backup retention: dir=%s deleted=%d freed_bytes=%d retained_minutes=%d\n' \
    "$backup_dir" "$stale_count" "$freed_bytes" "$retention_minutes"
done
