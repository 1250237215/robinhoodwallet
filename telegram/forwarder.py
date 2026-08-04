#!/usr/bin/env python3

import argparse
import asyncio
import getpass
import json
import logging
import os
import socket
import sys
from pathlib import Path

from telethon import TelegramClient, events
from telethon.errors import FloodWaitError


BASE_DIR = Path(__file__).resolve().parent
RUNTIME_DIR = Path(os.environ.get("TG_RUNTIME_DIR", str(BASE_DIR))).expanduser()
CONFIG_PATH = RUNTIME_DIR / "config.json"
PROXY_PATH = RUNTIME_DIR / "proxy.json"
SESSION_PATH = RUNTIME_DIR / "tg_forwarder"
SESSION_FILE = RUNTIME_DIR / "tg_forwarder.session"
LOG_PATH = RUNTIME_DIR / "forwarder.log"


def configure_logging():
    formatter = logging.Formatter(
        "%(asctime)s %(levelname)s %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    console_handler = logging.StreamHandler()
    console_handler.setFormatter(formatter)

    file_handler = logging.FileHandler(LOG_PATH, encoding="utf-8")
    file_handler.setFormatter(formatter)

    logging.basicConfig(
        level=logging.INFO,
        handlers=[console_handler, file_handler],
    )
    logging.getLogger("telethon").setLevel(logging.WARNING)


def load_config():
    if not CONFIG_PATH.exists():
        return None

    try:
        config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"无法读取配置文件：{error}") from error

    required_keys = {
        "api_id",
        "api_hash",
        "source_id",
        "destination_ids",
        "keywords",
    }
    missing_keys = required_keys.difference(config)
    if missing_keys:
        missing = ", ".join(sorted(missing_keys))
        raise RuntimeError(f"配置文件缺少字段：{missing}")

    if not isinstance(config["api_id"], int):
        raise RuntimeError("配置文件中的 api_id 必须是数字")
    if not isinstance(config["api_hash"], str) or not config["api_hash"]:
        raise RuntimeError("配置文件中的 api_hash 无效")
    if not isinstance(config["source_id"], int):
        raise RuntimeError("配置文件中的 source_id 必须是数字")
    if not isinstance(config["destination_ids"], list):
        raise RuntimeError("配置文件中的 destination_ids 必须是列表")
    if not all(isinstance(chat_id, int) for chat_id in config["destination_ids"]):
        raise RuntimeError("目标聊天 ID 必须全部是数字")
    if not isinstance(config["keywords"], list):
        raise RuntimeError("配置文件中的 keywords 必须是列表")

    return config


def load_proxy_config():
    if not PROXY_PATH.exists():
        return None

    try:
        proxy = json.loads(PROXY_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"无法读取代理配置：{error}") from error

    required_keys = {"proxy_type", "addr", "port"}
    missing_keys = required_keys.difference(proxy)
    if missing_keys:
        missing = ", ".join(sorted(missing_keys))
        raise RuntimeError(f"代理配置缺少字段：{missing}")

    proxy_type = str(proxy["proxy_type"]).lower()
    if proxy_type not in {"socks5", "socks4", "http"}:
        raise RuntimeError("proxy_type 必须是 socks5、socks4 或 http")

    addr = proxy["addr"]
    port = proxy["port"]
    if not isinstance(addr, str) or not addr:
        raise RuntimeError("代理地址无效")
    if not isinstance(port, int) or not 1 <= port <= 65535:
        raise RuntimeError("代理端口无效")

    result = {
        "proxy_type": proxy_type,
        "addr": addr,
        "port": port,
        "rdns": bool(proxy.get("rdns", True)),
    }
    if proxy.get("username"):
        result["username"] = str(proxy["username"])
    if proxy.get("password"):
        result["password"] = str(proxy["password"])
    return result


def check_proxy_port(proxy):
    if proxy is None:
        return

    try:
        with socket.create_connection(
            (proxy["addr"], proxy["port"]),
            timeout=3,
        ):
            pass
    except OSError as error:
        raise RuntimeError(
            f"无法连接代理 {proxy['addr']}:{proxy['port']}。"
            "请确认代理软件正在运行。"
        ) from error


def save_config(config):
    temporary_path = CONFIG_PATH.with_suffix(".json.tmp")
    temporary_path.write_text(
        json.dumps(config, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    os.chmod(temporary_path, 0o600)
    temporary_path.replace(CONFIG_PATH)
    os.chmod(CONFIG_PATH, 0o600)


def protect_session_file():
    if SESSION_FILE.exists():
        os.chmod(SESSION_FILE, 0o600)


def prompt_api_credentials(existing_config=None):
    existing_config = existing_config or {}
    existing_api_id = existing_config.get("api_id")
    existing_api_hash = existing_config.get("api_hash")

    print("\n先填写 Telegram 官方 API 凭据。")
    print("获取地址：https://my.telegram.org/apps")
    print("这些信息只保存在本机的 config.json。\n")

    while True:
        default_hint = f" [{existing_api_id}]" if existing_api_id else ""
        raw_api_id = input(f"API ID{default_hint}：").strip()
        if not raw_api_id and existing_api_id:
            api_id = existing_api_id
            break
        try:
            api_id = int(raw_api_id)
            if api_id <= 0:
                raise ValueError
            break
        except ValueError:
            print("API ID 必须是正整数，请重新输入。")

    while True:
        hash_hint = "（直接回车保留现有值）" if existing_api_hash else ""
        api_hash = getpass.getpass(f"API Hash{hash_hint}：").strip()
        if not api_hash and existing_api_hash:
            api_hash = existing_api_hash
        if api_hash:
            break
        print("API Hash 不能为空，请重新输入。")

    return api_id, api_hash


async def start_client(client):
    await client.start(
        phone=lambda: input("请输入手机号（含国家区号，例如 +86...）：").strip(),
        code_callback=lambda: input("请输入 Telegram 验证码：").strip(),
        password=lambda: getpass.getpass("请输入两步验证密码："),
    )
    protect_session_file()


async def get_group_and_channel_dialogs(client):
    dialogs = []
    async for dialog in client.iter_dialogs():
        if dialog.is_group or dialog.is_channel:
            dialogs.append(dialog)

    dialogs.sort(key=lambda dialog: (dialog.name or "").casefold())
    return dialogs


def dialog_kind(dialog):
    if dialog.is_group:
        return "群组"
    return "频道"


def print_dialogs(dialogs):
    print("\n你当前账号能看到的群组和频道：\n")
    for index, dialog in enumerate(dialogs, start=1):
        name = dialog.name or "未命名聊天"
        print(
            f"{index:>3}. [{dialog_kind(dialog)}] {name} "
            f"(ID: {dialog.id})"
        )


def choose_one_dialog(dialogs, prompt):
    while True:
        raw_value = input(prompt).strip()
        try:
            index = int(raw_value)
        except ValueError:
            print("请输入列表前面的数字编号。")
            continue

        if 1 <= index <= len(dialogs):
            return dialogs[index - 1]

        print(f"请输入 1 到 {len(dialogs)} 之间的编号。")


def choose_destination_dialogs(dialogs, source_dialog):
    while True:
        raw_value = input(
            "请输入目标聊天编号；多个目标用英文逗号分隔："
        ).strip()
        if not raw_value:
            print("至少需要选择一个目标聊天。")
            continue

        try:
            indexes = [int(item.strip()) for item in raw_value.split(",")]
        except ValueError:
            print("格式不正确，例如：2 或 2,5,8")
            continue

        if any(index < 1 or index > len(dialogs) for index in indexes):
            print(f"所有编号都必须在 1 到 {len(dialogs)} 之间。")
            continue

        selected = []
        selected_ids = set()
        for index in indexes:
            dialog = dialogs[index - 1]
            if dialog.id == source_dialog.id:
                print("源聊天不能同时作为目标聊天。")
                selected = []
                break
            if dialog.id not in selected_ids:
                selected.append(dialog)
                selected_ids.add(dialog.id)

        if selected:
            return selected


def prompt_keywords(existing_keywords=None):
    existing_keywords = existing_keywords or []
    if existing_keywords:
        print(f"当前关键词：{', '.join(existing_keywords)}")

    raw_value = input(
        "关键词过滤（多个用英文逗号分隔；直接回车表示全部转发）："
    ).strip()
    if not raw_value:
        return []

    return [
        keyword.strip()
        for keyword in raw_value.split(",")
        if keyword.strip()
    ]


async def run_setup(client, api_id, api_hash, existing_config=None):
    dialogs = await get_group_and_channel_dialogs(client)
    if len(dialogs) < 2:
        raise RuntimeError("账号里至少需要两个可访问的群组或频道。")

    print_dialogs(dialogs)
    source_dialog = choose_one_dialog(dialogs, "请输入源聊天编号：")
    destination_dialogs = choose_destination_dialogs(dialogs, source_dialog)
    keywords = prompt_keywords(
        (existing_config or {}).get("keywords", [])
    )

    config = {
        "api_id": api_id,
        "api_hash": api_hash,
        "source_id": source_dialog.id,
        "destination_ids": [dialog.id for dialog in destination_dialogs],
        "keywords": keywords,
    }
    save_config(config)

    print("\n设置已保存：")
    print(f"源：[{dialog_kind(source_dialog)}] {source_dialog.name}")
    for dialog in destination_dialogs:
        print(f"目标：[{dialog_kind(dialog)}] {dialog.name}")
    if keywords:
        print(f"关键词：{', '.join(keywords)}")
    else:
        print("关键词：无，转发全部新消息")

    return config, dialogs


def keywords_match(messages, keywords):
    if not keywords:
        return True

    combined_text = "\n".join(
        (getattr(message, "raw_text", None) or "")
        for message in messages
    ).casefold()
    return any(keyword.casefold() in combined_text for keyword in keywords)


async def forward_with_retry(client, destination, messages):
    while True:
        try:
            await client.forward_messages(destination, messages)
            return True
        except FloodWaitError as error:
            logging.warning("触发频率限制，等待 %s 秒", error.seconds)
            await asyncio.sleep(error.seconds)
        except Exception as error:
            logging.error(
                "转发到目标聊天 %s 失败：%s",
                getattr(destination, "id", "unknown"),
                error,
            )
            return False


async def run_forwarder(client, config, dialogs=None):
    if dialogs is None:
        dialogs = await get_group_and_channel_dialogs(client)

    dialogs_by_id = {dialog.id: dialog for dialog in dialogs}
    source_dialog = dialogs_by_id.get(config["source_id"])
    if source_dialog is None:
        raise RuntimeError(
            "找不到已设置的源聊天。请双击 setup.command 重新设置。"
        )

    destination_dialogs = []
    for destination_id in config["destination_ids"]:
        dialog = dialogs_by_id.get(destination_id)
        if dialog is None:
            raise RuntimeError(
                f"找不到目标聊天 {destination_id}。"
                "请双击 setup.command 重新设置。"
            )
        destination_dialogs.append(dialog)

    keywords = config["keywords"]

    async def forward_messages(messages):
        if not keywords_match(messages, keywords):
            return

        message_ids = [message.id for message in messages]
        success_count = 0
        for destination_dialog in destination_dialogs:
            succeeded = await forward_with_retry(
                client,
                destination_dialog.entity,
                messages if len(messages) > 1 else messages[0],
            )
            success_count += int(succeeded)

        logging.info(
            "消息 %s 已转发到 %s/%s 个目标",
            ",".join(str(message_id) for message_id in message_ids),
            success_count,
            len(destination_dialogs),
        )

    @client.on(events.NewMessage(chats=source_dialog.entity))
    async def handle_new_message(event):
        if getattr(event.message, "grouped_id", None) is not None:
            return
        if getattr(event.message, "action", None) is not None:
            return
        await forward_messages([event.message])

    @client.on(events.Album(chats=source_dialog.entity))
    async def handle_album(event):
        await forward_messages(list(event.messages))

    print("\n自动转发正在运行。")
    print(f"源：[{dialog_kind(source_dialog)}] {source_dialog.name}")
    for dialog in destination_dialogs:
        print(f"目标：[{dialog_kind(dialog)}] {dialog.name}")
    if keywords:
        print(f"关键词：{', '.join(keywords)}")
    else:
        print("关键词：无，转发全部新消息")
    print("仅转发程序运行后收到的新消息，按 Ctrl+C 停止。\n")

    await client.run_until_disconnected()


async def async_main(force_setup):
    existing_config = load_config()
    proxy = load_proxy_config()
    check_proxy_port(proxy)

    if force_setup or existing_config is None:
        api_id, api_hash = prompt_api_credentials(existing_config)
    else:
        api_id = existing_config["api_id"]
        api_hash = existing_config["api_hash"]

    if proxy:
        print(
            f"使用 {proxy['proxy_type'].upper()} 代理："
            f"{proxy['addr']}:{proxy['port']}"
        )

    client = TelegramClient(
        str(SESSION_PATH),
        api_id,
        api_hash,
        proxy=proxy,
    )
    await start_client(client)

    try:
        if force_setup or existing_config is None:
            config, dialogs = await run_setup(
                client,
                api_id,
                api_hash,
                existing_config,
            )
        else:
            config = existing_config
            dialogs = None

        await run_forwarder(client, config, dialogs)
    finally:
        protect_session_file()
        await client.disconnect()


def parse_args():
    parser = argparse.ArgumentParser(
        description="使用个人 Telegram 账号自动转发群组或频道的新消息。"
    )
    parser.add_argument(
        "--setup",
        action="store_true",
        help="重新选择源聊天、目标聊天和关键词。",
    )
    return parser.parse_args()


def main():
    configure_logging()
    args = parse_args()

    try:
        asyncio.run(async_main(args.setup))
    except KeyboardInterrupt:
        print("\n自动转发已停止。")
    except Exception as error:
        logging.error("程序无法启动：%s", error)
        print("\n可双击 setup.command 重新设置。")
        sys.exit(1)


if __name__ == "__main__":
    main()
