# Common Wall backup job

This Railway cron service takes a repeatable-read snapshot of `public.wall_posts`, compresses it, and writes it to a private Railway Object Storage bucket. Every run downloads the new object, verifies its SHA-256 checksum and document shape, and inserts the downloaded rows into a temporary PostgreSQL table inside a rolled-back transaction. The job updates `common-wall/daily/latest.json` only after those checks pass.

The daily schedule is `06:15 UTC`. Backups remain for 35 days by default. Cleanup never removes the current backup or `latest.json`.

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

## Recovery

`npm run verify` downloads and restore-checks the latest backup without changing persistent rows. To select an older object, set `BACKUP_KEY` to its full key under `BACKUP_PREFIX`.

Applying a backup inserts missing posts and refuses conflicting rows. It never deletes current posts:

```bash
RESTORE_APPLY=true RESTORE_CONFIRM=restore-common-wall npm run verify
```
