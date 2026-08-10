#!/bin/bash

set -Eeuo pipefail

readonly app_dir="/opt/robinhood-radar"
readonly data_dir="/var/lib/robinhood-radar"
readonly staging_dir="${STAGING_DIR:-/root/robinhood-radar-deploy}"
readonly backup_root="/var/backups/robinhood-radar"
readonly stamp="$(date -u +%Y%m%dT%H%M%SZ)"
readonly release_backup="$backup_root/release-$stamp"
readonly caddy_config="/etc/caddy/Caddyfile"
readonly allow_solana_degraded="${ALLOW_SOLANA_DEGRADED:-0}"
readonly health_connect_timeout_seconds="${DEPLOY_HEALTH_CONNECT_TIMEOUT_SECONDS:-2}"
readonly health_request_timeout_seconds="${DEPLOY_HEALTH_REQUEST_TIMEOUT_SECONDS:-5}"
readonly monitor_ready_timeout_seconds="${DEPLOY_MONITOR_READY_TIMEOUT_SECONDS:-30}"
readonly solana_monitor_ready_timeout_seconds="${SOLANA_MONITOR_READY_TIMEOUT_SECONDS:-120}"
readonly services=("robinhood-radar" "base-radar" "bsc-radar" "solana-radar" "feishu-monitor")
readonly chains=("robinhood" "base" "bsc" "solana")
readonly telegram_service="telegram-viewer"
readonly telegram_dir="$app_dir/telegram"
readonly telegram_runtime_dir="$data_dir/telegram"
readonly feishu_service="feishu-monitor"
readonly feishu_dir="$app_dir/feishu"

rollback_needed=0
caddy_changed=0
caddy_candidate=""

[[ "$allow_solana_degraded" == "0" || "$allow_solana_degraded" == "1" ]] || {
  echo "ALLOW_SOLANA_DEGRADED must be 0 or 1." >&2
  exit 1
}

for timeout_setting in \
  "DEPLOY_HEALTH_CONNECT_TIMEOUT_SECONDS:$health_connect_timeout_seconds" \
  "DEPLOY_HEALTH_REQUEST_TIMEOUT_SECONDS:$health_request_timeout_seconds" \
  "DEPLOY_MONITOR_READY_TIMEOUT_SECONDS:$monitor_ready_timeout_seconds" \
  "SOLANA_MONITOR_READY_TIMEOUT_SECONDS:$solana_monitor_ready_timeout_seconds"; do
  timeout_name="${timeout_setting%%:*}"
  timeout_value="${timeout_setting#*:}"
  [[ "$timeout_value" =~ ^[1-9][0-9]*$ ]] || {
    echo "$timeout_name must be a positive integer number of seconds." >&2
    exit 1
  }
done

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

evm_wallet_database_path() {
  echo "$data_dir/evm-wallets.sqlite"
}

evm_wallet_database_backup_path() {
  echo "$backup_root/evm-wallets-$stamp.sqlite"
}

bark_database_path() {
  echo "$data_dir/bark.sqlite"
}

bark_database_backup_path() {
  echo "$backup_root/bark-$stamp.sqlite"
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

checkpoint_database() {
  local database="$1"
  node --input-type=module -e '
    import { DatabaseSync } from "node:sqlite";
    const db = new DatabaseSync(process.argv[1]);
    try {
      db.exec("PRAGMA busy_timeout = 10000");
      const checkpoint = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
      if (Number(checkpoint?.busy) !== 0) {
        throw new Error(`WAL checkpoint remained busy: ${JSON.stringify(checkpoint)}`);
      }
    } finally {
      db.close();
    }
  ' "$database"
}

backup_database_file() {
  local database="$1"
  local backup="$2"
  local temporary_backup="$backup.tmp.$$"

  rm -f "$backup" "$backup.missing" "$temporary_backup"
  if [[ ! -f "$database" ]]; then
    touch "$backup.missing"
    return
  fi

  checkpoint_database "$database"
  cp -p "$database" "$temporary_backup"
  chmod 0600 "$temporary_backup"
  if ! quick_check_database "$temporary_backup"; then
    rm -f "$temporary_backup"
    return 1
  fi
  mv "$temporary_backup" "$backup"
}

remove_database_sidecars() {
  local database="$1"
  rm -f "$database-wal" "$database-shm"
}

restore_database_file() {
  local backup="$1"
  local database="$2"
  local owner="${3:-}"
  local group="${4:-}"

  if [[ -f "$backup.missing" ]]; then
    remove_database_sidecars "$database"
    rm -f "$database"
  elif [[ -f "$backup" ]]; then
    remove_database_sidecars "$database"
    if [[ -n "$owner" || -n "$group" ]]; then
      [[ -n "$owner" && -n "$group" ]] || {
        echo "Database restore owner and group must be provided together." >&2
        return 1
      }
      install -o "$owner" -g "$group" -m 0640 "$backup" "$database"
    else
      install -m 0640 "$backup" "$database"
    fi
  fi
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

backup_telegram_source() {
  local destination="$1"
  local source_file
  local relative_file

  rm -rf "$destination"
  install -d -m 0755 "$destination"
  for relative_file in viewer.py forwarder.py requirements.txt README.md; do
    source_file="$telegram_dir/$relative_file"
    backup_optional_file "$source_file" "$destination/$relative_file"
  done
  if [[ -d "$telegram_dir/web" ]]; then
    cp -a "$telegram_dir/web" "$destination/web"
  else
    touch "$destination/web.missing"
  fi
}

restore_telegram_source() {
  local backup_directory="$1"
  local relative_file

  [[ -d "$backup_directory" ]] || return 0
  install -d -m 0755 "$telegram_dir"
  for relative_file in viewer.py forwarder.py requirements.txt README.md; do
    restore_optional_file "$backup_directory/$relative_file" "$telegram_dir/$relative_file"
  done
  if [[ -f "$backup_directory/web.missing" ]]; then
    rm -rf "$telegram_dir/web"
  elif [[ -d "$backup_directory/web" ]]; then
    rm -rf "$telegram_dir/web"
    cp -a "$backup_directory/web" "$telegram_dir/web"
  fi
}

manifest_contains_file() {
  local manifest="$1"
  local expected="$2"
  local line
  local filename

  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[0-9a-fA-F]{64}[[:space:]][[:space:]]([A-Za-z0-9][A-Za-z0-9._-]*)$ ]] || continue
    filename="${BASH_REMATCH[1]}"
    [[ "$filename" == "$expected" ]] && return 0
  done < "$manifest"
  return 1
}

verify_release_manifest() {
  local directory="$1"
  local manifest="$directory/SHA256SUMS"
  local line
  local filename
  local required

  [[ -f "$manifest" ]] || {
    echo "Missing release checksum manifest: $manifest" >&2
    return 1
  }

  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[0-9a-fA-F]{64}[[:space:]][[:space:]]([A-Za-z0-9][A-Za-z0-9._-]*)$ ]] || {
      echo "Invalid SHA256SUMS entry." >&2
      return 1
    }
    filename="${BASH_REMATCH[1]}"
    [[ -f "$directory/$filename" ]] || {
      echo "Checksum manifest references a missing file: $filename" >&2
      return 1
    }
  done < "$manifest"

  for required in \
    REVISION \
    robinhood-server.mjs \
    base-server.mjs \
    bsc-server.mjs \
    solana-server.mjs \
    robinhood-radar.service \
    base-radar.service \
    bsc-radar.service \
    solana-radar.service \
    public.tar.gz \
    telegram-viewer.service \
    feishu-monitor.service \
    feishu.env.example \
    translation.env.example \
    telegram.tar.gz \
    feishu.tar.gz; do
    manifest_contains_file "$manifest" "$required" || {
      echo "Checksum manifest does not cover required file: $required" >&2
      return 1
    }
  done

  if [[ -f "$directory/Caddyfile" ]] && ! manifest_contains_file "$manifest" Caddyfile; then
    echo "Checksum manifest does not cover optional Caddyfile." >&2
    return 1
  fi

  (cd "$directory" && sha256sum --check --strict SHA256SUMS)
}

rollback() {
  local exit_code=$?
  trap - EXIT
  rm -f "${caddy_candidate:-}"

  if [[ $exit_code -ne 0 ]]; then
    echo "Deployment failed; restoring the previous release." >&2
    if [[ $rollback_needed -eq 1 && -d "$release_backup" ]]; then
      for service in "${services[@]}"; do
        systemctl stop "$service.service" 2>/dev/null || true
      done
      if [[ -f "$(unit_path "$telegram_service")" ]]; then
        systemctl stop "$telegram_service.service" 2>/dev/null || true
      fi

      for chain in "${chains[@]}"; do
        restore_optional_file "$release_backup/$chain-server.mjs" "$(bundle_path "$chain")"
        restore_optional_file "$release_backup/$chain-server.mjs.LEGAL.txt" "$(bundle_path "$chain").LEGAL.txt"
        restore_optional_file "$release_backup/$chain-radar.service" "$(unit_path "$chain-radar")"

        local database
        local backup
        database="$(database_path "$chain")"
        backup="$(database_backup_path "$chain")"
        restore_database_file "$backup" "$database" robinhood-radar robinhood-radar
      done

      local social_database
      local social_backup
      social_database="$(social_database_path)"
      social_backup="$(social_database_backup_path)"
      restore_database_file "$social_backup" "$social_database" robinhood-radar robinhood-radar

      local evm_wallet_database
      local evm_wallet_backup
      evm_wallet_database="$(evm_wallet_database_path)"
      evm_wallet_backup="$(evm_wallet_database_backup_path)"
      restore_database_file "$evm_wallet_backup" "$evm_wallet_database" robinhood-radar robinhood-radar

      local bark_database
      local bark_backup
      bark_database="$(bark_database_path)"
      bark_backup="$(bark_database_backup_path)"
      restore_database_file "$bark_backup" "$bark_database" robinhood-radar robinhood-radar

      if [[ -d "$release_backup/public" ]]; then
        rm -rf "$app_dir/public"
        cp -a "$release_backup/public" "$app_dir/public"
      fi
      restore_telegram_source "$release_backup/telegram"
      restore_optional_file "$release_backup/telegram-viewer.service" "$(unit_path "$telegram_service")"
      if [[ -d "$release_backup/feishu" ]]; then
        rm -rf "$feishu_dir"
        cp -a "$release_backup/feishu" "$feishu_dir"
      else
        rm -rf "$feishu_dir"
      fi
      restore_optional_file "$release_backup/feishu-monitor.service" "$(unit_path "$feishu_service")"
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
      if [[ "${telegram_was_active:-0}" == "1" ]]; then
        systemctl start "$telegram_service.service" || true
      fi
    else
      for service in "${services[@]}"; do
        if [[ "${was_active[$service]:-0}" == "1" ]]; then
          systemctl start "$service.service" || true
        fi
      done
      if [[ "${telegram_was_active:-0}" == "1" ]]; then
        systemctl start "$telegram_service.service" || true
      fi
    fi
  fi

  exit "$exit_code"
}

if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  return 0
fi

declare -A was_active=()
declare -A unit_existed=()
telegram_was_active=0
telegram_unit_existed=0

trap rollback EXIT

verify_release_manifest "$staging_dir"

for file in \
  "$staging_dir/robinhood-server.mjs" \
  "$staging_dir/base-server.mjs" \
  "$staging_dir/bsc-server.mjs" \
  "$staging_dir/solana-server.mjs" \
  "$staging_dir/robinhood-radar.service" \
  "$staging_dir/base-radar.service" \
  "$staging_dir/bsc-radar.service" \
  "$staging_dir/solana-radar.service" \
  "$staging_dir/telegram-viewer.service" \
  "$staging_dir/feishu-monitor.service" \
  "$staging_dir/feishu.env.example" \
  "$staging_dir/translation.env.example" \
  "$staging_dir/telegram.tar.gz" \
  "$staging_dir/feishu.tar.gz" \
  "$staging_dir/public.tar.gz" \
  "$staging_dir/REVISION" \
  "$staging_dir/SHA256SUMS"; do
  [[ -f "$file" ]] || { echo "Missing deployment file: $file" >&2; exit 1; }
done

if systemctl is-active --quiet "$telegram_service.service" 2>/dev/null; then
  telegram_was_active=1
fi
if [[ -f "$(unit_path "$telegram_service")" ]]; then
  telegram_unit_existed=1
fi
if [[ "$telegram_unit_existed" == "1" ]]; then
  systemctl stop "$telegram_service.service"
  systemctl is-active --quiet "$telegram_service.service" && {
    echo "$telegram_service.service did not stop cleanly." >&2
    exit 1
  }
else
  systemctl stop "$telegram_service.service" 2>/dev/null || true
fi

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
  backup_database_file "$database" "$database_backup"

  backup_optional_file "$(bundle_path "$chain")" "$release_backup/$chain-server.mjs"
  backup_optional_file "$(bundle_path "$chain").LEGAL.txt" "$release_backup/$chain-server.mjs.LEGAL.txt"
  backup_optional_file "$(unit_path "$chain-radar")" "$release_backup/$chain-radar.service"
done

social_database="$(social_database_path)"
social_database_backup="$(social_database_backup_path)"
backup_database_file "$social_database" "$social_database_backup"
evm_wallet_database="$(evm_wallet_database_path)"
evm_wallet_database_backup="$(evm_wallet_database_backup_path)"
backup_database_file "$evm_wallet_database" "$evm_wallet_database_backup"
bark_database="$(bark_database_path)"
bark_database_backup="$(bark_database_backup_path)"
backup_database_file "$bark_database" "$bark_database_backup"
cp -a "$app_dir/public" "$release_backup/public"
backup_telegram_source "$release_backup/telegram"
backup_optional_file "$(unit_path "$telegram_service")" "$release_backup/telegram-viewer.service"
if [[ -d "$feishu_dir" ]]; then
  cp -a "$feishu_dir" "$release_backup/feishu"
fi
backup_optional_file "$(unit_path "$feishu_service")" "$release_backup/feishu-monitor.service"
rollback_needed=1

install -m 0644 "$staging_dir/REVISION" "$app_dir/REVISION"

for chain in "${chains[@]}"; do
  install -m 0644 "$staging_dir/$chain-server.mjs" "$(bundle_path "$chain")"
  if [[ -f "$staging_dir/$chain-server.mjs.LEGAL.txt" ]]; then
    install -m 0644 "$staging_dir/$chain-server.mjs.LEGAL.txt" "$(bundle_path "$chain").LEGAL.txt"
  else
    rm -f "$(bundle_path "$chain").LEGAL.txt"
  fi
  install -m 0644 "$staging_dir/$chain-radar.service" "$(unit_path "$chain-radar")"
done

install -m 0644 "$staging_dir/telegram-viewer.service" "$(unit_path "$telegram_service")"
install -d -m 0755 "$telegram_dir"
for relative_file in viewer.py forwarder.py requirements.txt README.md; do
  rm -f "$telegram_dir/$relative_file"
done
rm -rf "$telegram_dir/web"
tar -xzf "$staging_dir/telegram.tar.gz" -C "$telegram_dir"
for relative_file in viewer.py forwarder.py requirements.txt README.md; do
  chown root:root "$telegram_dir/$relative_file"
  chmod 0644 "$telegram_dir/$relative_file"
done
chmod 0755 "$telegram_dir/viewer.py" "$telegram_dir/forwarder.py"
chown -R root:root "$telegram_dir/web"
find "$telegram_dir/web" -type d -exec chmod 0755 {} +
find "$telegram_dir/web" -type f -exec chmod 0644 {} +
if [[ "$telegram_was_active" == "1" && ! -x "$telegram_dir/.venv/bin/python" ]]; then
  echo "Telegram viewer was active but its Python virtual environment is missing." >&2
  exit 1
fi

install -m 0644 "$staging_dir/feishu-monitor.service" "$(unit_path "$feishu_service")"
rm -rf "$feishu_dir"
install -d -m 0755 "$feishu_dir"
tar -xzf "$staging_dir/feishu.tar.gz" -C "$feishu_dir"
chown -R root:root "$feishu_dir"
find "$feishu_dir" -type d -exec chmod 0755 {} +
find "$feishu_dir" -type f -exec chmod 0644 {} +

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

telegram_should_run=0
if [[ "$telegram_was_active" == "1" || (
  -x "$telegram_dir/.venv/bin/python" &&
  -f "$telegram_runtime_dir/viewer_config.json" &&
  -f "$telegram_runtime_dir/tg_forwarder.session"
) ]]; then
  telegram_should_run=1
  systemctl start "$telegram_service.service"
fi

declare -A ports=([robinhood]=18118 [base]=18119 [bsc]=18122 [solana]=18120)
bark_reference_signature=""
for chain in "${chains[@]}"; do
  health_file="$(mktemp)"
  for attempt in $(seq 1 30); do
    if curl --fail --silent --show-error \
      --connect-timeout "$health_connect_timeout_seconds" \
      --max-time "$health_request_timeout_seconds" \
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
  monitor_error_file="$(mktemp)"
  chain_monitor_ready_timeout_seconds="$monitor_ready_timeout_seconds"
  if [[ "$chain" == "solana" ]]; then
    chain_monitor_ready_timeout_seconds="$solana_monitor_ready_timeout_seconds"
  fi
  monitor_ready_deadline=$((SECONDS + chain_monitor_ready_timeout_seconds))
  monitor_ready=0
  while (( SECONDS < monitor_ready_deadline )); do
    monitor_request_timeout_seconds="$health_request_timeout_seconds"
    monitor_connect_timeout_seconds="$health_connect_timeout_seconds"
    monitor_remaining_seconds=$((monitor_ready_deadline - SECONDS))
    (( monitor_remaining_seconds > 0 )) || break
    if (( monitor_request_timeout_seconds > monitor_remaining_seconds )); then
      monitor_request_timeout_seconds="$monitor_remaining_seconds"
    fi
    if (( monitor_connect_timeout_seconds > monitor_request_timeout_seconds )); then
      monitor_connect_timeout_seconds="$monitor_request_timeout_seconds"
    fi

    if curl --fail --silent --show-error \
      --connect-timeout "$monitor_connect_timeout_seconds" \
      --max-time "$monitor_request_timeout_seconds" \
      "http://127.0.0.1:${ports[$chain]}/api/$chain/monitor" \
      > "$monitor_file" 2> "$monitor_error_file" \
      && node --input-type=module -e '
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
      ' "$monitor_file" "$chain" "$allow_solana_degraded" 2> "$monitor_error_file"; then
      monitor_ready=1
      break
    fi
    (( SECONDS < monitor_ready_deadline )) || break
    sleep 1
  done
  if [[ "$monitor_ready" != "1" ]]; then
    echo "$chain monitor health check did not become ready within ${chain_monitor_ready_timeout_seconds}s." >&2
    cat "$monitor_error_file" >&2
    exit 1
  fi
  rm -f "$monitor_error_file"
  if [[ "$chain" == "solana" && "$allow_solana_degraded" == "1" ]]; then
    node --input-type=module -e '
      import fs from "node:fs";
      const monitor = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (monitor.health?.realtimeReady !== true) {
        console.error(`WARNING: Solana deployed in explicit degraded mode: ${(monitor.health?.reasons || []).join(",")}`);
      }
    ' "$monitor_file"
  fi
  bark_signature="$(node --input-type=module -e '
    import fs from "node:fs";
    const monitor = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (!Array.isArray(monitor.barkTargets)) throw new Error("Bark targets are unavailable");
    if (typeof monitor.settings?.barkSound !== "string") throw new Error("Bark sound is unavailable");
    if (!Number.isInteger(Number(monitor.settings?.barkVolume))) throw new Error("Bark volume is unavailable");
    const targets = monitor.barkTargets.map((target) => ({
      id: Number(target.id),
      label: String(target.label || ""),
      endpointMasked: String(target.endpointMasked || ""),
      enabled: target.enabled !== false
    })).sort((left, right) => left.id - right.id);
    process.stdout.write(JSON.stringify({
      targets,
      sound: monitor.settings.barkSound,
      volume: Number(monitor.settings.barkVolume)
    }));
  ' "$monitor_file")"
  if [[ -z "$bark_reference_signature" ]]; then
    bark_reference_signature="$bark_signature"
  elif [[ "$bark_signature" != "$bark_reference_signature" ]]; then
    echo "$chain Bark configuration does not match the other chain services." >&2
    exit 1
  fi
  rm -f "$monitor_file"

  removed_status="$(curl --silent --output /dev/null --write-out '%{http_code}' \
    --connect-timeout "$health_connect_timeout_seconds" \
    --max-time "$health_request_timeout_seconds" \
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
  --connect-timeout "$health_connect_timeout_seconds" \
  --max-time "$health_request_timeout_seconds" \
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

if [[ "$telegram_should_run" == "1" ]]; then
  telegram_chats_file="$(mktemp)"
  telegram_messages_file="$(mktemp)"
  telegram_ready=0
  for attempt in $(seq 1 30); do
    if curl --fail --silent --show-error \
      --connect-timeout "$health_connect_timeout_seconds" \
      --max-time "$health_request_timeout_seconds" \
      "http://127.0.0.1:18123/api/chats" > "$telegram_chats_file" \
      && curl --fail --silent --show-error \
      --connect-timeout "$health_connect_timeout_seconds" \
      --max-time "$health_request_timeout_seconds" \
      "http://127.0.0.1:18123/api/messages?limit=1" > "$telegram_messages_file"; then
      telegram_ready=1
      break
    fi
    (( attempt < 30 )) || break
    sleep 1
  done
  if [[ "$telegram_ready" != "1" ]]; then
    echo "Telegram viewer health check did not become ready." >&2
    rm -f "$telegram_chats_file" "$telegram_messages_file"
    exit 1
  fi
  node --input-type=module -e '
    import fs from "node:fs";
    const chats = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const messages = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    if (!Array.isArray(chats.chats) || !Array.isArray(chats.selected_chat_ids)) {
      throw new Error("Telegram chat catalog is unavailable");
    }
    if (!Array.isArray(messages.messages) || !Array.isArray(messages.selected_chat_ids)) {
      throw new Error("Telegram message feed is unavailable");
    }
    for (const message of messages.messages) {
      if (!Object.hasOwn(message, "translated_text")) {
        throw new Error("Telegram translation field is unavailable");
      }
    }
  ' "$telegram_chats_file" "$telegram_messages_file"
  rm -f "$telegram_chats_file" "$telegram_messages_file"
  systemctl is-active --quiet "$telegram_service.service"
fi

feishu_health_file="$(mktemp)"
feishu_ready=0
for attempt in $(seq 1 30); do
  if curl --fail --silent --show-error \
    --connect-timeout "$health_connect_timeout_seconds" \
    --max-time "$health_request_timeout_seconds" \
    "http://127.0.0.1:18124/api/snapshot" > "$feishu_health_file" \
    && node --input-type=module -e '
      import fs from "node:fs";
      const payload = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (!Array.isArray(payload.people) || payload.people.length < 1) process.exit(1);
    ' "$feishu_health_file" 2>/dev/null; then
    feishu_ready=1
    break
  fi
  (( attempt < 30 )) || break
  sleep 1
done
if [[ "$feishu_ready" != "1" ]]; then
  echo "Feishu monitor health check did not load its people catalog." >&2
  rm -f "$feishu_health_file"
  exit 1
fi
rm -f "$feishu_health_file"
systemctl is-active --quiet "$feishu_service.service"
quick_check_database "$(social_database_path)"
quick_check_database "$(evm_wallet_database_path)"
quick_check_database "$(bark_database_path)"

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
  public_curl_options=(
    --fail
    --silent
    --show-error
    --location
    --connect-timeout "$health_connect_timeout_seconds"
    --max-time "$health_request_timeout_seconds"
  )
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
if [[ "$telegram_should_run" == "1" ]]; then
  systemctl enable "$telegram_service.service" >/dev/null
fi

rm -rf "$app_dir/public.previous" "$staging_dir"
rollback_needed=0

for chain in "${chains[@]}"; do
  echo "${chain}_database_backup=$(database_backup_path "$chain")"
done
echo "social_database_backup=$(social_database_backup_path)"
echo "evm_wallet_database_backup=$(evm_wallet_database_backup_path)"
echo "bark_database_backup=$(bark_database_backup_path)"
echo "release_backup=$release_backup"
echo "caddy_backup=$release_backup/Caddyfile"
for service in "${services[@]}"; do
  echo "$service=$(systemctl is-active "$service.service")"
done
if [[ "$telegram_should_run" == "1" ]]; then
  echo "$telegram_service=$(systemctl is-active "$telegram_service.service")"
else
  echo "$telegram_service=not-configured"
fi

trap - EXIT
