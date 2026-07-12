# Public database snapshot

`robinhood-public.sqlite.gz` is a transactionally consistent snapshot of the
production Robinhood Wallet Radar SQLite database created at
`2026-07-12T11:56:00Z`.

The repository is public. This snapshot intentionally includes wallet
addresses, annotations, token analyses, on-chain actions, monitor events,
alerted token addresses, jobs, and non-Bark monitor settings.

## Removed Bark data

The snapshot does not contain Bark credentials or Bark preferences:

- Every row in `monitor_bark_targets` was deleted.
- Metadata keys matching `robinhood:monitor:bark-*` were deleted.
- The `monitor_bark_targets` sequence entry was deleted.
- `PRAGMA secure_delete=ON` and `VACUUM` were run after deletion.
- The exact production Bark endpoint, `api.day.app`, and Bark metadata keys were
  verified absent from the resulting SQLite file bytes.

The empty `monitor_bark_targets` table remains so the database can be restored
without a schema migration. Bark targets must be configured again after a
restore.

## Verify and extract

Compare the file hashes and table counts with `manifest.json`, then extract the
database:

```bash
gzip -t database/robinhood-public.sqlite.gz
gzip -dc database/robinhood-public.sqlite.gz > robinhood.sqlite
```

Do not replace a running production database directly. Stop the service, create
a backup of the current database, install the extracted file with the service
account as owner, run `PRAGMA quick_check`, and then restart the service.
