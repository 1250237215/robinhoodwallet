# DeBot Social Bridge

This Manifest V3 extension uses the already signed-in `debot.ai` browser session to synchronize social posts and the DeBot watchlist with Robinhood Radar.

It does not read or export DeBot cookies, passwords, local storage, or `sub_token`. A page-world bridge calls DeBot's own authenticated social endpoints, normalizes the returned records, and sends only allowlisted social post, watchlist, heartbeat, and command-result fields to the Radar social API. Raw DeBot response objects are never uploaded.

## Local pairing

1. Open `chrome://extensions`, enable Developer mode, and load this directory as an unpacked extension.
2. Open the extension details and choose **Extension options**. Enter the Radar social API address and the same random device token as `SOCIAL_BRIDGE_TOKEN` on the VPS.
3. Keep a signed-in DeBot tab open; it may remain in the background while using Radar. The extension badge shows `ON` after the first successful heartbeat.

Runtime settings are read only from browser-local extension storage. An existing `config.local.js` is migrated once when the options page opens and storage has not been configured yet. That legacy file remains on disk, stays ignored by Git, and is never loaded by the service worker or exposed to website scripts.

The extension uses a 30-second recovery alarm to wake throttled background tabs, retry queued posts, and verify the DeBot page. It reuses an existing DeBot tab, creates one pinned background tab when none exists, and reloads an unresponsive bridge with bounded backoff. Sanitized posts are kept in a private bounded outbox until the Radar API explicitly acknowledges them. If the outbox reaches its 1,000-record or 4 MiB limit, already queued posts are preserved and the page retries new posts after older records drain. A temporary VPS or network outage therefore does not silently evict an earlier accepted post.

Live posts are captured from DeBot's WebSocket immediately, with a five-second REST poll and the recovery alarm as fallbacks. The outbox protects every post the browser has already observed. DeBot's current timeline response is limited to the latest 50 records per feed, so an extended period with Chrome fully closed, the computer asleep, or the DeBot session unavailable can exceed the upstream recovery window; those older, never-observed records cannot be reconstructed by the extension.

The Radar website remains passwordless. The device token authorizes only social watchlist and bridge API calls; public read-only social endpoints do not expose it.

The configured social API base is restricted to the Radar HTTPS hostname, so the bearer device token is never sent over plaintext HTTP or to DeBot or an unrelated origin. The original passwordless HTTP Radar page remains supported as a user interface and does not receive the device token.
