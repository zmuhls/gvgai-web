# CLEF inference relay

This Worker belongs to the separate standard Cloudflare account pinned in
`cloudflare.config.ts`. The CUNY AI Lab enterprise account is not a deployment
target. Configuration fails if the operator's account environment differs.

Railway sends its existing typed game decision body to `POST /v1/decision` with
a dedicated bearer secret. The Worker accepts only CLEF / CLEF Flash, one action
choice over GVGAI's legal actions, and at most 64 KB. It invokes the native `AI`
binding and preserves the model's typed answer. No Cloudflare account API token
is stored in Railway or the Worker. The server retains per-run and shared usage
caps, deadlines, action validation, and cancellation. The relay adds no retries.

`GET /health` reports whether the relay secret is configured. Inference requires
the secret; there is no browser CORS access. Logs contain operation metadata and
generic errors, never request bodies or credential values.

## Build and deploy

Use Node 22.23+ and the locked project dependencies:

```sh
npm ci
npm test
export CLOUDFLARE_ACCOUNT_ID=051d576ac3f7bb29f538a3ea559b77a6
npm run deploy -- --dry-run
npm run deploy -- --secrets-file /path/to/private.secrets.json
```

The JSON secrets file contains only `RELAY_SECRET`, a cryptographically random
value of at least 32 characters. Keep the file outside source control with
owner-only filesystem permissions; remove the temporary copy after setting both
managed secret stores. The CF CLI accepts normal operator authentication for
deployment. Do not copy that operator authentication into Railway.

Configure Railway with `CLEF_RELAY_URL` (the deployed HTTPS origin) and
`CLEF_RELAY_SECRET` (the same relay secret). These take precedence over direct
Cloudflare REST credentials. Invalid or incomplete relay configuration fails
closed; it never switches accounts or providers. Rotate the dedicated secret in
both services together. A relay secret cannot deploy Workers or access other
Cloudflare resources.

References: [native CLEF binding](https://developers.cloudflare.com/workers-ai/models/clef/),
[CF project configuration](https://developers.cloudflare.com/cf/projects/cloudflare-config/),
[Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/).
