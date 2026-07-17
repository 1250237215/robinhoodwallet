#!/bin/bash

set -Eeuo pipefail

readonly app_dir="/opt/robinhood-radar"
readonly data_dir="/var/lib/robinhood-radar"
readonly staging_dir="/root/robinhood-radar-deploy"
readonly backup_root="/var/backups/robinhood-radar"
readonly stamp="$(date -u +%Y%m%dT%H%M%SZ)"
readonly release_backup="$backup_root/release-$stamp"
readonly caddy_config="/etc/caddy/Caddyfile"
readonly allow_solana_degraded="${ALLOW_SOLANA_DEGRADED:-0}"
readonly services=("robinhood-radar" "base-radar" "solana-radar")
readonly chains=("robinhood" "base" "solana")

declare -A was_active=()
declare -A unit_existed=()
rollback_needed=0
caddy_changed=0
caddy_candidate=""

[[ "$allow_solana_degraded" == "0" || "$allow_solana_degraded" == "1" ]] || {
  echo "ALLOW_SOLANA_DEGRADED must be 0 or 1." >&2
  exit 1
}

database_path() {
  echo "$data_dir/$1.sqlite"
}

database_backup_path() {
  echo "$backup_root/$1-$stamp.sqlite"
}

social_database_path() {
  echo "$data_dir/social.sqlite"
}

social_database_backup_path() {
  echo "$backup_root/social-$stamp.sqlite"
}

unit_path() {
  echo "/etc/systemd/system/$1.service"
}

bundle_path() {
  echo "$app_dir/$1-server.mjs"
}

quick_check_database() {
  local database="$1"
  local result
  result="$(node --input-type=module -e '
    import { DatabaseSync } from "node:sqlite";
    const db = new DatabaseSync(process.argv[1], { readOnly: true });
    const rows = db.prepare("PRAGMA quick_check").all();
    db.close();
    console.log(rows.map((row) => Object.values(row)[0]).join("\n"));
  ' "$database")"
  [[ "$result" == "ok" ]] || {
    echo "SQLite quick_check failed for $database: $result" >&2
    return 1
  }
}

backup_optional_file() {
  local source="$1"
  local destination="$2"
  if [[ -f "$source" ]]; then
    cp --preserve=mode,ownership,timestamps "$source" "$destination"
  else
    touch "$destination.missing"
  fi
}

restore_optional_file() {
  local backup="$1"
  local destination="$2"
  if [[ -f "$backup.missing" ]]; then
    rm -f "$destination"
  elif [[ -f "$backup" ]]; then
    install -m 0644 "$backup" "$destination"
  fi
}

rollback() {
  local exit_code=$?
  trap - EXIT
  rm -f "${caddy_candidate:-}"

  if [[ $exit_code -ne 0 ]]; then
    echo "Deployment failed; restoring the previous three-chain release." >&2
    if [[ $rollback_needed -eq 1 && -d "$release_backup" ]]; then
      for service in "${services[@]}"; do
        systemctl stop "$service.service" 2>/dev/null || true
      done

      for chain in "${chains[@]}"; do
        restore_optional_file "$release_backup/$chain-server.mjs" "$(bundle_path "$chain")"
        restore_optional_file "$release_backup/$chain-server.mjs.LEGAL.txt" "$(bundle_path "$chain").LEGAL.txt"
        restore_optional_file "$release_backup/$chain-radar.service" "$(unit_path "$chain-radar")"

        local database
        local backup
        database="$(database_path "$chain")"
        backup="$(database_backup_path "$chain")"
        if [[ -f "$backup.missing" ]]; then
          rm -f "$database"
        elif [[ -f "$backup" ]]; then
          install -o robinhood-radar -g robinhood-radar -m 0640 "$backup" "$database"
        fi
      done

      local social_database
      local social_backup
      social_database="$(social_database_path)"
      social_backup="$(social_database_backup_path)"
      if [[ -f "$social_backup.missing" ]]; then
        rm -f "$social_database"
      elif [[ -f "$social_backup" ]]; then
        install -o robinhood-radar -g robinhood-radar -m 0640 "$social_backup" "$social_database"
      fi

      if [[ -d "$release_backup/public" ]]; then
        rm -rf "$app_dir/public"
        cp -a "$release_backup/public" "$app_dir/public"
      fi
      restore_optional_file "$release_backup/REVISION" "$app_dir/REVISION"

      if [[ $caddy_changed -eq 1 ]]; then
        restore_optional_file "$release_backup/Caddyfile" "$caddy_config"
        caddy validate --config "$caddy_config" --adapter caddyfile || true
        systemctl reload caddy.service || true
      fi

      systemctl daemon-reload || true
      for service in "${services[@]}"; do
        if [[ "${was_active[$service]:-0}" == "1" ]]; then
          systemctl start "$service.service" || true
        fi
      done
    else
      for service in "${services[@]}"; do
        if [[ "${was_active[$service]:-0}" == "1" ]]; then
          systemctl start "$service.service" || true
        fi
      done
    fi
  fi

  exit "$exit_code"
}

trap rollback EXIT

for file in \
  "$staging_dir/robinhood-server.mjs" \
  "$staging_dir/base-server.mjs" \
  "$staging_dir/solana-server.mjs" \
  "$staging_dir/robinhood-radar.service" \
  "$staging_dir/base-radar.service" \
  "$staging_dir/solana-radar.service" \
  "$staging_dir/public.tar.gz"; do
  [[ -f "$file" ]] || { echo "Missing deployment file: $file" >&2; exit 1; }
done

install -d -m 0700 "$backup_root" "$release_backup"
install -d -o robinhood-radar -g robinhood-radar -m 0750 "$data_dir"
backup_optional_file "$caddy_config" "$release_backup/Caddyfile"
backup_optional_file "$app_dir/REVISION" "$release_backup/REVISION"

for service in "${services[@]}"; do
  if systemctl is-active --quiet "$service.service" 2>/dev/null; then
    was_active[$service]=1
  else
    was_active[$service]=0
  fi
  if [[ -f "$(unit_path "$service")" ]]; then
    unit_existed[$service]=1
  else
    unit_existed[$service]=0
  fi
  if [[ "${unit_existed[$service]}" == "1" ]]; then
    systemctl stop "$service.service"
    systemctl is-active --quiet "$service.service" && {
      echo "$service.service did not stop cleanly." >&2
      exit 1
    }
  else
    systemctl stop "$service.service" 2>/dev/null || true
  fi
done

for chain in "${chains[@]}"; do
  database="$(database_path "$chain")"
  database_backup="$(database_backup_path "$chain")"
  if [[ -f "$database" ]]; then
    cp --preserve=mode,ownership,timestamps "$database" "$database_backup"
    chmod 0600 "$database_backup"
    quick_check_database "$database_backup"
  else
    touch "$database_backup.missing"
  fi

  backup_optional_file "$(bundle_path "$chain")" "$release_backup/$chain-server.mjs"
  backup_optional_file "$(bundle_path "$chain").LEGAL.txt" "$release_backup/$chain-server.mjs.LEGAL.txt"
  backup_optional_file "$(unit_path "$chain-radar")" "$release_backup/$chain-radar.service"
done

social_database="$(social_database_path)"
social_database_backup="$(social_database_backup_path)"
if [[ -f "$social_database" ]]; then
  cp --preserve=mode,ownership,timestamps "$social_database" "$social_database_backup"
  chmod 0600 "$social_database_backup"
  quick_check_database "$social_database_backup"
else
  touch "$social_database_backup.missing"
fi
cp -a "$app_dir/public" "$release_backup/public"
rollback_needed=1

if [[ -f "$staging_dir/REVISION" ]]; then
  install -m 0644 "$staging_dir/REVISION" "$app_dir/REVISION"
fi

for chain in "${chains[@]}"; do
  install -m 0644 "$staging_dir/$chain-server.mjs" "$(bundle_path "$chain")"
  if [[ -f "$staging_dir/$chain-server.mjs.LEGAL.txt" ]]; then
    install -m 0644 "$staging_dir/$chain-server.mjs.LEGAL.txt" "$(bundle_path "$chain").LEGAL.txt"
  else
    rm -f "$(bundle_path "$chain").LEGAL.txt"
  fi
  install -m 0644 "$staging_dir/$chain-radar.service" "$(unit_path "$chain-radar")"
done

rm -rf "$app_dir/public.new"
install -d -m 0755 "$app_dir/public.new"
tar -xzf "$staging_dir/public.tar.gz" -C "$app_dir/public.new"
chown -R root:root "$app_dir/public.new"
find "$app_dir/public.new" -type d -exec chmod 0755 {} +
find "$app_dir/public.new" -type f -exec chmod 0644 {} +

rm -rf "$app_dir/public.previous"
mv "$app_dir/public" "$app_dir/public.previous"
mv "$app_dir/public.new" "$app_dir/public"

systemctl daemon-reload
for service in "${services[@]}"; do
  systemctl start "$service.service"
done

declare -A ports=([robinhood]=18118 [base]=18119 [solana]=18120)
for chain in "${chains[@]}"; do
  health_file="$(mktemp)"
  for attempt in $(seq 1 30); do
    if curl --fail --silent --show-error \
      "http://127.0.0.1:${ports[$chain]}/api/$chain/dashboard?tab=all" \
      > "$health_file"; then
      break
    fi
    if [[ $attempt -eq 30 ]]; then
      echo "$chain health check did not become ready." >&2
      exit 1
    fi
    sleep 1
  done

  node --input-type=module -e '
    import fs from "node:fs";
    const expectedChain = process.argv[2];
    const dashboard = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (dashboard.chain !== expectedChain) throw new Error(`wrong chain: ${dashboard.chain}`);
    if (dashboard.mode !== "manual-only") throw new Error("manual-only mode is not active");
    if (dashboard.discoveryEnabled !== false) throw new Error("automatic discovery is still enabled");
    if (Object.hasOwn(dashboard, "history")) throw new Error("removed wallet-history payload is exposed");
    if (Object.keys(dashboard.filters || {}).some((key) => key.startsWith("history"))) {
      throw new Error("removed history filters are exposed");
    }
    if ((dashboard.jobs || []).some((job) => job.id === "history:wallets" || job.type === "wallet_history")) {
      throw new Error("removed wallet-history job is exposed");
    }
    if ((dashboard.winners || []).some((token) => token.manual !== true)) {
      throw new Error("legacy automatic tokens are visible");
    }
  ' "$health_file" "$chain"
  rm -f "$health_file"

  monitor_file="$(mktemp)"
  curl --fail --silent --show-error \
    "http://127.0.0.1:${ports[$chain]}/api/$chain/monitor" \
    > "$monitor_file"
  node --input-type=module -e '
    import fs from "node:fs";
    const expectedChain = process.argv[2];
    const allowSolanaDegraded = process.argv[3] === "1";
    const monitor = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (monitor.chain !== expectedChain) throw new Error(`wrong monitor chain: ${monitor.chain}`);
    if (!monitor.settings || !Number.isInteger(Number(monitor.settings.threshold))) {
      throw new Error("monitor threshold is unavailable");
    }
    if (!monitor.health || typeof monitor.status !== "string") {
      throw new Error("monitor health is unavailable");
    }
    if (expectedChain === "solana" && monitor.health.realtimeReady !== true && !allowSolanaDegraded) {
      throw new Error(`Solana real-time provider is not ready: ${(monitor.health.reasons || []).join(",")}`);
    }
  ' "$monitor_file" "$chain" "$allow_solana_degraded"
  if [[ "$chain" == "solana" && "$allow_solana_degraded" == "1" ]]; then
    node --input-type=module -e '
      import fs from "node:fs";
      const monitor = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (monitor.health?.realtimeReady !== true) {
        console.error(`WARNING: Solana deployed in explicit degraded mode: ${(monitor.health?.reasons || []).join(",")}`);
      }
    ' "$monitor_file"
  fi
  rm -f "$monitor_file"

  removed_status="$(curl --silent --output /dev/null --write-out '%{http_code}' \
    --request POST "http://127.0.0.1:${ports[$chain]}/api/$chain/jobs/history")"
  [[ "$removed_status" == "404" ]] || {
    echo "$chain removed history endpoint returned HTTP $removed_status instead of 404." >&2
    exit 1
  }

  systemctl is-active --quiet "$chain-radar.service"
  quick_check_database "$(database_path "$chain")"
done

social_file="$(mktemp)"
curl --fail --silent --show-error \
  "http://127.0.0.1:18118/api/social?postLimit=1" \
  > "$social_file"
node --input-type=module -e '
  import fs from "node:fs";
  const social = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (social.ok !== true || social.status !== "ready") throw new Error("social API is not ready");
  if (!social.bridge || typeof social.bridge.state !== "string") throw new Error("social bridge state is unavailable");
  if (!social.counts || !Number.isInteger(Number(social.counts.posts))) throw new Error("social counts are unavailable");
' "$social_file"
rm -f "$social_file"
quick_check_database "$(social_database_path)"

if [[ -f "$staging_dir/Caddyfile" ]]; then
  caddy_candidate="$(mktemp /etc/caddy/Caddyfile.robinhood-radar.XXXXXX)"
  install -m 0644 "$staging_dir/Caddyfile" "$caddy_candidate"
  caddy validate --config "$caddy_candidate" --adapter caddyfile
  install -m 0644 "$caddy_candidate" "$caddy_config"
  rm -f "$caddy_candidate"
  caddy_candidate=""
  caddy_changed=1
  caddy validate --config "$caddy_config" --adapter caddyfile
  systemctl reload caddy.service
  systemctl is-active --quiet caddy.service
fi

if [[ -n "${RADAR_PUBLIC_BASE_URL:-}" ]]; then
  public_curl_options=(--fail --silent --show-error --location)
  if [[ -n "${RADAR_PUBLIC_USERNAME:-}" || -n "${RADAR_PUBLIC_PASSWORD:-}" ]]; then
    [[ -n "${RADAR_PUBLIC_USERNAME:-}" && -n "${RADAR_PUBLIC_PASSWORD:-}" ]] || {
      echo "Both RADAR_PUBLIC_USERNAME and RADAR_PUBLIC_PASSWORD are required." >&2
      exit 1
    }
    public_curl_options+=(--user "$RADAR_PUBLIC_USERNAME:$RADAR_PUBLIC_PASSWORD")
  fi
  for chain in "${chains[@]}"; do
    public_file="$(mktemp)"
    curl "${public_curl_options[@]}" \
      "${RADAR_PUBLIC_BASE_URL%/}/api/$chain/dashboard?tab=all" \
      > "$public_file"
    node --input-type=module -e '
      import fs from "node:fs";
      const expectedChain = process.argv[2];
      const payload = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (payload.chain !== expectedChain) throw new Error(`wrong public chain: ${payload.chain}`);
    ' "$public_file" "$chain"
    rm -f "$public_file"
  done

  public_social_file="$(mktemp)"
  curl "${public_curl_options[@]}" \
    "${RADAR_PUBLIC_BASE_URL%/}/api/social?postLimit=1" \
    > "$public_social_file"
  node --input-type=module -e '
    import fs from "node:fs";
    const payload = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (payload.ok !== true || payload.status !== "ready") throw new Error("public social API is not ready");
  ' "$public_social_file"
  rm -f "$public_social_file"
fi

for service in "${services[@]}"; do
  systemctl enable "$service.service" >/dev/null
done

rm -rf "$app_dir/public.previous" "$staging_dir"
rollback_needed=0

for chain in "${chains[@]}"; do
  echo "${chain}_database_backup=$(database_backup_path "$chain")"
done
echo "social_database_backup=$(social_database_backup_path)"
echo "release_backup=$release_backup"
echo "caddy_backup=$release_backup/Caddyfile"
for service in "${services[@]}"; do
  echo "$service=$(systemctl is-active "$service.service")"
done

trap - EXIT
