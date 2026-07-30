#!/bin/bash

set -Eeuo pipefail

readonly service_user="${RADAR_SERVICE_USER:-robinhood-radar}"
readonly service_group="${RADAR_SERVICE_GROUP:-robinhood-radar}"
readonly app_dir="${RADAR_APP_DIR:-/opt/robinhood-radar}"
readonly data_dir="${RADAR_DATA_DIR:-/var/lib/robinhood-radar}"
readonly backup_dir="${RADAR_BACKUP_DIR:-/var/backups/robinhood-radar}"
readonly config_dir="${RADAR_CONFIG_DIR:-/etc/robinhood-radar}"
readonly script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

fail() {
  echo "bootstrap-host: $*" >&2
  exit 1
}

[[ "$EUID" -eq 0 ]] || fail "run this script as root"

for command in node systemctl curl tar sha256sum install getent groupadd useradd; do
  command -v "$command" >/dev/null 2>&1 || fail "required command is unavailable: $command"
done

node --input-type=module -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 13)) process.exit(1);
' || fail "Node.js 22.13.0 or newer is required (found $(node --version 2>/dev/null || echo unknown))"

if ! getent group "$service_group" >/dev/null; then
  groupadd --system "$service_group"
fi

if id "$service_user" >/dev/null 2>&1; then
  expected_gid="$(getent group "$service_group" | awk -F: '{print $3}')"
  actual_gid="$(id -g "$service_user")"
  [[ -n "$expected_gid" && "$actual_gid" == "$expected_gid" ]] || {
    fail "existing user $service_user does not use group $service_group as its primary group"
  }
else
  nologin_shell="$(command -v nologin || true)"
  [[ -n "$nologin_shell" ]] || nologin_shell="$(command -v false)"
  useradd \
    --system \
    --gid "$service_group" \
    --home-dir /nonexistent \
    --no-create-home \
    --shell "$nologin_shell" \
    "$service_user"
fi

install -d -o root -g root -m 0755 "$app_dir" "$app_dir/public"
install -d -o "$service_user" -g "$service_group" -m 0750 "$data_dir"
install -d -o root -g root -m 0700 "$backup_dir"
install -d -o root -g "$service_group" -m 0750 "$config_dir"

for name in robinhood base bsc solana social; do
  example="$script_dir/$name.env.example"
  destination="$config_dir/$name.env"
  [[ -f "$example" ]] || fail "missing environment template: $example"
  if [[ ! -e "$destination" ]]; then
    install -o root -g root -m 0600 "$example" "$destination"
  fi
done

if ! command -v caddy >/dev/null 2>&1; then
  echo "bootstrap-host: warning: Caddy is not installed; services can run locally, but the public reverse proxy is unavailable" >&2
fi

echo "bootstrap-host: host directories, service identity, and environment templates are ready"
echo "bootstrap-host: fill the required values in $config_dir before deployment"
