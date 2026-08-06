#!/usr/bin/env python3

import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from viewer import (
    MessageStore,
    TelegramCaAlertService,
    TelegramCaAlertStore,
    TRANSLATION_MAX_ATTEMPTS,
    TRANSLATION_RETRY_DELAYS_SECONDS,
    TranslationCacheStore,
    TranslationRequestError,
    TranslationResolver,
    _translation_source_text,
    blocked_chat_reason,
    extract_deepseek_translation,
    extract_contract_addresses,
    filter_allowed_dialogs,
    initialize_translation_resolver,
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
    def test_default_translation_retry_policy_matches_shared_environment(self):
        self.assertEqual(TRANSLATION_MAX_ATTEMPTS, 2)
        self.assertEqual(TRANSLATION_RETRY_DELAYS_SECONDS, (0.0, 0.2))

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

    def test_deepseek_payload_extracts_message_content(self):
        payload = {"choices": [{"message": {"content": "你好世界"}}]}
        self.assertEqual(extract_deepseek_translation(payload), "你好世界")

    def test_deepseek_translation_uses_chat_completion_endpoint(self):
        requests = []

        class Response:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return json.dumps({
                    "choices": [{"message": {"content": "你好"}}],
                }).encode("utf-8")

        def opener(request, timeout):
            requests.append((request, timeout))
            return Response()

        result = translate_text_to_chinese(
            "hello",
            timeout=1.25,
            opener=opener,
            api_key="test-key",
        )
        self.assertEqual(result, "你好")
        request = requests[0][0]
        self.assertEqual(request.method, "POST")
        self.assertTrue(request.full_url.endswith("/chat/completions"))
        self.assertEqual(request.headers["Authorization"], "Bearer test-key")
        body = json.loads(request.data.decode("utf-8"))
        self.assertEqual(body["model"], "deepseek-v4-flash")
        self.assertEqual(body["messages"][-1]["content"], "hello")
        self.assertEqual(body["thinking"], {"type": "disabled"})
        self.assertEqual(requests[0][1], 1.25)

    def test_deepseek_translation_without_key_is_non_fatal(self):
        self.assertEqual(translate_text_to_chinese("hello", api_key=""), "")

    def test_translation_eligibility_skips_urls_addresses_and_symbols(self):
        evm = "0xAaaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa"
        solana = "So11111111111111111111111111111111111111112"
        for value in (
            "https://example.com/token",
            evm,
            solana,
            "@someone $TOKEN #alpha",
        ):
            self.assertEqual(_translation_source_text(value), "")
        self.assertEqual(
            _translation_source_text(f"check this {evm}"),
            f"check this {evm}",
        )
        self.assertEqual(_translation_source_text("Μιλάς αγγλικά;"), "Μιλάς αγγλικά;")

    def test_translation_eligibility_skips_chinese_majority_mixed_text(self):
        self.assertEqual(
            _translation_source_text("主要内容已经是中文，只夹一个 bullish"),
            "",
        )
        self.assertEqual(_translation_source_text("中文 ab"), "")

    def test_translation_eligibility_translates_foreign_majority_mixed_text(self):
        value = "你好 this sentence is mostly English"
        self.assertEqual(_translation_source_text(value), value)
        self.assertEqual(_translation_source_text("你好 hello"), "你好 hello")

    def test_translation_ratio_ignores_links_addresses_and_social_metadata(self):
        evm = "0xAaaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa"
        solana = "So11111111111111111111111111111111111111112"
        chinese_majority = (
            "这条消息主要都是中文 bullish "
            "@ExtremelyLongEnglishHandle $VERYLONGTOKEN #LongEnglishHashtag "
            f"https://example.com/very/long/english/path {evm} {solana}"
        )
        self.assertEqual(_translation_source_text(chinese_majority), "")

        foreign_majority = (
            "中文 this update is mostly written in English "
            "@中文用户名 $中文代币 #中文标签 https://example.com/中文"
        )
        self.assertEqual(_translation_source_text(foreign_majority), foreign_majority)

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
        attempts = 0

        def failed_translate(_text, _timeout):
            nonlocal attempts
            attempts += 1
            raise OSError("translation service unavailable")

        async def exercise():
            resolver = TranslationResolver(
                translate_impl=failed_translate,
                retry_delays=(0, 0, 0),
            )
            return await resolver.translate("hello")

        self.assertEqual(asyncio.run(exercise()), "")
        self.assertEqual(attempts, 3)

    def test_unchanged_model_response_is_a_healthy_noop(self):
        requests = []

        class Response:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return json.dumps({
                    "choices": [{"message": {"content": "Ethereum"}}],
                }).encode("utf-8")

        def opener(request, timeout):
            requests.append((request, timeout))
            return Response()

        def leave_proper_name_alone(text, timeout):
            return translate_text_to_chinese(
                text,
                timeout=timeout,
                opener=opener,
                api_key="test-key",
            )

        async def exercise():
            resolver = TranslationResolver(
                translate_impl=leave_proper_name_alone,
                retry_delays=(0, 0, 0),
            )
            result = await resolver.translate("Ethereum")
            return result, resolver.status

        result, status = asyncio.run(exercise())
        self.assertEqual(result, "")
        self.assertEqual(status["state"], "ready")
        self.assertEqual(status["failures"], 0)
        self.assertEqual(status["skipped"], 1)
        self.assertEqual(status["last_error"], "")
        self.assertEqual(len(requests), 1)

    def test_empty_model_response_remains_an_error(self):
        attempts = 0

        def empty_translate(_text, _timeout):
            nonlocal attempts
            attempts += 1
            return ""

        async def exercise():
            resolver = TranslationResolver(
                translate_impl=empty_translate,
                retry_delays=(0, 0),
            )
            result = await resolver.translate("hello")
            return result, resolver.status

        result, status = asyncio.run(exercise())
        self.assertEqual(result, "")
        self.assertEqual(attempts, 2)
        self.assertEqual(status["state"], "error")
        self.assertEqual(status["last_error"], "empty_response")
        self.assertEqual(status["failures"], 2)
        self.assertEqual(status["retries"], 1)

    def test_failed_translation_is_not_cached(self):
        attempts = 0

        def flaky_translate(_text, _timeout):
            nonlocal attempts
            attempts += 1
            return "" if attempts <= 3 else "你好"

        async def exercise():
            resolver = TranslationResolver(
                translate_impl=flaky_translate,
                retry_delays=(0, 0, 0),
            )
            first = await resolver.translate("hello")
            second = await resolver.translate("hello")
            return first, second

        self.assertEqual(asyncio.run(exercise()), ("", "你好"))
        self.assertEqual(attempts, 4)

    def test_permanent_translation_error_is_not_retried(self):
        attempts = 0

        def unauthorized(_text, _timeout):
            nonlocal attempts
            attempts += 1
            raise TranslationRequestError("http_401", False)

        async def exercise():
            resolver = TranslationResolver(
                translate_impl=unauthorized,
                retry_delays=(0, 0, 0),
            )
            result = await resolver.translate("hello")
            return result, resolver.status

        result, status = asyncio.run(exercise())
        self.assertEqual(result, "")
        self.assertEqual(attempts, 1)
        self.assertEqual(status["state"], "error")
        self.assertEqual(status["last_error"], "http_401")

    def test_rate_limit_retries_then_recovers(self):
        attempts = 0

        def rate_limited(_text, _timeout):
            nonlocal attempts
            attempts += 1
            if attempts < 3:
                raise TranslationRequestError("http_429", True)
            return "你好"

        async def exercise():
            resolver = TranslationResolver(
                translate_impl=rate_limited,
                retry_delays=(0, 0, 0),
            )
            result = await resolver.translate("hello")
            return result, resolver.status

        result, status = asyncio.run(exercise())
        self.assertEqual(result, "你好")
        self.assertEqual(attempts, 3)
        self.assertEqual(status["state"], "ready")
        self.assertEqual(status["retries"], 2)

    def test_successful_translation_persists_across_resolvers(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = TranslationCacheStore(Path(directory) / "translations.sqlite")
            calls = 0

            def translate_once(_text, _timeout):
                nonlocal calls
                calls += 1
                return "你好"

            async def exercise():
                first = TranslationResolver(
                    translate_impl=translate_once,
                    persistent_cache=cache,
                    retry_delays=(0,),
                )
                second = TranslationResolver(
                    translate_impl=translate_once,
                    persistent_cache=cache,
                    retry_delays=(0,),
                )
                return (
                    await first.translate("hello"),
                    await second.translate("hello"),
                    second.status,
                )

            first, second, status = asyncio.run(exercise())
            cache.close()
        self.assertEqual((first, second), ("你好", "你好"))
        self.assertEqual(calls, 1)
        self.assertEqual(status["persistent_cache_hits"], 1)

    def test_translation_cache_init_failure_falls_back_to_memory_safely(self):
        sensitive_error = "/private/runtime/secret/cache.sqlite is not a database"
        calls = []

        def failed_cache_factory():
            raise RuntimeError(sensitive_error)

        def fake_translate(text, _timeout):
            calls.append(text)
            return f"中文：{text}"

        def resolver_factory(*, persistent_cache):
            self.assertIsNone(persistent_cache)
            return TranslationResolver(
                translate_impl=fake_translate,
                persistent_cache=persistent_cache,
                retry_delays=(0,),
                enabled=True,
            )

        with self.assertLogs(level="WARNING") as captured:
            resolver, cache = initialize_translation_resolver(
                cache_factory=failed_cache_factory,
                resolver_factory=resolver_factory,
            )

        self.assertIsNone(cache)
        logs = "\n".join(captured.output)
        self.assertIn("已降级为仅内存缓存", logs)
        self.assertNotIn(sensitive_error, logs)

        async def exercise():
            first = await resolver.translate("hello")
            second = await resolver.translate("hello")
            return first, second

        first, second = asyncio.run(exercise())
        self.assertEqual(first, "中文：hello")
        self.assertEqual(second, first)
        self.assertEqual(calls, ["hello"])

    def test_translation_cache_initializes_normally_when_available(self):
        cache = object()

        class Resolver:
            def __init__(self, *, persistent_cache):
                self.persistent_cache = persistent_cache

        resolver, initialized_cache = initialize_translation_resolver(
            cache_factory=lambda: cache,
            resolver_factory=Resolver,
        )

        self.assertIs(initialized_cache, cache)
        self.assertIs(resolver.persistent_cache, cache)

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

    def test_snapshot_hides_legacy_chinese_majority_translations_without_mutation(self):
        store = MessageStore(10)
        chinese_message = {
            "id": 1,
            "chat_id": -1001,
            "stream_id": "-1001:1",
            "date": "2026-01-01T00:00:00+00:00",
            "text": "主要内容已经是中文，只夹一个 bullish",
            "translated_text": "不应继续展示的历史翻译",
            "reply_preview": {
                "id": 11,
                "text": "回复内容主要也是中文 alpha",
                "translated_text": "回复的历史翻译",
            },
        }
        foreign_message = {
            "id": 2,
            "chat_id": -1001,
            "stream_id": "-1001:2",
            "date": "2026-01-01T00:00:01+00:00",
            "text": "你好 this sentence is mostly English",
            "translated_text": "你好，这句话大部分是英文",
            "reply_preview": {
                "id": 12,
                "text": "回复 this reply is mostly English",
                "translated_text": "这条回复大部分是英文",
            },
        }
        store.replace_for_sources([chinese_message, foreign_message], [])

        messages = {
            message["stream_id"]: message
            for message in store.snapshot(10)["messages"]
        }
        chinese_snapshot = messages["-1001:1"]
        foreign_snapshot = messages["-1001:2"]
        self.assertEqual(chinese_snapshot["translated_text"], "")
        self.assertEqual(chinese_snapshot["reply_preview"]["translated_text"], "")
        self.assertEqual(
            foreign_snapshot["translated_text"],
            foreign_message["translated_text"],
        )
        self.assertEqual(
            foreign_snapshot["reply_preview"]["translated_text"],
            foreign_message["reply_preview"]["translated_text"],
        )

        self.assertEqual(
            store._messages["-1001:1"]["translated_text"],
            chinese_message["translated_text"],
        )
        self.assertEqual(
            store._messages["-1001:1"]["reply_preview"]["translated_text"],
            chinese_message["reply_preview"]["translated_text"],
        )
        chinese_snapshot["text"] = "changed snapshot"
        chinese_snapshot["reply_preview"]["text"] = "changed reply snapshot"
        self.assertEqual(
            store._messages["-1001:1"]["text"],
            chinese_message["text"],
        )
        self.assertEqual(
            store._messages["-1001:1"]["reply_preview"]["text"],
            chinese_message["reply_preview"]["text"],
        )

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
