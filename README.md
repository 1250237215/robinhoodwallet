# 1874catch - Multi-chain Wallet Radar

This project is a smart-money research and real-time wallet monitor for
Robinhood Chain, Base, BSC, and Solana. A segmented control switches the active
chain,
while every chain keeps its own chain SQLite database, token queue, scan jobs,
PnL, monitor events, alert threshold, deduplication state, and Bark targets.
Robinhood and BSC additionally share one confirmed-address library through
`EVM_WALLET_DATA_FILE`: addresses, aliases, notes, tags, tiers, per-wallet event
rules, and active/excluded status stay synchronized between those two chains.
Candidates, manual-CA scans, token results, PnL, events, and Bark configuration
remain chain-specific. Base and Solana keep independent address libraries.

## 中文快速开始

1874catch 是一个可自行部署的多链聪明钱研究与实时钱包监控系统，支持：

- Robinhood Chain、Base、BSC、Solana 四链独立链上数据和独立监控配置
- Robinhood 与 BSC 共用已确认地址、备注、标签、分组、规则和启用/排除状态
- 钱包买入、卖出、转账、直接创建代币及平台发币事件
- 每个钱包分别设置监控事件、网页声音和 Bark 推送
- 四链 Holder 分析、人工金狗、钱包命中次数与买币频率排序
- 实时市值、币龄，以及 Robinhood 专属的流动性、持仓和合约风险补全
- 通过本地 Chrome 扩展同步已登录 DeBot 的个人社媒监控名单

本地体验 Robinhood 功能需要 Node.js 22.13.0 或更高版本：

```bash
git clone https://github.com/1250237215/robinhoodwallet.git
cd robinhoodwallet
npm ci
npm test
npm start
```

默认地址是 `http://127.0.0.1:18118/`。`npm start`适合本地开发，完整的
Robinhood、Base、BSC、Solana、Caddy、systemd 和 DeBot Bridge 生产部署请阅读
[中文部署手册](docs/deployment.zh-CN.md)。

### 文档入口

- [完整 VPS 部署、升级与回滚](docs/deployment.zh-CN.md)
- [DeBot 社媒桥接安装与配对](bridge/debot-social-bridge/README.md)
- [公开数据库快照与恢复注意事项](database/README.md)
- [安全策略与密钥边界](SECURITY.md)
- [参与开发](CONTRIBUTING.md)
- [MIT 许可证](LICENSE)

仓库只保存可复现的源代码、模板和经过明确脱敏的公开数据库快照。完整
Bark 地址、服务器密码、API Key、浏览器登录信息、生产环境文件和实时
SQLite 数据库不会提交到 Git。`dist/`也不会提交，生产 bundle 由部署者
在自己的可信构建机上生成。

> This is research tooling, not an execution engine or financial advice. Always
> verify detected activity and token risk independently.

## Requirements

- Node.js 22.13.0 or newer
- npm
- Robinhood, Base, and BSC JSON-RPC endpoints (public RPCs are used by default)
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

The older combined DeBot signal development entry point remains available as
`npm run start:legacy`; it is not used by the production systemd services.

Build all four standalone services:

```bash
npm run build:all
HOST=127.0.0.1 PORT=18118 node dist/robinhood-server.mjs
BASE_HOST=127.0.0.1 BASE_PORT=18119 node dist/base-server.mjs
BSC_HOST=127.0.0.1 BSC_PORT=18122 node dist/bsc-server.mjs
SOLANA_HOST=127.0.0.1 SOLANA_PORT=18120 node dist/solana-server.mjs
```

The Robinhood process serves the UI and the single shared social API. A reverse
proxy routes `/api/robinhood`, `/api/base`, `/api/bsc`, and `/api/solana` to
ports `18118`, `18119`, `18122`, and `18120` respectively. Switching chains
never changes or duplicates `/api/social`.

## Main configuration

Configuration is supplied through environment variables. Common settings are:

| Variable | Default | Purpose |
| --- | --- | --- |
| `ROBINHOOD_RPC_URL` | Robinhood Chain public RPC | Chain reads and monitoring |
| `ROBINHOOD_DATA_FILE` | `data/robinhood.sqlite` | Persistent SQLite database |
| `EVM_WALLET_DATA_FILE` | Empty | Shared Robinhood/BSC confirmed-address library; both services must use the same path |
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
| `ROBINHOOD_DEBOT_BRIDGE_TIMEOUT_MS` | `90000` | Maximum wait for a signed-in browser to complete one allowlisted DeBot analysis request |
| `ROBINHOOD_DEBOT_REQUEST_TIMEOUT_MS` | `95000` | Outer DeBot client timeout, kept above the browser-bridge deadline |
| `SOCIAL_DATA_FILE` | Next to the Robinhood database | Independent DeBot social cache and command queue |
| `SOCIAL_BRIDGE_TOKEN` | Empty | Private browser-bridge device token; keep it in `/etc/robinhood-radar/social.env` |
| `SOCIAL_RETENTION_DAYS` | `7` | Social post and completed-command retention |
| `SOCIAL_BRIDGE_OFFLINE_MS` | `90000` | Time without a browser heartbeat before the bridge is shown offline; allows for Chrome background-tab timer throttling |
| `SOCIAL_DEBOT_JOB_LEASE_MS` | `120000` | Browser analysis claim lease; longer than the bridge deadline so hidden-tab throttling can recover |

See `src/robinhood/config.js` for all bounded settings and defaults.

Base uses the same bounded tuning names with a `BASE_` prefix. Its database is
configured with `BASE_DATA_FILE`, and its real-time market enrichment falls back
to DexScreener when DeBot is blocked or incomplete.

BSC uses the same bounded EVM tuning names with a `BSC_` prefix. Its database is
configured with `BSC_DATA_FILE`, its API is served independently on port `18122`,
and its latency-sensitive monitor RPC can be overridden with `BSC_RPC_URL`.
The no-key default is Blast's BSC endpoint, so BSC log windows default to ten
blocks. Production deployments should provide a dedicated full endpoint.

In production, both Robinhood and BSC set `EVM_WALLET_DATA_FILE` to
`/var/lib/robinhood-radar/evm-wallets.sqlite`. The two processes use that file
only for confirmed-address annotations and monitoring rules. Their normal chain
databases continue to own candidates, CA scans, token analysis, PnL, monitor
events, deduplication state, alert settings, and Bark destinations. Base and
Solana do not open this shared file.

By default, BSC manual-CA and smart-wallet analysis asks the signed-in local
DeBot extension for the largest 100 current Holders, ordered by token position.
The BSC process reaches that browser through Robinhood's loopback-only internal
endpoint at `BSC_DEBOT_BRIDGE_URL`; the endpoint must never be exposed by the
public reverse proxy. The result is deliberately marked partial when DeBot has
more than 100 Holders, and the server independently rejects invalid addresses,
known service addresses, and contracts before wallet scoring.

`BSC_HOLDER_RPC_URL` is optional. Setting it switches Holder discovery to the
strict mode, which reconstructs the complete current Holder ledger from ERC-20
`Transfer` history and verifies it against `totalSupply` and on-chain balances.
This state endpoint must be a BSC archive RPC that supports historical
`eth_getCode`, `eth_call`, and batch requests. `BSC_HOLDER_LOG_RPC_URL` can point
to a separate log provider that returns complete `eth_getLogs` ranges; when it
is empty, strict mode reads logs from the state endpoint. The log-only provider
never handles chain state, supply, balance, or EOA verification.

The monitor, Holder state, and configured Holder log endpoints are all
chain-checked before the BSC database is opened. Monitor and Holder log clients
may never be the same object or normalized URL. With
`BSC_ALLOW_SHARED_RPC_ENDPOINT=false`, monitor and Holder state must also use
different normalized URLs. Keep that setting false when possible. A production
deployment may enable it only when the monitor and Holder state must use
separate clients on the same endpoint; the high-volume Holder log endpoint must
remain independent regardless of this flag. Holder state and Holder log may
safely be the same client or URL when the monitor is elsewhere. The live
endpoint must additionally return a recent confirmed transaction plus receipt
in one JSON-RPC batch.

| Variable | Default | Purpose |
| --- | --- | --- |
| `BSC_DEBOT_BRIDGE_URL` | `http://127.0.0.1:18118/internal/debot/request` | Loopback bridge for the default top-100 Holder request |
| `BSC_DEBOT_BRIDGE_TIMEOUT_MS` | `90000` | Maximum time the server waits for the signed-in browser |
| `BSC_DEBOT_REQUEST_TIMEOUT_MS` | `95000` | Outer request deadline; it must remain above the bridge timeout |
| `BSC_HOLDER_RPC_URL` | Empty | Optional state/archive RPC that enables strict full-ledger Holder reconstruction |
| `BSC_HOLDER_LOG_RPC_URL` | Empty | Optional log-only RPC for strict mode; defaults to the Holder state RPC |
| `BSC_ALLOW_SHARED_RPC_ENDPOINT` | `false` | Allows only separate monitor/state clients to use one normalized URL; it never permits monitor/log sharing |

The default BSC Holder path requires DeBot Bridge extension version `1.9.0` and
the `debot-token-holders-v1` capability. After updating the repository, open
`chrome://extensions`, click **Reload** on **Radar DeBot Social Bridge**, keep a
signed-in DeBot tab open, and reload Radar. Verify the active bridge on the VPS:

```bash
curl --fail --silent http://127.0.0.1:18118/api/social/status | node -e "
const status = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
const bridge = status.bridge || {};
const ready = bridge.version === '1.9.0' &&
  bridge.holderAnalysisOnline === true &&
  Array.isArray(bridge.capabilities) &&
  bridge.capabilities.includes('debot-token-holders-v1');
if (!ready) {
  console.error(JSON.stringify(bridge, null, 2));
  process.exit(1);
}
console.log('DeBot Holder bridge 1.9.0 ready');
"
```

An older or offline extension cannot claim BSC Holder jobs, so BSC manual CA
analysis fails explicitly while the BSC real-time monitor continues running.
Start from `deploy/bsc.env.example`; never place provider credentials in the
committed template.

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

Each confirmed wallet has rules for buys, sells, outbound transfers, and token
creation. For Robinhood and BSC these per-wallet rules are shared with the
address annotation; each chain still applies them only to its own events and its
own Bark destination. Each rule controls detection, browser sound, and immediate
Bark delivery. Existing wallets migrate with buy detection enabled and every new
alert channel disabled.

Buys and sells are classified from ERC-20 `Transfer` logs only after validating
the originating wallet, successful receipt, and a recognized trade event. The
default EVM events are V2 and V3 swaps; BSC additionally recognizes Four.meme
TokenManager bonding-curve buy and sell events before PancakeSwap migration. Outbound
ERC-20 transfers without a swap are classified as transfers; full blocks cover
plain native-coin transfers and direct ERC-20 deployments. Noxa launches are
attributed from the official factory's indexed `TokenLaunched.deployer` event.
Events are deduplicated by transaction hash and log index. The existing same-CA
cluster alert counts only distinct-wallet buy events within the configured
window.

Base and BSC reuse the verified EVM receipt and swap-log model with chain-specific
RPCs, quote tokens, explorer links, and no Noxa listener. BSC recognizes WBNB,
USDT, USDC, BUSD, FDUSD, DAI, TUSD, and USDD as quote assets and attributes Four.meme creation
events to the creator encoded by its active TokenManager. Solana consumes Helius
Enhanced Transactions, derives buy and sell events from signed wallet token
balance changes, handles SPL/native transfers, and recognizes SPL
`InitializeMint`/`InitializeMint2` creation. Solana signatures are preserved as
case-sensitive Base58 values and are durably deduplicated before event storage.

Manual Solana Holder scans query legacy SPL Token and Token-2022 accounts,
aggregate balances by owner, and verify top owners are ordinary System Program
accounts. Oversized scans fall back to the RPC's largest-account result and are
marked partial.

## Deployment

- `npm run release:prepare` builds a reproducible `dist/release` staging
  directory with all four bundles, static assets, systemd units, environment
  templates, `REVISION`, and `SHA256SUMS`. A dirty worktree is rejected by
  default.
- `deploy/bootstrap-host.sh` idempotently creates the unprivileged service
  account, production directories, and missing environment files on a fresh
  host. It never overwrites populated configuration.
- `deploy/robinhood-radar.service`, `deploy/base-radar.service`,
  `deploy/bsc-radar.service`, and `deploy/solana-radar.service` are the isolated
  systemd units. Start from the five committed `deploy/*.env.example` templates
  and keep populated files in
  `/etc/robinhood-radar/` with mode `0600`.
- `deploy/install-remote.sh` installs a prepared release with backup and rollback
  checks for all four binaries, their chain databases, the independent social
  database, the shared Robinhood/BSC address database, and all service units. It
  verifies the complete checksum manifest before stopping a service.
- `deploy/dqdai-prediction-backup-retention.sh` is installed separately with its
  service and hourly timer. It deletes only `all_predictions-*.json` snapshots in
  the three DQD AI backup directories after 48 hours; current prediction data and
  website files are outside its match scope.
- `deploy/Caddyfile.example` contains the prefix-based reverse proxy used by the
  radar URL. Set `RADAR_SITE_ADDRESS` and `RADAR_CANONICAL_ORIGIN` in the Caddy
  service environment. An optional legacy site can redirect to the canonical
  HTTPS page so social watchlist writes never cross plaintext HTTP. It does not
  add a browser login; the exact Solana webhook route remains protected by the
  independent `SOLANA_HELIUS_AUTH_HEADER` secret.
- If a complete `Caddyfile` is included in the deployment staging directory,
  `deploy/install-remote.sh` backs up, validates, installs, reloads, publicly
  verifies, and rolls it back with the rest of the release. External `.LEGAL.txt`
  bundle files are installed when generated but are not required when esbuild
  emits none.
- Production installation rejects a Solana monitor whose Helius subscription is
  not ready. The installer allows 120 seconds for a legitimate first Helius
  webhook synchronization by default; operators can override this deployment-only
  window with `SOLANA_MONITOR_READY_TIMEOUT_SECONDS`. A deployment that
  intentionally provides only Solana Holder scans must set
  `ALLOW_SOLANA_DEGRADED=1`; the installer then prints the exact degraded reasons
  instead of presenting the monitor as real-time.

Runtime databases, environment files, cookies, browser artifacts, logs, and
build output are intentionally ignored and must not be committed.

Robinhood real-time ERC-20 events are enriched asynchronously with sellability,
liquidity, top-10 holder concentration, creator holdings, mintability, and
creator launch history. These fields are cached per token and patched into the
live feed after the event is emitted, so upstream risk services do not delay
buy, sell, transfer, or launch detection. Base, BSC, and Solana do not request or
render this Robinhood-only enrichment. Creator "dead" history means a token is
at least 24 hours old and either has no DexScreener pair or has less than
`$1,000` of primary-pool liquidity; partial history is displayed as a lower
bound.

This repository is research tooling, not an execution engine or financial
advice. Verify detected activity independently before acting on it.
