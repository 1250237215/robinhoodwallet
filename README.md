# Multi-chain Wallet Radar

This project is a smart-money research and real-time wallet monitor for
Robinhood Chain, Base, and Solana. A segmented control switches the active chain,
while every chain keeps its own SQLite database, address library, token queue,
scan jobs, monitor events, alert threshold, deduplication state, and Bark targets.
No wallet, token, event, setting, or notification destination is copied between
chains.

## Requirements

- Node.js 22 or newer
- npm
- Robinhood and Base JSON-RPC endpoints (public RPCs are used by default)
- A Solana JSON-RPC endpoint for manual Holder scans
- A Helius Enhanced Webhook for production Solana real-time monitoring

## Install and test

```bash
npm ci
npm test
```

Run the development server:

```bash
npm start
```

Build all three standalone services:

```bash
npm run build:all
HOST=127.0.0.1 PORT=18118 node dist/robinhood-server.mjs
BASE_HOST=127.0.0.1 BASE_PORT=18119 node dist/base-server.mjs
SOLANA_HOST=127.0.0.1 SOLANA_PORT=18120 node dist/solana-server.mjs
```

The Robinhood process serves the UI. A reverse proxy routes `/api/robinhood`,
`/api/base`, and `/api/solana` to ports `18118`, `18119`, and `18120`.

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
| `ROBINHOOD_MONITOR_FAST_LIVE_BLOCK_SPAN` | `50` | Latest log blocks scanned before historical fast-lane gaps |
| `ROBINHOOD_MONITOR_FAST_GAP_BLOCK_SPAN` | `100` | Historical log blocks scanned by each low-priority pass |
| `ROBINHOOD_MONITOR_FAST_GAP_POLL_INTERVAL_MS` | `5000` | Delay between low-priority fast-lane gap passes |
| `ROBINHOOD_MONITOR_DEEP_POLL_INTERVAL_MS` | `500` | Native-transfer/direct-deployment live polling interval |
| `ROBINHOOD_MONITOR_DEEP_LIVE_BLOCK_SPAN` | `20` | Latest full blocks scanned by each deep live pass |
| `ROBINHOOD_MONITOR_DEEP_GAP_BLOCK_SPAN` | `20` | Historical full blocks scanned by each low-priority backfill pass |
| `ROBINHOOD_MONITOR_DEEP_GAP_POLL_INTERVAL_MS` | `5000` | Delay between low-priority deep gap passes |
| `ROBINHOOD_MONITOR_TOKEN_METADATA_BUDGET_MS` | `1500` | Per-event metadata wait budget before a fallback label is used |
| `ROBINHOOD_MARKET_REQUEST_TIMEOUT_MS` | `5000` | DexScreener batch request timeout |
| `ROBINHOOD_MARKET_DEBOT_FALLBACK_TIMEOUT_MS` | `3000` | DeBot fallback budget when DexScreener data is incomplete |
| `ROBINHOOD_MONITOR_MARKET_DATA_CACHE_SECONDS` | `60` | Fresh market-cap snapshot lifetime for Robinhood events |
| `ROBINHOOD_MONITOR_MARKET_DATA_BATCH_SIZE` | `30` | Maximum token addresses per DexScreener request |
| `ROBINHOOD_NOXA_LAUNCH_FACTORY` | Official Robinhood Noxa factory | Noxa `TokenLaunched` event source |
| `ROBINHOOD_REQUEST_TIMEOUT_MS` | `20000` | External request timeout |
| `SOCIAL_DATA_FILE` | Next to the Robinhood database | Independent DeBot social cache and command queue |
| `SOCIAL_BRIDGE_TOKEN` | Empty | Private browser-bridge device token; keep it in `/etc/robinhood-radar/social.env` |
| `SOCIAL_RETENTION_DAYS` | `7` | Social post and completed-command retention |
| `SOCIAL_BRIDGE_OFFLINE_MS` | `15000` | Time without a browser heartbeat before the bridge is shown offline |

See `src/robinhood/config.js` for all bounded settings and defaults.

Base uses the same bounded tuning names with a `BASE_` prefix. Its database is
configured with `BASE_DATA_FILE`, and its real-time market enrichment falls back
to DexScreener when DeBot is blocked or incomplete.

Solana settings use the `SOLANA_` prefix. The important production settings are:

| Variable | Purpose |
| --- | --- |
| `SOLANA_DATA_FILE` | Independent Solana SQLite database |
| `SOLANA_RPC_URL` | Manual Holder scans and token-account reads |
| `HELIUS_API_KEY` | Enables the production webhook provider |
| `SOLANA_HELIUS_WEBHOOK_URL` | Public HTTPS callback URL registered with Helius |
| `SOLANA_HELIUS_AUTH_HEADER` | Secret authorization value required by the callback |

The official public Solana RPC is suitable for user-triggered Holder scans but
not for sub-five-second monitoring of hundreds of wallets. The Solana monitor
therefore reports `degraded` until a Helius webhook, HTTPS callback, auth value,
and durable signature deduplication are all ready. It never claims a public-RPC
polling fallback is real-time. Start from `deploy/solana.env.example`, install
the populated file as `/etc/robinhood-radar/solana.env` with mode `0600`, and do
not commit the populated file.

## Public database snapshot

The `database/` directory contains a compressed production snapshot for public
recovery and analysis. Bark targets and Bark settings were securely removed
before publication. See `database/README.md` and `database/manifest.json` for
the exact redactions, hashes, table counts, and restore precautions.

## Monitoring model

Each confirmed wallet has independent rules for buys, sells, outbound transfers,
and token creation. Each rule controls detection, browser sound, and immediate
Bark delivery. Existing wallets migrate with buy detection enabled and every new
alert channel disabled.

Buys and sells are classified from ERC-20 `Transfer` logs only after validating
the originating wallet, successful receipt, and a V2 or V3 swap event. Outbound
ERC-20 transfers without a swap are classified as transfers; full blocks cover
plain native-coin transfers and direct ERC-20 deployments. Noxa launches are
attributed from the official factory's indexed `TokenLaunched.deployer` event.
Events are deduplicated by transaction hash and log index. The existing same-CA
cluster alert counts only distinct-wallet buy events within the configured
window.

Base reuses the verified EVM receipt and swap-log model with Base-specific RPC,
quote tokens, explorer links, and no Noxa listener. Solana consumes Helius
Enhanced Transactions, derives buy and sell events from signed wallet token
balance changes, handles SPL/native transfers, and recognizes SPL
`InitializeMint`/`InitializeMint2` creation. Solana signatures are preserved as
case-sensitive Base58 values and are durably deduplicated before event storage.

Manual Solana Holder scans query legacy SPL Token and Token-2022 accounts,
aggregate balances by owner, and verify top owners are ordinary System Program
accounts. Oversized scans fall back to the RPC's largest-account result and are
marked partial.

## Deployment

- `deploy/robinhood-radar.service`, `deploy/base-radar.service`, and
  `deploy/solana-radar.service` are the isolated systemd units.
- `deploy/install-remote.sh` installs a prepared release with backup and rollback
  checks for all three binaries, their databases, the independent social database,
  and all service units.
- `deploy/Caddyfile.example` contains the prefix-based reverse proxy used by the
  existing radar URL. Set `ROBINHOOD_SITE_ADDRESS` to the public site address.
  It does not add a browser login; the exact Solana webhook route remains
  protected by the independent `SOLANA_HELIUS_AUTH_HEADER` secret.
- If a complete `Caddyfile` is included in the deployment staging directory,
  `deploy/install-remote.sh` backs up, validates, installs, reloads, publicly
  verifies, and rolls it back with the rest of the release. External `.LEGAL.txt`
  bundle files are installed when generated but are not required when esbuild
  emits none.
- Production installation rejects a Solana monitor whose Helius subscription is
  not ready. A deployment that intentionally provides only Solana Holder scans
  must set `ALLOW_SOLANA_DEGRADED=1`; the installer then prints the exact degraded
  reasons instead of presenting the monitor as real-time.

Runtime databases, environment files, cookies, browser artifacts, logs, and
build output are intentionally ignored and must not be committed.

This repository is research tooling, not an execution engine or financial
advice. Verify detected activity independently before acting on it.
