# Common Wall backup job

This Railway cron service takes one repeatable-read snapshot of `public.wall_posts` and `public.wall_post_votes`, compresses it, and writes it to a private Railway Object Storage bucket. Every run downloads the new object, verifies its SHA-256 checksum and document shape, and inserts the downloaded posts and votes into temporary PostgreSQL tables inside a rolled-back transaction. The job updates `common-wall/daily/latest.json` only after those checks pass.

New archives use format version 3 and include vote hashes, values, and timestamps. Recovery remains compatible with version 2 archives, which are treated as snapshots with no votes.

The daily schedule is `06:15 UTC`. Backups remain for 35 days by default, and cleanup always preserves at least the seven newest archives. A ten-minute watchdog prevents a stalled job from suppressing later Railway cron runs.

## Runtime variables

- `DATABASE_URL`: `${{Postgres.DATABASE_URL}}`
- `BACKUP_BUCKET_NAME`: the bucket's `BUCKET` reference
- `BACKUP_BUCKET_ENDPOINT`: the bucket's `ENDPOINT` reference
- `BACKUP_BUCKET_ACCESS_KEY_ID`: the bucket's `ACCESS_KEY_ID` reference
- `BACKUP_BUCKET_SECRET_ACCESS_KEY`: the bucket's `SECRET_ACCESS_KEY` reference
- `BACKUP_BUCKET_REGION`: the bucket's `REGION` reference
- `BACKUP_BUCKET_URL_STYLE`: `virtual`
- `BACKUP_PREFIX`: `common-wall/daily`
- `BACKUP_RETENTION_DAYS`: `35`

Bucket credentials belong only to this cron service. The application and browser do not receive them.

`railway-run.json` provides the same image without a cron schedule for a one-time Railway recovery check. It is intended for a temporary service with the same private variable references; remove that service after its receipt and bucket objects are verified.

## Recovery

`npm run verify` downloads and restore-checks the latest backup without changing persistent rows. To select an older object, set `BACKUP_KEY` to its full key under `BACKUP_PREFIX`.

Applying a backup requires a separate `RESTORE_DATABASE_URL` whose migrated `wall_posts` and `wall_post_votes` tables are empty. The restore locks both tables, inserts posts before their votes, and refuses to merge an old snapshot into a populated wall:

```bash
RESTORE_DATABASE_URL=postgres://replacement-database \
  RESTORE_APPLY=true RESTORE_CONFIRM=restore-common-wall npm run verify
```
