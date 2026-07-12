# Robinhood Wallet Radar

Robinhood Wallet Radar is a smart-money research and real-time wallet monitor for
Robinhood Chain. It supports manual token analysis, holder-based wallet review,
confirmed-wallet curation, on-chain buy detection, browser alerts, and Bark
notifications.

## Requirements

- Node.js 22 or newer
- npm
- A Robinhood Chain JSON-RPC endpoint (the public RPC is used by default)

## Install and test

```bash
npm ci
npm test
```

Run the development server:

```bash
npm start
```

Build and run the standalone Robinhood service:

```bash
npm run build:robinhood
HOST=127.0.0.1 PORT=18118 node dist/robinhood-server.mjs
```

The UI is then available at `http://127.0.0.1:18118/`.

## Main configuration

Configuration is supplied through environment variables. Common settings are:

| Variable | Default | Purpose |
| --- | --- | --- |
| `ROBINHOOD_RPC_URL` | Robinhood Chain public RPC | Chain reads and monitoring |
| `ROBINHOOD_DATA_FILE` | `data/robinhood.sqlite` | Persistent SQLite database |
| `ROBINHOOD_MIN_ENTRY_USD` | `500` | Default per-token wallet entry floor |
| `ROBINHOOD_MONITOR_POLL_INTERVAL_MS` | `500` | Fast-mode idle polling interval |
| `ROBINHOOD_MONITOR_DEGRADED_POLL_INTERVAL_MS` | `1000` | Protected-mode polling interval |
| `ROBINHOOD_MONITOR_WALLET_TOPIC_CHUNK_SIZE` | `100` | Wallet topics per log request |
| `ROBINHOOD_MONITOR_LOG_CONCURRENCY` | `2` | Maximum concurrent wallet-log requests |
| `ROBINHOOD_MONITOR_RECOVERY_SUCCESSES` | `20` | Healthy polls required to leave protected mode |
| `ROBINHOOD_REQUEST_TIMEOUT_MS` | `20000` | External request timeout |

See `src/robinhood/config.js` for all bounded settings and defaults.

## Monitoring model

The monitor scans incoming ERC-20 `Transfer` logs for confirmed wallets, then
validates the originating transaction and requires a successful V2 or V3 swap
event before recording a buy. Events are deduplicated by transaction hash and
log index. Alert clusters count distinct wallets within the configured window.

## Deployment

- `deploy/robinhood-radar.service` is the systemd unit used by the standalone
  service.
- `deploy/install-remote.sh` installs a prepared release with backup and rollback
  checks.
- `deploy/Caddyfile.example` contains a prefix-based reverse-proxy example. Set
  `ROBINHOOD_SITE_ADDRESS` to the public site address before using it.

Runtime databases, environment files, cookies, browser artifacts, logs, and
build output are intentionally ignored and must not be committed.

This repository is research tooling, not an execution engine or financial
advice. Verify detected activity independently before acting on it.
