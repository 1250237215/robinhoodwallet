# Security policy

## Supported version

Security fixes are applied to the latest commit on `main`. This project does
not currently maintain older release branches.

## Reporting a vulnerability

Do not include API keys, browser session data, wallet annotations, Bark device
keys, server credentials, or database files in a public issue.

Use GitHub's private vulnerability reporting feature when it is available for
this repository. If private reporting is unavailable, open a public issue with
only a minimal, redacted description and ask the maintainer for a private
contact channel before sharing reproduction data.

## Secrets that must remain local

The following values must never be committed:

- `SOCIAL_BRIDGE_TOKEN`
- `HELIUS_API_KEY`
- `SOLANA_HELIUS_AUTH_HEADER`
- `DEEPSEEK_TRANSLATION_API_KEY` and any other DeepSeek API key
- Bark device keys or complete `https://api.day.app/...` endpoints
- DeBot cookies, storage state, authorization payloads, or `sub_token` values
- VPS passwords, SSH private keys, and production environment files
- live SQLite databases unless they have been deliberately reviewed and
  redacted for publication

Use the committed `*.env.example` files as templates. Store populated
production files in `/etc/robinhood-radar/` with mode `0600`. Browser bridge
settings belong in extension-local storage and are intentionally excluded from
Git.

If a secret is accidentally committed, deleting it in a later commit is not
enough. Revoke or rotate the secret immediately, then remove it from Git
history if necessary.

## Browser bridge boundary

The DeBot bridge must only send its bearer token to the explicitly configured
Radar origin. Production Radar endpoints must use HTTPS. Plain HTTP is allowed
only for loopback development addresses. The extension must not read or export
DeBot cookies, passwords, local storage, or WebSocket authorization payloads.

## Public database snapshot

The repository contains an intentionally published, Bark-redacted Robinhood
database snapshot. It still contains public wallet addresses, annotations,
token analyses, monitor events, and on-chain activity. Review
`database/README.md` and `database/manifest.json` before redistributing or
replacing that snapshot.
