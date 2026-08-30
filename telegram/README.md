# Telegram 个人账号自动转发

这个工具使用你的个人 Telegram 账号，监听你已经加入的群组或频道，并把新消息自动转发到一个或多个目标群组/频道。

## 首次使用

1. 打开 <https://my.telegram.org/apps>，创建应用并取得 `API ID` 和 `API Hash`。
2. 双击 `run.command`。
3. 在终端窗口输入 `API ID`、`API Hash`、手机号和 Telegram 验证码。
4. 脚本会列出当前账号能看到的群组和频道。按编号选择源聊天和目标聊天。
5. 保持终端窗口运行。程序只转发启动后收到的新消息。

后续使用只需双击 `run.command`，不需要再次输入验证码。需要修改源、目标或关键词时，双击 `setup.command`。

如果暂时只想在网页中查看聊天记录，双击 `viewer.command`。首次设置使用 `viewer-setup.command`，可以一次选择多个群组或频道；网页会按消息时间合并成一个只读信息流，启动后仍会实时接收所选聊天的新消息。网页默认地址是 `http://127.0.0.1:8765`，启动时会自动打开浏览器。

查看器提供以下本机只读/配置接口：

- `GET /api/chats`：列出当前账号可访问的群组和频道，并标记当前选择。
- `GET /api/selection`：读取当前选择及来源元数据。
- `PUT` 或 `POST /api/selection`：提交 JSON `{"chat_ids":[-100123,-100456]}` 保存并应用选择；也接受字段名 `selected_chat_ids`。
- `GET /api/messages?limit=1000`：返回当前所选聊天的合并消息流；需要单独查看某个聊天时可附加 `chat_id`。

固定的 LazyCat 群会每隔几秒检查 Telegram 置顶消息。检测到新的置顶消息后，服务会通过
1874catch 的 Bark 目标发送“Telegram 置顶”提醒；置顶内容包含 CA 时会同时附上对应链的
DeBot 购买链接。置顶提醒可在网站 Bark 设置中单独关闭，不会影响普通 Telegram CA 提醒。

每条消息保留原文 `text`，并在后台翻译完成后填充 `translated_text`；回复预览也有
同名字段。翻译是异步和可失败的，原文不会等待外部翻译服务。历史回填和实时消息
使用独立限流通道，历史消息不会阻塞新消息的翻译。生产部署使用服务器私有的
`DEEPSEEK_TRANSLATION_API_KEY` 和 `deepseek-chat`；失败结果不会缓存，短暂超时后
仍会重试，鉴权或请求格式错误不会重复请求。成功译文按模型和原文哈希保存在私有
`telegram_translation_cache.sqlite`，服务重启不会重复翻译同一批历史。密钥只应放在
权限为 `0600` 的 `/etc/robinhood-radar/translation.env`。

查看器会在后端目录、选择、历史和实时事件入口过滤明显成人或 Telegram 受限聊天。
标题/用户名规则、Telegram restriction metadata 以及 `TG_VIEWER_BLOCKED_CHAT_IDS`
都会参与判断；自动识别到的 ID 会持久化到 `viewer_config.json`，避免频道改名后再次
出现。过滤发生在服务端，旧版前端也无法绕过。

多聊天消息会保留原始数字 `id`，并额外提供 `chat_id`、`stream_id` 和 `chat` 字段。前端应使用 `stream_id` 区分不同聊天中可能相同的消息编号。旧的单源 `viewer_config.json` 只含 `source_id` 时会自动迁移为一个聊天的 `selected_chat_ids` 配置。

## 网络代理

如果 VPS 或本地网络无法直连 Telegram，可以在运行目录单独放置一个 `proxy.json`。
发布包不包含该文件，代理地址和认证信息也不会进入 Git。

代理设置保存在 `proxy.json`。如果代理软件以后更改了端口，需要同步修改该文件中的 `port`；不需要代理时，可以暂时把 `proxy.json` 移出当前目录。

## 安全说明

- `config.json` 保存 API 凭据，`tg_forwarder.session` 保存 Telegram 登录会话。这两个文件只应保留在本机。
- `viewer_config.json` 保存查看器选择和同一组 API 凭据，文件权限会设为仅当前用户可读写。
- 网页查看器只读取聊天、头像和媒体，不包含发送、转发、编辑或删除 Telegram 消息的接口。
- 不要把验证码、两步验证密码、API Hash 或 `.session` 文件交给任何人。
- 工具不会绕过 Telegram 的内容保护。源聊天禁止转发时，Telegram 会拒绝操作。
- 请获得必要授权并遵守群组、频道和 Telegram 的规则。大量自动转发可能触发频率限制。

## 文件说明

- `run.command`：启动自动转发；没有配置时自动进入首次设置。
- `setup.command`：重新选择源聊天、目标聊天和关键词。
- `viewer.command`：启动本地聊天记录网页。
- `viewer-setup.command`：重新选择网页消息源、历史条数和端口。
- `forwarder.log`：运行日志，不记录消息正文。
- `config.json`：首次设置后生成的本地配置。
- `viewer_config.json`：网页查看器的源聊天选择、历史条数、端口和已过滤聊天 ID；
  它和 API 凭据一样只应留在运行目录。
- `proxy.json`：本机 SOCKS5/HTTP 代理配置。
- `tg_forwarder.session`：首次登录后生成的本地会话文件。
