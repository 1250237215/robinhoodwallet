# DeBot Social Bridge

This Manifest V3 extension uses the already signed-in `debot.ai` browser session to synchronize social posts and the DeBot watchlist with Robinhood Radar.

It does not read or export DeBot cookies, passwords, local storage, or `sub_token`. A page-world bridge calls DeBot's own authenticated social endpoints, normalizes the returned records, and sends only allowlisted social post, watchlist, heartbeat, and command-result fields to the Radar social API. Raw DeBot response objects are never uploaded.

## Local pairing

1. Copy `config.example.js` to `config.local.js`.
2. Set `bridgeToken` to the same random value as `SOCIAL_BRIDGE_TOKEN` on the VPS.
3. Open `chrome://extensions`, enable Developer mode, and load this directory as an unpacked extension.
4. Keep a signed-in DeBot tab open; it may remain in the background while using Radar. The extension badge shows `ON` after the first successful heartbeat.

`config.local.js` is ignored by Git. The extension options page can also store the server address and token in browser-local extension storage.

The Radar website remains passwordless. The device token authorizes only social watchlist and bridge API calls; public read-only social endpoints do not expose it.

The configured social API base is restricted to the original Radar IP URL or its Radar HTTPS hostname, so the device token cannot be sent to DeBot or an unrelated origin.
