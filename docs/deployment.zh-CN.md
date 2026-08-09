# 1874catch 完整部署手册

本文面向第一次接触本项目的部署者，目标是在一台全新的
Ubuntu/Debian VPS 上运行 Robinhood、Base、BSC、Solana 四个独立服务，并通过
Caddy 暴露统一 HTTPS 网站。命令中的域名、服务器地址和密钥都是占位符，
必须替换成部署者自己的值。

## 1. 架构和端口

| 组件 | systemd 服务 | 本地监听 | 数据库 |
| --- | --- | --- | --- |
| Robinhood、网页、社媒 API | `robinhood-radar` | `127.0.0.1:18118` | `robinhood.sqlite`、`social.sqlite`、共享 `evm-wallets.sqlite`和 `bark.sqlite` |
| Base | `base-radar` | `127.0.0.1:18119` | `base.sqlite`、共享 `bark.sqlite` |
| BSC | `bsc-radar` | `127.0.0.1:18122` | `bsc.sqlite`、共享 `evm-wallets.sqlite`和 `bark.sqlite` |
| Solana | `solana-radar` | `127.0.0.1:18120` | `solana.sqlite`、共享 `bark.sqlite` |
| Telegram 只读消息和翻译 | `telegram-viewer` | `127.0.0.1:18123` | `telegram_ca_alerts.sqlite`（私有运行目录） |
| HTTPS 和反向代理 | `caddy` | `80`、`443` | 无 |

Robinhood 与 BSC 通过同一个 `evm-wallets.sqlite`共用已确认地址库；地址、别名、
备注、标签、层级、逐钱包事件规则和启用/排除状态会双向同步。两条链的候选地址、
手工金狗 CA 扫描、代币结果、盈亏、实时流水、去重状态和告警阈值仍分别保存在
`robinhood.sqlite`与 `bsc.sqlite`。Base、Solana 的地址库和全部链上数据仍然独立。
四个进程都通过 `BARK_DATA_FILE=/var/lib/robinhood-radar/bark.sqlite`连接同一个 Bark
库，设备、启停状态、提示音和响度立即双向同步；切链不会清空 Bark。Robinhood
进程负责网页和唯一共享的社媒 API；切换链也不会切换或复制社媒监控数据。

生产目录：

```text
/opt/robinhood-radar/          程序 bundle 和网页静态文件
/var/lib/robinhood-radar/      七个运行数据库
/etc/robinhood-radar/          私有环境变量
/var/backups/robinhood-radar/  安装器生成的数据库和版本备份
/var/lib/robinhood-radar/telegram/  Telegram 登录会话、选择、头像和媒体（不进 Git）
```

## 2. 部署前准备

需要准备：

- 一台带公网 IP 的 Ubuntu 22.04/24.04 或当前 Debian VPS
- 一个已把 `A`/`AAAA`记录指向 VPS 的域名，例如 `radar.example.com`
- 对 VPS 的 `root`或等价 `sudo`权限
- 构建机上的 Git、Node.js 22.13.0、npm、OpenSSH client（提供 `ssh`和
  `scp`）及 `rsync`
- 开放入站 TCP `80`和 `443`
- 要启用 Solana 实时监控时，需要一个 Helius API Key
- 要启用 DeBot 社媒监控时，需要一台长期运行 Chrome 的电脑和已登录的
  DeBot 账号
- 要启用手机推送时，需要 Bark 应用提供的设备 Key
- 要启用 Telegram 只读监控时，需要 Telegram API ID/Hash 和一次性登录会话；凭据、
  session、频道选择和媒体只保存在 VPS 的 Telegram 数据目录
- 要启用飞书人物监控时，需要在 VPS 安装官方 `lark-cli`，并用运行服务的
  `robinhood-radar`用户完成一次应用配置和账号授权；本地电脑无需常驻

Robinhood、Base 和 BSC 默认使用公开 RPC，可以启动和体验。大量钱包的长期生产
监控建议配置自己的稳定 RPC。Solana 公共 RPC 只用于人工 Holder 查询，不能
代替 Helius 实时 Webhook。

## 3. 安装主机依赖

以下命令在 VPS 上以 `root`执行。先安装通用工具：

```bash
apt-get update
apt-get install -y ca-certificates curl git gnupg openssl rsync sqlite3 tar
```

安装 Node.js 22.13.0 或更高版本。下面使用 NodeSource 安装脚本；也可以使用
发行版或企业内部提供的等价 Node.js 22 包：

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
bash /tmp/nodesource_setup.sh
apt-get install -y nodejs
node --version
npm --version
```

安装 Caddy 官方包：

```bash
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
  > /etc/apt/sources.list.d/caddy-stable.list
chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg
chmod o+r /etc/apt/sources.list.d/caddy-stable.list
apt-get update
apt-get install -y caddy
```

确认版本和服务：

```bash
node -p 'process.versions.node'
caddy version
systemctl is-enabled caddy
```

不要从不可信镜像下载预编译的本项目 bundle。建议在自己的构建机上从 Git
源码生成发布包。

## 4. 构建和测试发布包

构建机还要负责上传发布包和可选数据库快照。Debian/Ubuntu 构建机可安装并检查：

```bash
sudo apt-get update
sudo apt-get install -y git openssh-client rsync
command -v git
command -v ssh
command -v scp
command -v rsync
```

macOS 通常已经包含 OpenSSH client；仍应确认 `ssh`、`scp`和 `rsync`都可用。
这些命令运行在构建机，不是 VPS 的发布目录中。

在可信构建机上执行：

```bash
git clone https://github.com/1250237215/robinhoodwallet.git
cd robinhoodwallet
npm ci
npm test
npm run release:prepare
```

上面的最后一行适合不由安装器管理整份 Caddy 配置的主机。如果这是由安装器管理
整份 Caddy 配置的专用新主机，请用下面的命令替代最后一行，
让 `Caddyfile`在构建阶段进入校验清单：

```bash
npm run release:prepare -- --caddy deploy/Caddyfile.example
```

`release:prepare`要求 Git 工作区干净，默认生成 `dist/release/`。其中包括：

```text
robinhood-server.mjs
base-server.mjs
bsc-server.mjs
solana-server.mjs
public.tar.gz
robinhood-radar.service
base-radar.service
bsc-radar.service
solana-radar.service
telegram-viewer.service
telegram.env.example
telegram.tar.gz
feishu-monitor.service
feishu.env.example
feishu.tar.gz
robinhood.env.example
base.env.example
bsc.env.example
solana.env.example
social.env.example
translation.env.example
Caddyfile.example
bootstrap-host.sh
install-remote.sh
REVISION
SHA256SUMS
Caddyfile                    仅使用 --caddy 时存在
```

自定义输出目录：

```bash
npm run release:prepare -- --output /absolute/path/to/release
```

`--allow-dirty`只适合开发验证；正式发布不要使用带 `-dirty`的 `REVISION`。
`--caddy`会让安装器整份替换远端 Caddy 配置，只适合专用的新主机，不能对
已经承载其他网站的 Caddy 主机随意使用。

## 5. 上传并初始化主机

先上传到唯一的临时目录，校验完成后再改成安装器使用的固定目录，避免安装器
读到只上传了一半的文件：

```bash
SERVER=root@your-vps.example.com
REMOTE_TMP=/root/robinhood-radar-deploy.incoming-$(date +%s)

rsync -a --delete dist/release/ "$SERVER:$REMOTE_TMP/"
ssh "$SERVER" "cd '$REMOTE_TMP' && sha256sum -c SHA256SUMS"
ssh "$SERVER" "rm -rf /root/robinhood-radar-deploy && mv '$REMOTE_TMP' /root/robinhood-radar-deploy"
```

同一时间只能运行一个部署。然后在 VPS 上初始化服务用户、目录和缺失的环境
文件：

```bash
cd /root/robinhood-radar-deploy
./bootstrap-host.sh
```

这个脚本是幂等的：重复执行不会覆盖已有的 `/etc/robinhood-radar/*.env`。
它不安装 Node.js 或 Caddy，只会验证依赖、创建无登录权限的
`robinhood-radar`用户、生产目录和第一次使用的环境变量模板。

### 飞书 CLI 只在 VPS 运行

使用飞书官方安装方式把 `lark-cli`安装为 `/usr/local/bin/lark-cli`，然后以服务
用户完成一次配置和登录。不要用 `root`授权，否则 systemd 服务无法读取对应配置：

```bash
sudo -u robinhood-radar \
  env HOME=/var/lib/robinhood-radar/feishu \
  /usr/local/bin/lark-cli config init --new --lang zh

sudo -u robinhood-radar \
  env HOME=/var/lib/robinhood-radar/feishu \
  /usr/local/bin/lark-cli auth login --recommend

sudo -u robinhood-radar \
  env HOME=/var/lib/robinhood-radar/feishu \
  /usr/local/bin/lark-cli auth status --verify
```

浏览器只用于完成飞书官方授权。授权配置保存在
`/var/lib/robinhood-radar/feishu/.lark-cli/`，不上传到 Git，也不依赖部署者的
本地电脑持续在线。

## 6. 配置环境变量

所有生产环境文件应保持 `root:root`和 `0600`：

```bash
chown root:root /etc/robinhood-radar/*.env
chmod 0600 /etc/robinhood-radar/*.env
```

### 四链共用 Bark

四个 systemd unit 都必须使用同一个共享库：

```dotenv
BARK_DATA_FILE=/var/lib/robinhood-radar/bark.sqlite
```

这个库只保存 Bark API 目标、目标启用状态、提示音和音量。切换 Robinhood、Base、
BSC、Solana 不会切换 Bark 配置；钱包、链上流水、CA 扫描、PnL、告警去重等数据仍然
保存在各链自己的数据库中。首次启用时，程序会自动导入旧链库中的 Bark 配置；导入
完成后即使删除共享目标，也不会在重启时从旧库重新恢复。

### Robinhood

编辑 `/etc/robinhood-radar/robinhood.env`：

```dotenv
# 留空时使用项目内置的公开端点
ROBINHOOD_RPC_URL=
ROBINHOOD_BLOCKSCOUT_API_URL=

ROBINHOOD_REQUEST_TIMEOUT_MS=20000
ROBINHOOD_MARKET_REQUEST_TIMEOUT_MS=5000
ROBINHOOD_TOKEN_RISK_REQUEST_TIMEOUT_MS=5000
ROBINHOOD_MONITOR_POLL_INTERVAL_MS=500
ROBINHOOD_MONITOR_LOG_CONCURRENCY=2
```

不要在不理解限流策略时提高并发。监控器在 `429`、超时或连续错误后会自动
进入保护模式。

### Base

编辑 `/etc/robinhood-radar/base.env`：

```dotenv
BASE_RPC_URL=
BASE_BLOCKSCOUT_API_URL=
BASE_REQUEST_TIMEOUT_MS=20000
BASE_MARKET_REQUEST_TIMEOUT_MS=5000
BASE_MONITOR_POLL_INTERVAL_MS=500
BASE_MONITOR_LOG_CONCURRENCY=2
```

### BSC

编辑 `/etc/robinhood-radar/bsc.env`：

```dotenv
BSC_RPC_URL=
BSC_DEBOT_BRIDGE_URL=http://127.0.0.1:18118/internal/debot/request
BSC_DEBOT_BRIDGE_TIMEOUT_MS=90000
BSC_DEBOT_REQUEST_TIMEOUT_MS=95000

# 可选：填写后切换到严格的完整 Transfer 账本模式
BSC_HOLDER_RPC_URL=
# 可选：严格模式专用日志入口；留空时复用上面的状态入口
BSC_HOLDER_LOG_RPC_URL=
BSC_ALLOW_SHARED_RPC_ENDPOINT=false
BSC_REQUEST_TIMEOUT_MS=20000
BSC_MARKET_REQUEST_TIMEOUT_MS=5000
BSC_MONITOR_POLL_INTERVAL_MS=500
BSC_MONITOR_LOG_CONCURRENCY=2
BSC_MONITOR_MAX_BLOCK_SPAN=10
BSC_HOLDER_LOG_WINDOW=2000
BSC_HOLDER_LOG_CONCURRENCY=2
BSC_HOLDER_MAX_TRANSFER_LOGS=100000
BSC_HOLDER_MAX_BLOCK_SPAN=5000000
```

BSC 服务监听 `127.0.0.1:18122`；链上分析数据写入 `bsc.sqlite`，已确认地址注释和
逐钱包监控规则通过 `EVM_WALLET_DATA_FILE=/var/lib/robinhood-radar/evm-wallets.sqlite`
与 Robinhood 共用。Robinhood 的 systemd unit 设置同一个路径；Base 与 Solana 不使用
该共享钱包库。四条链只通过 `BARK_DATA_FILE` 共用 Bark 配置。实时监控使用
`BSC_RPC_URL`，未填写时使用 Blast 的免密公共入口；该入口限制单次日志查询最多
10 个区块，所以 BSC 默认日志窗口也是 10。生产环境仍建议填写支持完整实时查询的
独立 RPC。服务启动时会校验实时入口严格返回 `eth_chainId 0x38`，并能批量返回
近期已确认交易和回执。错链或回执能力不足时会在创建数据库前拒绝启动，避免服务
假在线但买入、卖出流水无法验证。

BSC 手工金狗 CA 和聪明钱包分析默认不需要 `BSC_HOLDER_RPC_URL`。默认模式通过
`BSC_DEBOT_BRIDGE_URL`连接 Robinhood 进程提供的本机内部入口，再由已登录 DeBot 的
Chrome 扩展读取按持仓量倒序排列的前 100 个当前 Holder。VPS 会验证返回的链、CA、
地址、数量和数据大小，并用 BSC 实时 RPC 的最新 `eth_getCode`排除合约地址；已知
池子、交易所、桥、工厂、锁仓和销毁地址也不会进入钱包评分。DeBot 超过 100 个
Holder 时结果会如实标记为部分样本，不会声称覆盖完整 Holder 总体。内部入口只能
使用 `127.0.0.1`、`localhost`或 `::1`，Caddy 必须拒绝公网 `/internal/*`请求。

`BSC_DEBOT_BRIDGE_TIMEOUT_MS`是等待浏览器完成任务的最长时间；外层的
`BSC_DEBOT_REQUEST_TIMEOUT_MS`必须更长，示例使用 `90000`和 `95000`毫秒。扩展离线
或版本过旧时，BSC 实时流水仍会继续运行，但手工 CA 分析会明确失败。

只有需要严格完整的当前 Holder 账本时才填写 `BSC_HOLDER_RPC_URL`。填写后会从经
历史合约代码确认的部署块开始分窗重放 ERC-20 `Transfer`日志，再用 `totalSupply`和
链上 `balanceOf`核对。这个状态入口负责链头、历史 `eth_getCode`、供应量、余额和
EOA/合约检查，必须具备归档状态能力。

`BSC_HOLDER_LOG_RPC_URL`是可选的日志专用入口，只负责完整返回 `eth_getLogs`；它不
需要提供历史状态。留空时，日志仍由 `BSC_HOLDER_RPC_URL`读取。状态入口和日志入口
可以是同一个客户端或相同 URL。三个入口都会在数据库创建前校验为 BSC `0x38`。
实时监控客户端与 Holder 日志客户端绝不能是同一个对象，它们的标准化 URL 也必须
始终不同。能隔离时应保持 `BSC_ALLOW_SHARED_RPC_ENDPOINT=false`；这还会
要求实时监控与 Holder 状态使用不同 URL。只有生产环境确实必须让实时监控和 Holder
状态使用同一 URL、同时又给高流量 Holder 日志配置了独立入口时，才应设为 `true`。
这个开关永远不会允许实时监控与 Holder 日志共享 URL。任何起点、日志或余额无法
完整验证时，严格模式都会明确失败。不要把供应商密钥写进仓库内的
`bsc.env.example`。

BSC 实时判断除 PancakeSwap V2/V3 外，也识别 Four.meme 当前 TokenManager 的
bonding-curve 买入、卖出和创建代币事件；WBNB、USDT、USDC、BUSD、FDUSD、DAI、
TUSD、USDD 被当作
报价资产，不会误报成买入目标。社媒监控仍是共享 `/api/social`，切换 BSC 不会
复制、清空或切换社媒名单。

### 社媒桥接

生成一个只用于浏览器桥接的随机 bearer token：

```bash
openssl rand -hex 32
```

把结果填入 `/etc/robinhood-radar/social.env`：

```dotenv
SOCIAL_BRIDGE_TOKEN=替换为随机值

# 可选：最多五个需要额外低延迟轮询的 X handle，用逗号分隔，不写 @
SOCIAL_X_FAST_HANDLES=
SOCIAL_X_FAST_POLL_INTERVAL_MS=500
SOCIAL_X_FAST_MAX_IN_FLIGHT=3
SOCIAL_X_FAST_REQUEST_TIMEOUT_MS=3500
SOCIAL_X_REPLY_ENRICHMENT=true
```

这个 token 只授权社媒名单和浏览器桥接写入，不是网站登录密码。不要通过聊天、
截图、Issue 或 Git 提交公开它。

### DeepSeek 翻译

X 主帖、回复、引用原文和 Telegram 消息统一由 VPS 后台翻译。浏览器扩展上传的
DeBot 翻译不会作为最终译文，API Key 也不会进入浏览器。把 DeepSeek Key 填入
权限为 `0600` 的 `/etc/robinhood-radar/translation.env`：

```dotenv
DEEPSEEK_TRANSLATION_API_KEY=替换为你的Key
DEEPSEEK_TRANSLATION_BASE_URL=https://api.deepseek.com
DEEPSEEK_TRANSLATION_MODEL=deepseek-v4-flash
DEEPSEEK_TRANSLATION_TIMEOUT_MS=8000
DEEPSEEK_TRANSLATION_CONCURRENCY=3
```

`deepseek-v4-flash` 是低延迟、非推理模型，适合实时短文本。原文会先立即显示，
译文完成后再增量更新；翻译失败不会阻塞 X 或 Telegram 流水。X 历史译文会分页
走低优先级回填，成功结果保存在 `social.sqlite` 的专用缓存表；长文本会分段完整
翻译，不会在 5000 字符处静默截断。

### Solana 和 Helius

生成独立的 Webhook Authorization 值：

```bash
openssl rand -hex 32
```

编辑 `/etc/robinhood-radar/solana.env`：

```dotenv
SOLANA_RPC_URL=
SOLANA_REQUEST_TIMEOUT_MS=20000

HELIUS_API_KEY=替换为自己的HeliusKey
SOLANA_HELIUS_WEBHOOK_URL=https://radar.example.com/robinhood-radar/api/solana/monitor/webhook
SOLANA_HELIUS_AUTH_HEADER=替换为另一个随机值
```

服务会使用 Helius API 自动创建、更新和去重 Enhanced Webhook，并随已确认钱包
名单变化同步地址，不需要手工在 Helius 后台重复维护地址。回调 URL 必须是公网
HTTPS，Authorization 必须与服务器配置完全相同。

没有 Helius 时可以先部署 Holder 查询和手工功能，但必须在安装时明确设置
`ALLOW_SOLANA_DEGRADED=1`。此时网页会如实显示 Solana 实时监控未就绪。

## 7. 配置 Caddy 和 HTTPS

### 专用的新主机

专用新主机的发布包必须已经在构建阶段使用
`--caddy deploy/Caddyfile.example`加入了受校验的 `Caddyfile`。在 VPS 上确认：

```bash
cd /root/robinhood-radar-deploy
test -f Caddyfile
grep '  Caddyfile$' SHA256SUMS
sha256sum -c SHA256SUMS
```

如果 `Caddyfile`不存在，应回到构建机重新生成并上传发布包。不要在 VPS staging
目录里临时复制文件或重写 `SHA256SUMS`，否则无法证明安装内容与构建产物一致。

Caddyfile 使用三个环境变量。创建 systemd override：

```bash
install -d -m 0755 /etc/systemd/system/caddy.service.d
cat >/etc/systemd/system/caddy.service.d/1874catch.conf <<'EOF'
[Service]
Environment=RADAR_SITE_ADDRESS=radar.example.com
Environment=RADAR_CANONICAL_ORIGIN=https://radar.example.com
Environment=RADAR_LEGACY_SITE_ADDRESS=http://127.0.0.1:8080
EOF
systemctl daemon-reload
```

把示例域名替换成自己的域名。若不需要旧 HTTP 地址，保留回环地址即可；若确实
有旧地址需要跳转，再把 `RADAR_LEGACY_SITE_ADDRESS`改成部署者自己的旧站点。
Caddy 会在 DNS 正确且 80/443 可访问时自动申请 TLS 证书。

### 已经承载其他网站的主机

不要把 `Caddyfile.example`作为整份配置交给安装器。把其中 1874catch 的站点
块人工合并到现有 `/etc/caddy/Caddyfile`，先执行：

```bash
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
```

确认不会覆盖其他站点后再 reload。安装器只有在 staging 里存在名为
`Caddyfile`的文件时才会替换远端整份配置。

## 8. 第一次安装

正式安装并进行公网健康检查：

```bash
cd /root/robinhood-radar-deploy
RADAR_PUBLIC_BASE_URL=https://radar.example.com/robinhood-radar \
  ./install-remote.sh
```

安装器默认最多等待 Solana 的 Helius 实时订阅 `120`秒，避免首次创建或同步
Webhook 时因短暂的 `degraded`状态误判安装失败。这个等待只影响部署健康检查，
不会改变服务运行时的 RPC 或 Webhook 超时。钱包很多、Helius 首次同步确实需要
更长时间时，可以在本次安装中显式调大，例如：

```bash
SOLANA_MONITOR_READY_TIMEOUT_SECONDS=240 \
RADAR_PUBLIC_BASE_URL=https://radar.example.com/robinhood-radar \
  ./install-remote.sh
```

本地和公网健康请求默认使用 `2`秒连接超时、`5`秒单次请求总超时；可分别通过
`DEPLOY_HEALTH_CONNECT_TIMEOUT_SECONDS`和
`DEPLOY_HEALTH_REQUEST_TIMEOUT_SECONDS`调整。Robinhood、Base、BSC 的 monitor 默认
等待 `30`秒，可通过 `DEPLOY_MONITOR_READY_TIMEOUT_SECONDS`调整。上述值都必须是
正整数秒；不要用延长窗口掩盖无效的 Helius Key、错误的 Webhook URL 或网络故障。

暂时没有 Helius 的明确降级安装：

```bash
cd /root/robinhood-radar-deploy
ALLOW_SOLANA_DEGRADED=1 \
RADAR_PUBLIC_BASE_URL=https://radar.example.com/robinhood-radar \
  ./install-remote.sh
```

安装器会在停止服务前验证 `SHA256SUMS`，随后：

1. 记录四个服务原来的启停状态。
2. 对七个 SQLite 数据库执行 WAL checkpoint、事务一致备份和
   `PRAGMA quick_check`。
3. 备份现有 bundle、网页、systemd unit、版本标记和可选 Caddy 配置。
4. 安装新文件并启动四项服务。
5. 检查四个 dashboard、四个实时 monitor、Social API 和七个数据库，并确认四个
   monitor 返回完全相同的 Bark 设备、提示音和响度。
6. 失败时自动恢复上一个程序、数据库、网页、服务状态和本次修改的 Caddy。

成功输出中的数据库备份路径和 `release_backup`应保存到运维记录。安装成功后
staging 目录会被删除，避免旧发布包被误用。

## 9. 验证部署

在 VPS 上检查：

```bash
systemctl --no-pager --full status robinhood-radar base-radar bsc-radar solana-radar feishu-monitor caddy
journalctl -u robinhood-radar -u base-radar -u bsc-radar -u solana-radar -u feishu-monitor --since '10 minutes ago' --no-pager

curl --fail http://127.0.0.1:18118/api/robinhood/dashboard?tab=all >/dev/null
curl --fail http://127.0.0.1:18119/api/base/dashboard?tab=all >/dev/null
curl --fail http://127.0.0.1:18122/api/bsc/dashboard?tab=all >/dev/null
curl --fail http://127.0.0.1:18120/api/solana/dashboard?tab=all >/dev/null
curl --fail http://127.0.0.1:18118/api/social?postLimit=1 >/dev/null
curl --fail http://127.0.0.1:18124/api/snapshot >/dev/null
```

在其他电脑检查公网：

```bash
curl --fail --location https://radar.example.com/robinhood-radar/ >/dev/null
curl --fail --location 'https://radar.example.com/robinhood-radar/api/robinhood/monitor' >/dev/null
curl --fail --location 'https://radar.example.com/robinhood-radar/api/bsc/monitor' >/dev/null
curl --fail --location 'https://radar.example.com/robinhood-radar/api/social?postLimit=1' >/dev/null
curl --fail --location 'https://radar.example.com/robinhood-radar/feishu/api/snapshot' >/dev/null
```

浏览器打开 `https://radar.example.com/robinhood-radar/`，确认四链切换后链上数据
互不串联，社媒面板始终相同，Bark 设备、启停状态、提示音和响度也始终相同。SSE
路由在 Caddy 中明确禁用压缩并使用 `flush_interval -1`，不要把它们改成带缓冲的
普通代理。

## 10. 配置 DeBot 社媒桥接

扩展运行在部署者自己的 Chrome 中，利用已经登录的 `debot.ai`页面读取个人
监控动态。它不会把 DeBot Cookie、密码、localStorage 或 WebSocket 授权内容
上传到 VPS。

1. 在本地克隆的仓库中找到 `bridge/debot-social-bridge/`。
2. 打开 `chrome://extensions`，启用“开发者模式”。
3. 选择“加载已解压的扩展程序”，选中上述目录。
4. 打开扩展详情，进入“扩展程序选项”。
5. 社媒服务地址填写：

   ```text
   https://radar.example.com/robinhood-radar/api/social
   ```

6. 配对密钥填写 `/etc/robinhood-radar/social.env`中的
   `SOCIAL_BRIDGE_TOKEN`。
7. Chrome 会请求访问这个明确配置的 Radar HTTPS 主机；只批准自己的域名。
8. 打开并登录 `https://debot.ai/`。扩展第一次成功心跳后角标显示 `ON`。

现有部署升级到 BSC Holder 支持时，扩展必须是 `1.9.0`。拉取新代码后打开
`chrome://extensions`，找到 **Radar DeBot Social Bridge** 并点击“重新加载”；然后
重新打开或刷新已登录的 DeBot 标签页，再刷新 Radar 页面。只更新 VPS 而没有重新
加载本地扩展时，旧扩展不会领取 BSC Holder 任务。

在 VPS 上确认版本、在线状态和 Holder capability：

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

成功输出必须是 `DeBot Holder bridge 1.9.0 ready`。失败时打印的 bridge JSON 应同时
检查 `version`、`holderAnalysisOnline`和 `capabilities`；列表里必须包含
`debot-token-holders-v1`。

扩展固定拥有的主机权限只有 DeBot。Radar 权限是在设置时针对部署者填写的
HTTPS origin 单独申请；HTTP 仅允许 `localhost`和 `127.0.0.1`开发地址。
后台发送每个带 token 的请求前仍会再次校验 origin 和权限。

完整桥接行为见 `bridge/debot-social-bridge/README.md`。

## 11. 配置 Telegram 只读监控

Telegram 查看器是独立的只读服务，不会发送、转发、编辑或删除消息。安装器会把
脱敏源码放到 `/opt/robinhood-radar/telegram`，并保留已有的 `.venv`；登录会话、
API ID/Hash、频道选择、头像、媒体和 CA 提醒状态只放在
`/var/lib/robinhood-radar/telegram`，不会进入发布包或 GitHub。

首次启用时，在 VPS 上创建 Python 虚拟环境并安装依赖（只需一次）：

```bash
cd /opt/robinhood-radar/telegram
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
chown -R root:root /opt/robinhood-radar/telegram
```

然后用一次性设置命令登录 Telegram 并选择要监控的群组/频道。登录过程中输入的
API Hash、手机号、验证码和两步验证密码只写入 `/var/lib/robinhood-radar/telegram`
下的私有文件：

```bash
install -d -o robinhood-radar -g robinhood-radar -m 0700 /var/lib/robinhood-radar/telegram
sudo -u robinhood-radar env TG_RUNTIME_DIR=/var/lib/robinhood-radar/telegram \
  TG_VIEWER_RUNTIME_DIR=/var/lib/robinhood-radar/telegram \
  /opt/robinhood-radar/telegram/.venv/bin/python \
  /opt/robinhood-radar/telegram/viewer.py --setup
```

在 `/etc/robinhood-radar/telegram.env` 中可以额外填写已知敏感聊天 ID：

```dotenv
TG_VIEWER_BLOCKED_CHAT_IDS=
# 如需 Telegram CA Bark，把这里设置为与 robinhood.env 相同的随机值
TELEGRAM_BARK_INTERNAL_TOKEN=
```

服务端会在目录、选择、历史消息和实时事件四层过滤明显成人/受限聊天；启动时还
会把自动识别到的敏感 ID 固定写入 `viewer_config.json`，频道改名后也不会重新出现在
选择列表。Telegram 原文先显示，后台翻译完成后通过 `translated_text` 增量更新；历史
回填与实时翻译分开限流，旧消息不会阻塞新消息。网页入口为：
`https://radar.example.com/robinhood-radar/telegram/`。

Telegram 服务与 Robinhood 社媒服务共同读取 `/etc/robinhood-radar/translation.env`。
成功的 Telegram 译文会以原文哈希写入私有的
`/var/lib/robinhood-radar/telegram/telegram_translation_cache.sqlite`，不保存原文，
服务重启时可直接复用。修改 DeepSeek 配置后需要重启 `robinhood-radar` 和
`telegram-viewer`。

检查服务和翻译字段：

```bash
systemctl --no-pager --full status telegram-viewer
curl --fail http://127.0.0.1:18123/api/chats >/dev/null
curl --fail 'http://127.0.0.1:18123/api/messages?limit=1' | jq '.messages[0] | {text, translated_text}'
curl --fail http://127.0.0.1:18123/api/status | jq '.translation'
```

如果翻译暂时失败，Telegram 流水仍会正常显示原文；服务不会因翻译接口超时而停止。
状态中的 `last_error` 只记录 `http_401`、`http_429`、`timeout` 等脱敏类别，不包含 key
或响应正文。鉴权和请求错误会立即停止，只有限流、超时和服务端错误会重试。

## 12. 配置 Bark

完整设备 Key 只保存在共享的 `/var/lib/robinhood-radar/bark.sqlite`中。四个 systemd
unit 固定使用同一个 `BARK_DATA_FILE`，所以在任意链添加、暂停、删除设备或修改
提示音、响度，其他链立即使用同一结果；切链不会丢失 Bark 配置：

1. 打开网站的“实时监控”。
2. 在监控设置里的“Bark 推送”输入 Bark 应用给出的 Key，或完整
   `https://api.day.app/你的Key`。
3. 填写设备备注并添加。
4. 点击发送图标进行测试，确认手机收到测试通知。
5. 设置 Bark 提示音和响度。
6. 编辑已确认钱包，在买入、卖出、转账、创建代币各行分别勾选 Bark。

接口只接受官方 `https://api.day.app`，网页读取列表时只返回遮罩后的地址。各钱包
买入、卖出、转账和发币是否触发 Bark，仍由对应钱包的事件规则决定；共享目标不
会混合不同链的事件数据。不要把 `bark.sqlite`或任何包含 Bark Key 的生产数据库
上传到 GitHub。

## 13. 可选：恢复公开 Robinhood 数据快照

公开快照已删除旧的 Bark 目标和 Bark 设置，而且不包含当前私有的 `bark.sqlite`；
它仍包含公开钱包地址、人工备注、代币分析和历史监控事件。恢复 Robinhood 快照
不会替换现有共享 Bark 库。部署空白数据库时不需要恢复；需要示例数据时才执行。

先在保存源码的电脑上把快照传到 VPS：

```bash
scp database/robinhood-public.sqlite.gz root@your-vps.example.com:/root/
```

然后在 VPS 上运行 `bootstrap-host.sh`创建服务用户和目录。下面的恢复命令使用
`set -Eeuo pipefail`，任何校验、停服、备份、替换、启动或健康检查失败都会立即
停止。它只忽略 `LoadState=not-found`的 unit；已经存在但无法停止的 unit 会让恢复
失败。候选库先完整解压并通过 `PRAGMA quick_check`，之后才短暂停止服务：

```bash
set -Eeuo pipefail

SERVICE=robinhood-radar.service
ARCHIVE=/root/robinhood-public.sqlite.gz
DATA_DIR=/var/lib/robinhood-radar
BACKUP_DIR=/var/backups/robinhood-radar
DATABASE="$DATA_DIR/robinhood.sqlite"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP="$BACKUP_DIR/robinhood-before-public-restore-$STAMP.sqlite"
CANDIDATE=""
UNIT_PRESENT=0
WAS_ACTIVE=0
HAD_DATABASE=0
BACKUP_READY=0
REPLACED=0
COMPLETED=0

recover_public_restore() {
  status=$?
  trap - EXIT ERR INT TERM HUP
  if [[ $COMPLETED -eq 1 ]]; then
    return
  fi
  [[ $status -ne 0 ]] || status=1
  set +e
  recovery_failed=0
  database_restore_ok=1
  echo "Public database restore failed; restoring the previous state." >&2

  if [[ -n "$CANDIDATE" ]]; then
    rm -f "$CANDIDATE" || recovery_failed=1
  fi
  if [[ $REPLACED -eq 1 ]]; then
    if [[ $UNIT_PRESENT -eq 1 ]]; then
      if ! systemctl stop "$SERVICE"; then
        recovery_failed=1
        database_restore_ok=0
      fi
      if ! recovery_state="$(systemctl show --property=ActiveState --value "$SERVICE")"; then
        database_restore_ok=0
      elif [[ "$recovery_state" != inactive ]]; then
        database_restore_ok=0
      fi
    fi
    if [[ $database_restore_ok -ne 1 ]]; then
      recovery_failed=1
      echo "Database was not overwritten because $SERVICE is not confirmed inactive." >&2
    else
      rm -f "$DATABASE-wal" "$DATABASE-shm" || database_restore_ok=0
      if [[ $HAD_DATABASE -eq 1 && $BACKUP_READY -eq 1 ]]; then
        install -o robinhood-radar -g robinhood-radar -m 0640 \
          "$BACKUP" "$DATABASE" || database_restore_ok=0
        test "$(sqlite3 "$DATABASE" 'PRAGMA quick_check;')" = ok || database_restore_ok=0
      else
        rm -f "$DATABASE" || database_restore_ok=0
      fi
      [[ $database_restore_ok -eq 1 ]] || recovery_failed=1
    fi
  fi
  if [[ $WAS_ACTIVE -eq 1 && $database_restore_ok -eq 1 ]]; then
    systemctl start "$SERVICE" || recovery_failed=1
    systemctl is-active --quiet "$SERVICE" || recovery_failed=1
  fi

  if [[ $recovery_failed -ne 0 ]]; then
    echo "Automatic recovery was incomplete; keep services stopped and restore $BACKUP manually." >&2
  fi
  exit "$status"
}
trap recover_public_restore EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

install -d -o robinhood-radar -g robinhood-radar -m 0750 "$DATA_DIR"
install -d -m 0700 "$BACKUP_DIR"
gzip -t "$ARCHIVE"
CANDIDATE="$(mktemp --tmpdir="$DATA_DIR" robinhood-public-restore.XXXXXX.sqlite)"
gzip -dc "$ARCHIVE" > "$CANDIDATE"
chown robinhood-radar:robinhood-radar "$CANDIDATE"
chmod 0640 "$CANDIDATE"
test "$(sqlite3 "$CANDIDATE" 'PRAGMA quick_check;')" = ok

load_state="$(systemctl show --property=LoadState --value "$SERVICE")"
case "$load_state" in
  loaded)
    UNIT_PRESENT=1
    active_state="$(systemctl show --property=ActiveState --value "$SERVICE")"
    case "$active_state" in
      active) WAS_ACTIVE=1 ;;
      inactive) WAS_ACTIVE=0 ;;
      *) echo "$SERVICE has unsafe initial state: $active_state" >&2; false ;;
    esac
    systemctl stop "$SERVICE"
    ;;
  not-found)
    echo "$SERVICE is not installed yet; database will be prepared for the first install."
    ;;
  *)
    echo "$SERVICE has unexpected LoadState: $load_state" >&2
    false
    ;;
esac

if [[ $UNIT_PRESENT -eq 1 ]]; then
  test "$(systemctl show --property=ActiveState --value "$SERVICE")" = inactive
fi

if [[ -f "$DATABASE" ]]; then
  HAD_DATABASE=1
  checkpoint="$(sqlite3 "$DATABASE" 'PRAGMA wal_checkpoint(TRUNCATE);')"
  test "${checkpoint%%|*}" = 0
  test "$(sqlite3 "$DATABASE" 'PRAGMA quick_check;')" = ok
  install -m 0600 "$DATABASE" "$BACKUP"
  test "$(sqlite3 "$BACKUP" 'PRAGMA quick_check;')" = ok
  BACKUP_READY=1
fi

REPLACED=1
rm -f "$DATABASE-wal" "$DATABASE-shm"
mv -f "$CANDIDATE" "$DATABASE"
CANDIDATE=""
chown robinhood-radar:robinhood-radar "$DATABASE"
chmod 0640 "$DATABASE"
test "$(sqlite3 "$DATABASE" 'PRAGMA quick_check;')" = ok

if [[ $UNIT_PRESENT -eq 1 ]]; then
  systemctl start "$SERVICE"
  dashboard_ready=0
  for attempt in $(seq 1 30); do
    if curl --fail --silent --connect-timeout 1 --max-time 3 \
      'http://127.0.0.1:18118/api/robinhood/dashboard?tab=all' >/dev/null 2>&1; then
      dashboard_ready=1
      break
    fi
    sleep 1
  done
  if [[ $dashboard_ready -ne 1 ]]; then
    curl --fail --silent --show-error --connect-timeout 2 --max-time 5 \
      'http://127.0.0.1:18118/api/robinhood/dashboard?tab=all' >/dev/null
  fi
  systemctl is-active --quiet "$SERVICE"
else
  echo "Database restored; run the first release installation before starting the service."
fi

COMPLETED=1
trap - EXIT INT TERM HUP
if [[ $BACKUP_READY -eq 1 ]]; then
  echo "Public database restored; previous database backup: $BACKUP"
else
  echo "Public database restored; no previous database existed."
fi
```

快照的时间、哈希、表数量和脱敏记录见 `database/manifest.json`。服务原来存在时，
成功恢复会启动并验证它；失败时会恢复旧数据库，并且只在服务原来处于 active 时
重新启动。服务 unit 尚不存在时，命令只准备数据库，后续由第一次安装启动服务。
不要直接替换正在运行且启用了 WAL 的数据库。

## 14. 升级和回滚

升级前在构建机执行：

```bash
git fetch origin
git switch main
git pull --ff-only
npm ci
npm test
npm run release:prepare
```

专用 Caddy 主机升级时同样把最后一行替换为
`npm run release:prepare -- --caddy deploy/Caddyfile.example`，确保目标提交的
Caddy 配置也进入 `SHA256SUMS`并随版本一起升级。

然后重复“上传并初始化主机”中的临时目录、SHA 校验和原子改名步骤。已有 env
不会被 `bootstrap-host.sh`覆盖。安装器会为每次升级生成新的 UTC 时间戳备份，
失败时自动回滚。

### 不跨数据库 schema 的代码回退

要主动回退代码，优先在 Git 中检出目标提交，重新测试、构建并按相同发布流程
安装，而不是手工混搭旧 bundle 和新网页：

```bash
git switch --detach <目标提交SHA>
npm ci
npm test
npm run release:prepare
```

专用 Caddy 主机回退时同样把最后一行替换为
`npm run release:prepare -- --caddy deploy/Caddyfile.example`，确保目标提交的
Caddy 配置也进入 `SHA256SUMS`并随版本一起回退。

### 跨数据库 schema 的主动回滚

数据库 schema 可能只保证向前迁移。安装器成功后打印的
`robinhood_database_backup`、`base_database_backup`、`bsc_database_backup`、
`solana_database_backup`、`social_database_backup`、`evm_wallet_database_backup`、
`bark_database_backup`和 `release_backup`描述的是
“本次安装之前”的完整状态。
例如要撤销版本 B 的安装并回到版本 A，必须使用安装 B 成功时打印的这八条路径。
八条路径必须具有完全相同的 UTC 时间戳；不要分别使用 `ls -t`挑选“最新”文件，
也不要把另一次安装的程序备份和数据库备份混用。安装器会删除 staging，所以应把
每次成功输出保存在独立的运维记录中。若旧版本还没有某个数据库，安装器会创建
`<输出路径>.missing`空标记而不是 `.sqlite`文件；下面的命令会保留这个语义，先
删除对应实时库及 WAL/SHM。旧版本认识的库可按旧 schema 重新创建，不认识的新库
（例如回退到共享地址库上线前的版本）则保持不存在。

下面是完整的七库主动回滚流程。先把示例的八条赋值替换为同一次安装器输出的原始
值。只有被撤销的发布包使用了 `--caddy`并由安装器替换整份 Caddy 配置时，才把
`RESTORE_CADDY`设为 `1`；共享 Caddy 主机必须保持 `0`并人工管理站点块。

```bash
set -Eeuo pipefail

# 必须从同一次成功的 install-remote.sh 输出原样复制这八条路径。
robinhood_database_backup=/var/backups/robinhood-radar/robinhood-20260101T000000Z.sqlite
base_database_backup=/var/backups/robinhood-radar/base-20260101T000000Z.sqlite
bsc_database_backup=/var/backups/robinhood-radar/bsc-20260101T000000Z.sqlite
solana_database_backup=/var/backups/robinhood-radar/solana-20260101T000000Z.sqlite
social_database_backup=/var/backups/robinhood-radar/social-20260101T000000Z.sqlite
evm_wallet_database_backup=/var/backups/robinhood-radar/evm-wallets-20260101T000000Z.sqlite
bark_database_backup=/var/backups/robinhood-radar/bark-20260101T000000Z.sqlite
release_backup=/var/backups/robinhood-radar/release-20260101T000000Z
RESTORE_CADDY=0

BACKUP_ROOT=/var/backups/robinhood-radar
APP_DIR=/opt/robinhood-radar
DATA_DIR=/var/lib/robinhood-radar
SERVICES=(robinhood-radar base-radar bsc-radar solana-radar)
LIVE_DATABASES=(
  "$DATA_DIR/robinhood.sqlite"
  "$DATA_DIR/base.sqlite"
  "$DATA_DIR/bsc.sqlite"
  "$DATA_DIR/solana.sqlite"
  "$DATA_DIR/social.sqlite"
  "$DATA_DIR/evm-wallets.sqlite"
  "$DATA_DIR/bark.sqlite"
)
TARGET_DATABASES=(
  "$robinhood_database_backup"
  "$base_database_backup"
  "$bsc_database_backup"
  "$solana_database_backup"
  "$social_database_backup"
  "$evm_wallet_database_backup"
  "$bark_database_backup"
)

quick_check() {
  local database="$1"
  test "$(sqlite3 "$database" 'PRAGMA quick_check;')" = ok
}

restore_optional_release_file() {
  local source_path="$1"
  local destination_path="$2"
  local mode="$3"
  if [[ -f "$source_path" ]]; then
    install -m "$mode" "$source_path" "$destination_path"
  elif [[ -f "$source_path.missing" ]]; then
    rm -f "$destination_path"
  else
    echo "Missing release backup entry: $source_path" >&2
    return 1
  fi
}

restore_database_entry() {
  local source_path="$1"
  local destination_path="$2"
  rm -f "$destination_path-wal" "$destination_path-shm" || return 1
  if [[ -f "$source_path" ]]; then
    install -o robinhood-radar -g robinhood-radar -m 0640 \
      "$source_path" "$destination_path" || return 1
    quick_check "$destination_path" || return 1
  elif [[ -f "$source_path.missing" ]]; then
    rm -f "$destination_path" || return 1
  else
    echo "Missing database backup entry: $source_path or $source_path.missing" >&2
    return 1
  fi
}

wait_for_endpoint() {
  local label="$1"
  local url="$2"
  local timeout_seconds="$3"
  local deadline=$((SECONDS + timeout_seconds))
  while (( SECONDS < deadline )); do
    if curl --fail --silent --connect-timeout 1 --max-time 3 "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "$label did not become ready within ${timeout_seconds}s: $url" >&2
  curl --fail --silent --show-error --connect-timeout 2 --max-time 5 \
    "$url" >/dev/null
}

# 预检配对关系和全部候选文件；此阶段不会停止或修改服务。
test "$RESTORE_CADDY" = 0 || test "$RESTORE_CADDY" = 1
rollback_stamp="${release_backup##*/release-}"
test "$release_backup" = "$BACKUP_ROOT/release-$rollback_stamp"
test "$robinhood_database_backup" = "$BACKUP_ROOT/robinhood-$rollback_stamp.sqlite"
test "$base_database_backup" = "$BACKUP_ROOT/base-$rollback_stamp.sqlite"
test "$bsc_database_backup" = "$BACKUP_ROOT/bsc-$rollback_stamp.sqlite"
test "$solana_database_backup" = "$BACKUP_ROOT/solana-$rollback_stamp.sqlite"
test "$social_database_backup" = "$BACKUP_ROOT/social-$rollback_stamp.sqlite"
test "$evm_wallet_database_backup" = "$BACKUP_ROOT/evm-wallets-$rollback_stamp.sqlite"
test "$bark_database_backup" = "$BACKUP_ROOT/bark-$rollback_stamp.sqlite"

for backup in "${TARGET_DATABASES[@]}"; do
  if [[ -f "$backup" ]]; then
    quick_check "$backup"
  elif [[ -f "$backup.missing" ]]; then
    test ! -s "$backup.missing"
  else
    echo "Missing database backup entry: $backup or $backup.missing" >&2
    false
  fi
done
for required in \
  robinhood-server.mjs base-server.mjs bsc-server.mjs solana-server.mjs \
  robinhood-radar.service base-radar.service bsc-radar.service solana-radar.service; do
  test -f "$release_backup/$required"
done
test -d "$release_backup/public"
test -f "$release_backup/REVISION" || test -f "$release_backup/REVISION.missing"
for chain in robinhood base bsc solana; do
  test -f "$release_backup/$chain-server.mjs.LEGAL.txt" || \
    test -f "$release_backup/$chain-server.mjs.LEGAL.txt.missing"
done
if [[ $RESTORE_CADDY -eq 1 ]]; then
  test -f "$release_backup/Caddyfile"
  caddy validate --config "$release_backup/Caddyfile" --adapter caddyfile
fi

declare -A WAS_ACTIVE=()
for service in "${SERVICES[@]}"; do
  test "$(systemctl show --property=LoadState --value "$service.service")" = loaded
  active_state="$(systemctl show --property=ActiveState --value "$service.service")"
  case "$active_state" in
    active) WAS_ACTIVE[$service]=1 ;;
    inactive) WAS_ACTIVE[$service]=0 ;;
    *) echo "$service.service has unsafe initial state: $active_state" >&2; false ;;
  esac
done

SAFETY_DIR="$BACKUP_ROOT/manual-before-rollback-$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 0700 "$SAFETY_DIR" "$SAFETY_DIR/units"
SERVICES_STOPPED=0
ROLLBACK_CHANGED=0
COMPLETED=0

recover_manual_rollback() {
  status=$?
  trap - EXIT ERR INT TERM HUP
  if [[ $COMPLETED -eq 1 ]]; then
    return
  fi
  [[ $status -ne 0 ]] || status=1
  set +e
  recovery_failed=0
  safe_to_restore=1
  restore_failed=0
  recovery_files_ready=0
  echo "Manual rollback failed; restoring the pre-rollback safety copy." >&2

  if [[ $ROLLBACK_CHANGED -eq 1 ]]; then
    if ! systemctl stop robinhood-radar.service base-radar.service bsc-radar.service solana-radar.service; then
      recovery_failed=1
      safe_to_restore=0
    fi
    for service in "${SERVICES[@]}"; do
      if ! recovery_state="$(systemctl show --property=ActiveState --value "$service.service")"; then
        safe_to_restore=0
      elif [[ "$recovery_state" != inactive ]]; then
        safe_to_restore=0
      fi
    done

    if [[ $safe_to_restore -eq 1 ]]; then
      for index in "${!LIVE_DATABASES[@]}"; do
        live="${LIVE_DATABASES[$index]}"
        restore_database_entry "$SAFETY_DIR/$(basename "$live")" "$live" || \
          restore_failed=1
      done
      rm -rf "$APP_DIR" || restore_failed=1
      cp -a "$SAFETY_DIR/app" "$APP_DIR" || restore_failed=1
      for service in "${SERVICES[@]}"; do
        install -m 0644 "$SAFETY_DIR/units/$service.service" \
          "/etc/systemd/system/$service.service" || restore_failed=1
      done
      if [[ $RESTORE_CADDY -eq 1 ]]; then
        if ! caddy validate --config "$SAFETY_DIR/Caddyfile" --adapter caddyfile; then
          restore_failed=1
        elif ! install -m 0644 "$SAFETY_DIR/Caddyfile" /etc/caddy/Caddyfile; then
          restore_failed=1
        fi
      fi
      if [[ $restore_failed -eq 0 ]]; then
        recovery_files_ready=1
      else
        recovery_failed=1
      fi
    else
      recovery_failed=1
      echo "Safety files were not restored because not every service is confirmed inactive." >&2
    fi
  else
    recovery_files_ready=1
  fi

  if [[ $SERVICES_STOPPED -eq 1 ]]; then
    if [[ $recovery_files_ready -eq 1 ]]; then
      if ! systemctl daemon-reload; then
        recovery_failed=1
        recovery_files_ready=0
        echo "No services were restarted because systemd could not reload restored units." >&2
      else
        for service in "${SERVICES[@]}"; do
          if [[ "${WAS_ACTIVE[$service]}" -eq 1 ]]; then
            systemctl start "$service.service" || recovery_failed=1
            systemctl is-active --quiet "$service.service" || recovery_failed=1
          else
            systemctl stop "$service.service" || recovery_failed=1
            test "$(systemctl show --property=ActiveState --value "$service.service")" = inactive || \
              recovery_failed=1
          fi
        done
      fi
    else
      echo "No services were restarted; inspect every service state before manual recovery." >&2
    fi
  fi
  if [[ $RESTORE_CADDY -eq 1 && $ROLLBACK_CHANGED -eq 1 && $recovery_files_ready -eq 1 ]]; then
    systemctl reload caddy.service || recovery_failed=1
    systemctl is-active --quiet caddy.service || recovery_failed=1
  fi
  if [[ $recovery_failed -ne 0 ]]; then
    echo "Automatic recovery was incomplete; keep $SAFETY_DIR and repair before retrying." >&2
  fi
  exit "$status"
}
trap recover_manual_rollback EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# 四个进程可能持有七个数据库；必须全部停止并确认都是 inactive。
SERVICES_STOPPED=1
systemctl stop robinhood-radar.service base-radar.service bsc-radar.service solana-radar.service
for service in "${SERVICES[@]}"; do
  test "$(systemctl show --property=ActiveState --value "$service.service")" = inactive
done

# 在改动生产文件前，先制作当前状态的紧急恢复副本。
for live in "${LIVE_DATABASES[@]}"; do
  safety_entry="$SAFETY_DIR/$(basename "$live")"
  if [[ -f "$live" ]]; then
    checkpoint="$(sqlite3 "$live" 'PRAGMA wal_checkpoint(TRUNCATE);')"
    test "${checkpoint%%|*}" = 0
    quick_check "$live"
    install -m 0600 "$live" "$safety_entry"
    quick_check "$safety_entry"
  else
    : > "$safety_entry.missing"
    chmod 0600 "$safety_entry.missing"
  fi
done
cp -a "$APP_DIR" "$SAFETY_DIR/app"
for service in "${SERVICES[@]}"; do
  cp -a "/etc/systemd/system/$service.service" "$SAFETY_DIR/units/"
done
if [[ $RESTORE_CADDY -eq 1 ]]; then
  cp -a /etc/caddy/Caddyfile "$SAFETY_DIR/Caddyfile"
fi

ROLLBACK_CHANGED=1

# 清理每一个实时库的 WAL/SHM，再恢复同一时间戳的七个目标数据库。
for index in "${!LIVE_DATABASES[@]}"; do
  live="${LIVE_DATABASES[$index]}"
  backup="${TARGET_DATABASES[$index]}"
  restore_database_entry "$backup" "$live"
done

# 恢复与七个数据库配对的 bundle、网页、unit 和版本标记。
for chain in robinhood base bsc solana; do
  install -m 0644 "$release_backup/$chain-server.mjs" "$APP_DIR/$chain-server.mjs"
  restore_optional_release_file \
    "$release_backup/$chain-server.mjs.LEGAL.txt" \
    "$APP_DIR/$chain-server.mjs.LEGAL.txt" 0644
  install -m 0644 "$release_backup/$chain-radar.service" \
    "/etc/systemd/system/$chain-radar.service"
done
restore_optional_release_file "$release_backup/REVISION" "$APP_DIR/REVISION" 0644

rm -rf "$APP_DIR/public.rollback-new"
cp -a "$release_backup/public" "$APP_DIR/public.rollback-new"
chown -R root:root "$APP_DIR/public.rollback-new"
find "$APP_DIR/public.rollback-new" -type d -exec chmod 0755 {} +
find "$APP_DIR/public.rollback-new" -type f -exec chmod 0644 {} +
rm -rf "$APP_DIR/public"
mv "$APP_DIR/public.rollback-new" "$APP_DIR/public"

if [[ $RESTORE_CADDY -eq 1 ]]; then
  install -m 0644 "$release_backup/Caddyfile" /etc/caddy/Caddyfile
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
fi

systemctl daemon-reload
systemctl start robinhood-radar.service base-radar.service bsc-radar.service solana-radar.service
for service in "${SERVICES[@]}"; do
  systemctl is-active --quiet "$service.service"
done
if [[ $RESTORE_CADDY -eq 1 ]]; then
  systemctl reload caddy.service
  systemctl is-active --quiet caddy.service
fi

# 服务启动后等待每个本地入口；任一失败会触发上面的安全恢复。
# Robinhood/Base/BSC 最多等待 30 秒，Solana 初始化 Helius 最多等待 120 秒。
wait_for_endpoint robinhood-dashboard \
  'http://127.0.0.1:18118/api/robinhood/dashboard?tab=all' 30
wait_for_endpoint base-dashboard \
  'http://127.0.0.1:18119/api/base/dashboard?tab=all' 30
wait_for_endpoint bsc-dashboard \
  'http://127.0.0.1:18122/api/bsc/dashboard?tab=all' 30
wait_for_endpoint solana-dashboard \
  'http://127.0.0.1:18120/api/solana/dashboard?tab=all' 120
wait_for_endpoint robinhood-monitor \
  'http://127.0.0.1:18118/api/robinhood/monitor' 30
wait_for_endpoint base-monitor \
  'http://127.0.0.1:18119/api/base/monitor' 30
wait_for_endpoint bsc-monitor \
  'http://127.0.0.1:18122/api/bsc/monitor' 30
wait_for_endpoint solana-monitor \
  'http://127.0.0.1:18120/api/solana/monitor' 120
wait_for_endpoint social-api \
  'http://127.0.0.1:18118/api/social?postLimit=1' 30

# 入口就绪后检查全部现存数据库；旧版本不认识的 .missing 共享库可以保持不存在。
for index in "${!LIVE_DATABASES[@]}"; do
  live="${LIVE_DATABASES[$index]}"
  backup="${TARGET_DATABASES[$index]}"
  if [[ -f "$live" ]]; then
    quick_check "$live"
  else
    test -f "$backup.missing"
    test ! -e "$live-wal"
    test ! -e "$live-shm"
  fi
done

COMPLETED=1
trap - EXIT INT TERM HUP
echo "Cross-schema rollback completed; safety copy retained at: $SAFETY_DIR"
```

成功后继续执行“验证部署”中的公网检查，并保留 `SAFETY_DIR`直到观察期结束。若
命令中途失败，trap 会恢复执行回滚前的程序、网页、unit、七个数据库、可选 Caddy
和四个服务原来的启停状态；它提示自动恢复不完整时，不要再次启动发布，应保持
现场并使用打印的 `SAFETY_DIR`手工恢复。

## 15. 常见问题

### 社媒桥接显示离线

- 确认 Chrome 扩展角标是否为 `ON`。
- 确认 DeBot 标签页仍处于登录状态。
- 确认扩展选项里的域名和 `SOCIAL_BRIDGE_TOKEN`与 VPS 完全一致。
- 确认 Chrome 已授予配置域名的站点权限。
- 查看 `journalctl -u robinhood-radar`和网站 Social API 的 bridge 状态。

### 可以看社媒，但无法修改名单

写操作必须来自扩展明确授权的 Radar HTTPS origin。不要使用公网 HTTP 页面，
也不要把 API 地址填成 DeBot 或其他域名。localhost 开发环境可以使用 HTTP。

### Solana 一直显示 degraded

检查 `HELIUS_API_KEY`、公网 HTTPS Webhook URL 和 Authorization 是否完整；确认
域名可从公网访问，并查看 `solana-radar`日志里的脱敏错误。程序不会把公共 RPC
伪装成实时替代方案。

### 实时流水有事件，但市值或风险资料稍后才出现

这是设计行为。链上事件优先落库和推送，DexScreener、DeBot、Holder、创建者和
合约风险资料在后台异步补全，慢上游不会阻塞买入、卖出、转账或发币检测。

### Caddy 后面的 SSE 延迟或批量出现

确认五个 `/monitor/stream`或 `/social/stream`路由没有压缩和代理缓冲，且
`flush_interval -1`仍然存在。修改 Caddy 后先 validate，再 reload。

## 16. 安全和许可证

- 生产 env、Bark Key、DeBot 登录数据、VPS 凭据和实时数据库禁止提交。
- 公开部署前应配置防火墙、SSH Key、系统更新和最小权限。
- 网站默认不提供账号体系；需要私有访问时，应在反向代理层自行增加认证和访问
  控制，并确保 Solana Webhook 仍使用独立 Authorization。
- 项目采用 MIT License。检测结果仅用于研究，不构成交易执行或金融建议。

安全问题和密钥处理要求见根目录 `SECURITY.md`。
