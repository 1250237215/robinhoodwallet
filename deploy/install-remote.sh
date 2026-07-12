#!/bin/bash

set -Eeuo pipefail

readonly service_name="robinhood-radar.service"
readonly app_dir="/opt/robinhood-radar"
readonly data_dir="/var/lib/robinhood-radar"
readonly database="$data_dir/robinhood.sqlite"
readonly unit_file="/etc/systemd/system/$service_name"
readonly staging_dir="/root/robinhood-radar-deploy"
readonly backup_root="/var/backups/robinhood-radar"
readonly stamp="$(date -u +%Y%m%dT%H%M%SZ)"
readonly database_backup="$backup_root/robinhood-$stamp.sqlite"
readonly release_backup="$backup_root/release-$stamp"

service_stopped=0
rollback_needed=0

rollback() {
  local exit_code=$?
  trap - EXIT

  if [[ $exit_code -ne 0 ]]; then
    echo "Deployment failed; restoring the previous Robinhood release." >&2
    if [[ $rollback_needed -eq 1 && -d "$release_backup" && -f "$database_backup" ]]; then
      systemctl stop "$service_name" || true
      install -m 0644 "$release_backup/robinhood-server.mjs" "$app_dir/robinhood-server.mjs"
      if [[ -f "$release_backup/robinhood-server.mjs.LEGAL.txt" ]]; then
        install -m 0644 "$release_backup/robinhood-server.mjs.LEGAL.txt" "$app_dir/robinhood-server.mjs.LEGAL.txt"
      fi
      rm -rf "$app_dir/public"
      cp -a "$release_backup/public" "$app_dir/public"
      install -m 0644 "$release_backup/robinhood-radar.service" "$unit_file"
      install -o robinhood-radar -g robinhood-radar -m 0644 "$database_backup" "$database"
      systemctl daemon-reload || true
      systemctl start "$service_name" || true
    elif [[ $service_stopped -eq 1 ]]; then
      systemctl start "$service_name" || true
    fi
  fi

  exit "$exit_code"
}

trap rollback EXIT

for file in \
  "$staging_dir/robinhood-server.mjs" \
  "$staging_dir/robinhood-server.mjs.LEGAL.txt" \
  "$staging_dir/robinhood-radar.service" \
  "$staging_dir/public.tar.gz"; do
  [[ -f "$file" ]] || { echo "Missing deployment file: $file" >&2; exit 1; }
done

install -d -m 0700 "$backup_root" "$release_backup"

systemctl stop "$service_name"
service_stopped=1

cp --preserve=mode,ownership,timestamps "$database" "$database_backup"
chmod 0600 "$database_backup"

quick_check="$(node --input-type=module -e '
  import { DatabaseSync } from "node:sqlite";
  const db = new DatabaseSync(process.argv[1], { readOnly: true });
  const rows = db.prepare("PRAGMA quick_check").all();
  db.close();
  console.log(rows.map((row) => Object.values(row)[0]).join("\n"));
' "$database_backup")"
[[ "$quick_check" == "ok" ]] || { echo "SQLite backup quick_check failed: $quick_check" >&2; exit 1; }

cp -a "$app_dir/public" "$release_backup/public"
install -m 0644 "$app_dir/robinhood-server.mjs" "$release_backup/robinhood-server.mjs"
if [[ -f "$app_dir/robinhood-server.mjs.LEGAL.txt" ]]; then
  install -m 0644 "$app_dir/robinhood-server.mjs.LEGAL.txt" "$release_backup/robinhood-server.mjs.LEGAL.txt"
fi
install -m 0644 "$unit_file" "$release_backup/robinhood-radar.service"
rollback_needed=1

node --input-type=module -e '
  import { DatabaseSync } from "node:sqlite";
  const db = new DatabaseSync(process.argv[1]);
  db.exec(`
    BEGIN;
    DROP TABLE IF EXISTS wallet_token_performance;
    DROP TABLE IF EXISTS history_scan_cursors;
    DELETE FROM wallet_summaries;
  `);
  db.prepare("DELETE FROM jobs WHERE id = ?").run("history:wallets");
  db.prepare("DELETE FROM metadata WHERE key LIKE ?").run("robinhood:history:%");
  db.exec("COMMIT");
  db.close();
' "$database"

install -m 0644 "$staging_dir/robinhood-server.mjs" "$app_dir/robinhood-server.mjs"
install -m 0644 "$staging_dir/robinhood-server.mjs.LEGAL.txt" "$app_dir/robinhood-server.mjs.LEGAL.txt"

rm -rf "$app_dir/public.new"
install -d -m 0755 "$app_dir/public.new"
tar -xzf "$staging_dir/public.tar.gz" -C "$app_dir/public.new"
chown -R root:root "$app_dir/public.new"
find "$app_dir/public.new" -type d -exec chmod 0755 {} +
find "$app_dir/public.new" -type f -exec chmod 0644 {} +

rm -rf "$app_dir/public.previous"
mv "$app_dir/public" "$app_dir/public.previous"
mv "$app_dir/public.new" "$app_dir/public"

install -m 0644 "$staging_dir/robinhood-radar.service" "$unit_file"
systemctl daemon-reload
systemctl start "$service_name"
service_stopped=0

health_file="$(mktemp)"
for attempt in $(seq 1 20); do
  if curl --fail --silent --show-error \
    "http://127.0.0.1:18118/api/robinhood/dashboard?tab=all" \
    > "$health_file"; then
    break
  fi
  if [[ $attempt -eq 20 ]]; then
    echo "Robinhood health check did not become ready." >&2
    exit 1
  fi
  sleep 1
done

node --input-type=module -e '
  import fs from "node:fs";
  const dashboard = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (dashboard.mode !== "manual-only") throw new Error("manual-only mode is not active");
  if (dashboard.discoveryEnabled !== false) throw new Error("automatic discovery is still enabled");
  if (Number(dashboard.filters?.minEntryUsd) !== 500) throw new Error("500 USD entry floor is not active");
  if (Object.hasOwn(dashboard, "history")) throw new Error("removed wallet-history payload is still exposed");
  if (Object.keys(dashboard.filters || {}).some((key) => key.startsWith("history"))) {
    throw new Error("removed history filters are still exposed");
  }
  if ((dashboard.jobs || []).some((job) => job.id === "history:wallets" || job.type === "wallet_history")) {
    throw new Error("removed wallet-history job is still exposed");
  }
  if ((dashboard.winners || []).some((token) => token.manual !== true)) {
    throw new Error("legacy automatic tokens are visible");
  }
  console.log(JSON.stringify({
    status: dashboard.status,
    mode: dashboard.mode,
    discoveryEnabled: dashboard.discoveryEnabled,
    minEntryUsd: dashboard.filters?.minEntryUsd,
    wallets: dashboard.wallets?.length || 0,
    winners: dashboard.winners?.length || 0
  }));
' "$health_file"

removed_history_status="$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --request POST "http://127.0.0.1:18118/api/robinhood/jobs/history")"
[[ "$removed_history_status" == "404" ]] || {
  echo "Removed wallet-history endpoint returned HTTP $removed_history_status instead of 404." >&2
  exit 1
}

monitor_health_file="$(mktemp)"
curl --fail --silent --show-error \
  "http://127.0.0.1:18118/api/robinhood/monitor" \
  > "$monitor_health_file"
node --input-type=module -e '
  import fs from "node:fs";
  const monitor = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (!monitor.settings || !Number.isInteger(Number(monitor.settings.threshold))) {
    throw new Error("monitor threshold is unavailable");
  }
  if (!monitor.health || monitor.health.running !== true) {
    throw new Error("wallet monitor is not running");
  }
  console.log(JSON.stringify({
    monitorStatus: monitor.status,
    monitorEnabled: monitor.settings.enabled,
    threshold: monitor.settings.threshold,
    monitoredWallets: monitor.health.monitoredWallets || 0
  }));
' "$monitor_health_file"

systemctl is-active --quiet "$service_name"
rm -f "$health_file" "$monitor_health_file"
rm -rf "$app_dir/public.previous" "$staging_dir"
rollback_needed=0

echo "database_backup=$database_backup"
echo "release_backup=$release_backup"
echo "service_status=$(systemctl is-active "$service_name")"

trap - EXIT
