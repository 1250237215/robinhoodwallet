#!/usr/bin/env python3

import asyncio
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from viewer import (
    MessageStore,
    TelegramCaAlertService,
    TelegramCaAlertStore,
    TranslationResolver,
    blocked_chat_reason,
    extract_contract_addresses,
    extract_google_translation,
    filter_allowed_dialogs,
    parse_blocked_chat_ids,
    translate_text_to_chinese,
)


class FakeDialog:
    def __init__(self, chat_id, name, username="", restriction_reason=None):
        self.id = chat_id
        self.name = name
        self.is_group = False
        self.is_channel = True
        self.unread_count = 0
        self.entity = SimpleNamespace(
            id=chat_id,
            title=name,
            username=username,
            restriction_reason=restriction_reason,
        )


class ViewerUtilityTests(unittest.TestCase):
    def test_blocked_ids_accept_common_separators_and_ignore_bad_values(self):
        self.assertEqual(
            parse_blocked_chat_ids("-1001, -1002; -1001 not-an-id"),
            {-1001, -1002},
        )

    def test_adult_name_and_telegram_restriction_are_hidden(self):
        adult = FakeDialog(-1001, "NSFW channel")
        restricted = FakeDialog(
            -1002,
            "ordinary title",
            restriction_reason=[SimpleNamespace(reason="pornography")],
        )
        clean = FakeDialog(-1003, "Crypto research")

        self.assertEqual(blocked_chat_reason(adult), "adult-name")
        self.assertEqual(blocked_chat_reason(restricted), "adult-restriction")
        self.assertIsNone(blocked_chat_reason(clean))
        allowed, rejected = filter_allowed_dialogs(
            [adult, restricted, clean],
            blocked_chat_ids=set(),
        )
        self.assertEqual([item.id for item in allowed], [-1003])
        self.assertTrue({-1001, -1002}.issubset(rejected))

    def test_restricted_without_reason_is_hidden(self):
        restricted = FakeDialog(-1004, "unknown")
        restricted.entity.restricted = True
        self.assertEqual(blocked_chat_reason(restricted), "restricted")

    def test_configured_blocked_id_wins_even_when_title_is_generic(self):
        chat = FakeDialog(-1009, "ordinary title")
        self.assertEqual(blocked_chat_reason(chat, {-1009}), "configured")

    def test_google_payload_is_flattened_without_network(self):
        payload = [[["你好", "hello"], ["世界", "world"]], None, "en"]
        self.assertEqual(extract_google_translation(payload), "你好世界")

    def test_google_translation_uses_get_query_endpoint(self):
        requests = []

        class Response:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return b'[[["\xe4\xbd\xa0\xe5\xa5\xbd","hello",null,null,10]],null,"en"]'

        def opener(request, timeout):
            requests.append((request, timeout))
            return Response()

        result = translate_text_to_chinese("hello", timeout=1.25, opener=opener)
        self.assertEqual(result, "你好")
        self.assertEqual(requests[0][0].method, "GET")
        self.assertIn("tl=zh-CN", requests[0][0].full_url)
        self.assertIn("q=hello", requests[0][0].full_url)
        self.assertEqual(requests[0][1], 1.25)

    def test_translation_resolver_is_async_cached_and_failure_safe(self):
        calls = []

        def fake_translate(text, timeout):
            calls.append((text, timeout))
            return f"中文：{text}"

        async def exercise():
            resolver = TranslationResolver(
                translate_impl=fake_translate,
                concurrency=1,
            )
            first, second = await asyncio.gather(
                resolver.translate("hello world"),
                resolver.translate("hello world"),
            )
            cached = await resolver.translate("hello world")
            return first, second, cached

        first, second, cached = asyncio.run(exercise())
        self.assertEqual(first, "中文：hello world")
        self.assertEqual(second, first)
        self.assertEqual(cached, first)
        self.assertEqual(len(calls), 1)

    def test_translation_failure_returns_empty_without_raising(self):
        def failed_translate(_text, _timeout):
            raise OSError("translation service unavailable")

        async def exercise():
            resolver = TranslationResolver(translate_impl=failed_translate)
            return await resolver.translate("hello")

        self.assertEqual(asyncio.run(exercise()), "")

    def test_translation_updates_message_and_reply_without_replacing_original(self):
        store = MessageStore(10)
        message = {
            "id": 1,
            "chat_id": -1001,
            "stream_id": "-1001:1",
            "date": "2026-01-01T00:00:00+00:00",
            "text": "hello",
            "translated_text": "",
            "reply_preview": {
                "id": 2,
                "text": "world",
                "translated_text": "",
            },
        }
        store.replace_for_sources([message], [])
        self.assertTrue(
            store.update_translations(
                "-1001:1",
                translated_text="你好",
                reply_translated_text="世界",
            )
        )
        result = store.snapshot(10)["messages"][0]
        self.assertEqual(result["text"], "hello")
        self.assertEqual(result["translated_text"], "你好")
        self.assertEqual(result["reply_preview"]["text"], "world")
        self.assertEqual(result["reply_preview"]["translated_text"], "世界")

    def test_extracts_evm_and_solana_addresses_without_hash_prefix_matches(self):
        evm = "0xAaaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa"
        solana = "So11111111111111111111111111111111111111112"
        transaction_hash = "0x" + ("b" * 64)
        zero = "0x" + ("0" * 40)
        self.assertEqual(
            extract_contract_addresses(
                f"CA {evm}\nSOL {solana}\nTX {transaction_hash}\nZERO {zero}"
            ),
            [evm.lower(), solana],
        )

    def test_alert_store_persists_rules_and_deduplicates_stream_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "alerts.sqlite"
            store = TelegramCaAlertStore(database, now=lambda: 100)
            store.observe_sender(-1001, 42, "Alice", {"initials": "AL"})
            snapshot = store.update_rules(-1001, True, [42])
            self.assertTrue(snapshot["enabled"])
            self.assertEqual(snapshot["selected_sender_ids"], [42])
            self.assertTrue(
                store.claim_delivery(
                    "-1001:7",
                    -1001,
                    7,
                    42,
                    "Alice",
                    ["0x" + ("a" * 40)],
                )
            )
            self.assertFalse(
                store.claim_delivery(
                    "-1001:7",
                    -1001,
                    7,
                    42,
                    "Alice",
                    ["0x" + ("a" * 40)],
                )
            )
            store.finish_delivery(
                "-1001:7",
                "sent",
                {"attempted": 1, "sent": 1, "failed": 0},
            )
            store.close()

            reopened = TelegramCaAlertStore(database, now=lambda: 101)
            persisted = reopened.snapshot(-1001)
            self.assertTrue(persisted["enabled"])
            self.assertEqual(persisted["selected_sender_ids"], [42])
            self.assertEqual(persisted["latest_delivery"]["status"], "sent")
            reopened.close()

    def test_live_alert_service_pushes_only_selected_sender_once(self):
        class FakeAvatarResolver:
            async def info_for_message(self, message, fallback_entity):
                return {
                    "name": "Alice",
                    "initials": "AL",
                    "color": "#123456",
                    "url": None,
                }

        async def exercise(database):
            dialog = FakeDialog(-1001, "LazyCat FNF", username="lazycat")
            store = TelegramCaAlertStore(database)
            store.observe_sender(-1001, 42, "Alice", {"initials": "AL"})
            store.update_rules(-1001, True, [42])
            service = TelegramCaAlertService(
                dialog,
                FakeAvatarResolver(),
                store=store,
                internal_url="http://127.0.0.1/internal/telegram-bark",
                internal_token="x" * 32,
            )
            sent = []

            def fake_post(payload):
                sent.append(payload)
                return {"attempted": 1, "sent": 1, "failed": 0}

            service._post_payload = fake_post
            message = SimpleNamespace(
                chat_id=-1001,
                sender_id=42,
                id=7,
                raw_text="new CA 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            )
            first = await service.handle_new_message(message)
            duplicate = await service.handle_new_message(message)
            if service.delivery_tasks:
                await asyncio.gather(*tuple(service.delivery_tasks))
            snapshot = service.snapshot()
            await service.close()
            return first, duplicate, sent, snapshot

        with tempfile.TemporaryDirectory() as directory:
            first, duplicate, sent, snapshot = asyncio.run(
                exercise(Path(directory) / "alerts.sqlite")
            )
        self.assertTrue(first)
        self.assertFalse(duplicate)
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0]["senderId"], 42)
        self.assertEqual(snapshot["latest_delivery"]["status"], "sent")


if __name__ == "__main__":
    unittest.main()
