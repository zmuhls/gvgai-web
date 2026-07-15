# Cadavre Exquis user backend on Railway

## Construction

Cadavre follows Jeopardy LM's Railway runtime: the browser and account API share one origin, a Node service owns authentication, and SQLite lives on a persistent Railway volume. The account system uses opaque cookie sessions rather than browser-stored bearer tokens.

The service remains usable without an account. Registration adds a private poem library and lets a player reopen, edit, export, print, update, and delete their own work.

## Railway topology

- Existing `inference-arcade` Node service, built from the repository Dockerfile.
- Persistent Railway volume mounted at `/data`.
- `RAILWAY_VOLUME_MOUNT_PATH=/data` makes the database path `/data/cadavre.db` automatically. `CADAVRE_DB_PATH` can override it.
- One service instance while SQLite is the write authority. Do not scale horizontally until the store moves to Railway Postgres.
- Nightly volume backup or database snapshot before schema changes.

Required production variables:

- `PUBLIC_BASE_URL=https://inference-arcade.com`
- `RESEND_API_KEY` for transactional password-reset email
- `CADAVRE_FROM_EMAIL`, using a verified sender such as `Cadavre Exquis <poems@example.org>`

The forgot-password route returns `503` while either mail variable is absent and `502` when the provider rejects a delivery request. It returns `202` only when the request is accepted or the submitted address has no matching account.

## Data model

- `cadavre_users`: case-insensitive username and email, scrypt password hash, creation and login timestamps.
- `cadavre_sessions`: SHA-256 hashes of random 256-bit session tokens, user ownership, 30-day expiry.
- `cadavre_poems`: title, JSON line array, close reading, owner, timestamps, and revision counter.
- `cadavre_password_resets`: one-time hashed reset tokens with one-hour expiry and used timestamp.
- `cadavre_auth_rate_limits`: source-address windows for registration, login, and password reset.

Deleting a user is a later account-settings surface. Foreign keys already cascade sessions, poems, and reset tokens.

## API contract

All routes are under `/api/cadavre`.

- `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`
- `POST /auth/forgot-password`, `POST /auth/reset-password`
- `GET /poems`, `POST /poems`, `PATCH /poems/:id`, `DELETE /poems/:id`
- `POST /pdf` creates an account-independent, print-ready PDF

Poem updates require `expected_revision`. A stale writer receives `409` instead of overwriting a newer edit.

## Security boundary

- Passwords use scrypt with per-user random salts and are never logged.
- Only a session-token hash is stored; the raw token stays in a `Secure`, `HttpOnly`, `SameSite=Lax` cookie.
- Mutating requests reject a foreign `Origin`.
- Login responses are generic and execute a dummy password hash for unknown accounts.
- Registration is limited to five attempts per address per hour; login to twenty per ten minutes; reset flows have separate limits.
- Forgot-password responses do not disclose whether an email exists. Resetting a password revokes every active session.
- Poem queries always include the authenticated user id.

## Rollout and growth

1. Deploy the API and UI with the volume attached; verify `/api/cadavre/auth/me` returns `401` when signed out.
2. Configure the verified reset-email sender, then exercise registration, logout/login, reset delivery, one-time reset use, and session revocation.
3. Create, edit, reopen, and delete poems from two accounts to verify ownership isolation and stale-write handling.
4. Export a long Unicode poem and inspect Letter MediaBox, CropBox, TrimBox, BleedBox, crop marks, wrapping, and multi-page footers.
5. Add automated SQLite backup and a restore drill.
6. Move the same tables and route contract to Railway Postgres before running more than one application replica. Replace the in-process rate-limit table with Redis only if multi-replica traffic makes it necessary.
