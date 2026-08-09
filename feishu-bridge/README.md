# 飞书人物雷达

VPS 实时读取服务，通过 VPS 上已授权的 `lark-cli` 监控 6 个飞书人物：

- Sen（`crazySen个人发言`）
- Lasercat（`Lasercat全员群` 中无昵称前缀的个人机器人流）
- MrDQ
- 大齐
- luck(发财版
- LU

## VPS 配置

```bash
install -d -o robinhood-radar -g robinhood-radar -m 0750 \
  /var/lib/robinhood-radar/feishu

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

飞书官方页面确认完成后，生产服务由 `feishu-monitor.service` 启动，只监听
`127.0.0.1:18124`，Caddy 将 `/robinhood-radar/feishu/*` 代理到该端口。

服务默认每 2 秒并行读取三个飞书会话，通过 SSE 推送到主网站。飞书授权文件
只保存在 `/var/lib/robinhood-radar/feishu/.lark-cli/`，不会进入 Git、发布包或网页。
本地电脑不运行上传器，也不参与读取。

可选环境变量：

```bash
HOST=127.0.0.1 PORT=18124 POLL_MS=2000 npm start
```

## 测试

```bash
npm test
```
