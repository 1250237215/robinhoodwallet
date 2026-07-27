# Contributing

## Development setup

Requirements:

- Node.js 22.13.0 or newer
- npm
- Git

Install the exact dependency versions and run the complete test suite:

```bash
npm ci
npm test
```

Run the local Robinhood development server:

```bash
npm start
```

Build all standalone production services before submitting a deployment
change:

```bash
npm run build:all
```

## Change requirements

- Keep Robinhood, Base, and Solana data, settings, event streams, and alerts
  isolated.
- Preserve the fast monitoring path. Market, holder, creator, and risk
  enrichment must not delay the initial live event.
- Add focused tests for behavior changes and regression fixes.
- Do not weaken address validation, event deduplication, transaction receipt
  checks, swap verification, or browser bridge origin restrictions.
- Keep generated bundles, local databases, logs, screenshots, browser storage,
  and populated environment files out of Git.
- Use placeholders such as `radar.example.com`; do not add a contributor's
  production IP address, domain, device token, or API key to examples.

## Commit scope

Prefer one coherent feature or fix per commit. Related frontend, backend,
schema, and test changes may share one commit when they implement the same
behavior. Use clear subjects such as:

```text
feat: add configurable provider
fix: retry partial token safety data
docs: document fresh VPS deployment
```

## Before opening a pull request

Run:

```bash
npm test
npm run build:all
git status --short
```

The worktree should contain only the intended source and documentation changes.
Never attach a production database or environment file to a pull request.
