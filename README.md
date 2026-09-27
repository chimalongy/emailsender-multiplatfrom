# EmailSender

A small JavaScript-only Next.js email workspace for Vercel, Neon PostgreSQL, Cloudflare D1 and Cloudflare Email Routing. Message records live in D1; connections, personas, credentials and quota counters remain in Neon. All personas can send through every connected platform whose verified domains include the persona's domain.

## Start here

1. Create a Neon database and run **db/schema.sql** in its SQL editor. It creates the application, quota and send-reservation tables/functions; it does not create a Neon messages table.
2. Create D1 and apply its schema as described in **docs/CLOUDFLARE.md**.
3. Put this project in your Git repository (exclude node_modules, .next and secrets). Run `npm install` and `npm run secrets` in a private terminal. Keep CREDENTIALS_KEY backed up; changing it without re-encrypting existing credentials makes them unreadable.
4. Deploy the Worker using the generated INBOUND_SECRET as described in **docs/CLOUDFLARE.md**. Keep the Worker URL.
5. Import the repository into Vercel. Select Next.js, root directory containing package.json, Node.js 22 or newer. Build command: `npm run build`. Set all variables below, including MESSAGE_STORE_URL and the exact same INBOUND_SECRET used by the Worker. Set APP_URL to your exact production origin (no path), then deploy.
6. Open the app, sign in, connect providers, and create personas. Authenticate the domain in each provider dashboard before enabling its connection. Add the Cloudflare routing rule pointing at the deployed Worker.

For local development only: copy .env.example to .env.local, fill it in, and run `npm run dev`. Use APP_URL=http://localhost:3000. Local installation is not required for production hosting; you can generate the secrets in another trusted Node.js environment.

| Environment variable | Value |
| --- | --- |
| DATABASE_URL | Neon connection string with SSL enabled; use a dedicated app database/role |
| MESSAGE_STORE_URL | HTTPS URL of the deployed Cloudflare Worker, ending in /api/messages |
| APP_URL | Exact origin users visit; used for CSRF checks |
| ADMIN_PASSWORD_HASH | Salt and scrypt hash produced by `npm run secrets` |
| SESSION_SECRET | Random secret for 12-hour admin sessions |
| CREDENTIALS_KEY | 64 hexadecimal characters / 32 bytes for AES-256-GCM |
| INBOUND_SECRET | Shared HMAC secret, identical in Vercel and Cloudflare Worker |

No secrets use NEXT_PUBLIC_. API credentials are encrypted in Neon and are never returned to the browser. Credential edit fields stay blank; a blank value preserves the existing value. Login allows 30 attempts per 15-minute UTC window across the application, stored in the existing usage table. This is a single-admin workspace, not a multi-user email service.

## Pages

- Overview: enabled platforms, application usage, daily and monthly capacity, reset timestamps.
- Connections: all eight senders, credentials, verified domains, editable quota settings, domain instructions and supported status checks. Save Cloudflare account/zone IDs and optional read token here too.
- Personas: name/email identities without provider assignments. Saving the same email updates its display name; personas can be edited or deleted.
- Compose: one recipient, plain-text message, selected persona and selected provider. An escaped HTML alternative is generated server-side.
- Mailbox: Inbox, Sent, paginated lists, conversation view, replies and manual message linking/reconciliation.
- Deployment: Neon/Vercel/Cloudflare instructions and complete Worker source.

## Quota behavior

Application counters count one recipient per send. Every persona uses the same connection's counters. Credentials and domain edits do not reset the connection creation date. The creation date is the tracking anchor; add the connection when connecting your domain.

1. **Day:** UTC midnight to midnight.
2. **Your 30-day period:** consecutive exact 30-day intervals from connection creation. This is not a calendar month.
3. **Provider month:** optional additional cap using calendar months, 30-day periods, or a monthly billing anniversary. Set it to match the period shown in your provider dashboard. Defaults are starting values, not a claim about your account's billing date.

A database function locks the connection and reserves all counters together before calling a provider. No scheduled reset is needed: each request chooses the current period's counters. Existing history remains intact. The database is the source of time, avoiding browser-clock differences.

Provider restrictions still apply. A dashboard reset cannot change their quota. Usage outside this app is **not synchronized**. Use these connections exclusively here for accurate app-based remaining counts, or lower limits to reserve capacity for other systems. Daily boundaries default to UTC; if your provider resets at a different hour, treat app remaining capacity as an estimate. Hourly and per-second caps are enforced by the provider; the app does not queue or automatically rotate to another provider.

Clear rejections release quota. Timeouts, malformed responses and server errors retain quota with an `unknown` status. If Vercel stops after reservation, the status may remain `sending`. In Sent → Message details, first confirm the result in provider logs, then reconcile it. Do not blindly resend. Reusing a request UUID returns its saved result and does not send twice. Reservations and idempotency are database-backed, not in memory. No exactly-once claim is made across the external provider boundary.

## Reply matching

When Cloudflare receiving is enabled for the sender domain, supported adapters send a unique `reply+<random-token>@yourdomain.com` Reply-To for each outgoing message. Cloudflare must route these addresses to the Worker. A response to that address identifies the exact parent message even when the sending API does not expose a wire Message-ID.

Incoming messages also match stored `In-Reply-To` and `References` IDs. Brevo/Mailgun return useful wire IDs; other provider resource IDs are stored separately and never assumed to be RFC Message-IDs. Outgoing replies send threading headers where documented. Matching groups conversations; it does not authenticate the identity of the sender of a reply.

**GoSend's published API lacks custom Reply-To and threading headers.** Its sends work, but incoming replies may require Mailbox → Message details → Link conversation using the outgoing record UUID. **Sequenzy supports Reply-To but does not document custom threading headers.** Disable Sequenzy reply tracking to preserve your Cloudflare Reply-To; app-side matching works through the token, while recipient-side threading is not guaranteed. These limits are visible in Compose.

## Delivery status and suppression

`accepted` means the provider accepted the API request, not that the destination mailbox received it. Signed webhook handlers are implemented for Resend and Mailgun:

- `/api/webhooks/resend` — use the webhook's `whsec_...` signing secret; delivery, bounce, complaint and failure events.
- `/api/webhooks/mailgun` — use Mailgun's HTTP webhook signing key, not its sending API key; configure delivered, permanent failure and complaint webhooks as JSON.

Save the secret in the relevant connection. Timestamp/signature checks reject invalid requests; repeated events are safe. Bounce/complaint status blocks subsequent app sends to that recipient across platforms. Other providers' delivery webhooks are not implemented in this version; use their dashboards. There is no bulk marketing unsubscribe/contact-management feature. Do not treat this simple correspondence tool as a completed campaign platform.

## Receiving limitations

The Cloudflare Email Worker stores inbound messages directly in D1 before accepting them. The Next.js app reads and updates message rows through a signed HTTPS endpoint on that same Worker. D1 is the source of truth for inbox, sent items, threads, reply matching and delivery status. Neon stores supporting quota reservation identifiers/status, not message content.

The Worker imposes a **4 MiB raw-message limit**, and **150,000 characters per text/HTML body**, to keep processing bounded. It stores text/HTML and attachment counts, but **does not store attachment files or original MIME**. The UI labels omitted attachments. Add object storage separately if attachment preservation is required. HTML is sanitized, rendered inside an empty-sandbox iframe and restricted by CSP; remote image tracking is not loaded.

## Domain setup and verified scope

Read **docs/PROVIDERS.md** for all eight platforms and source links reviewed on 23 September 2026. Use provider-generated DNS values, not example DKIM values. API-based domain inspection is included for Brevo, Resend (domain ID needed), Mailgun and Cloudflare zone status. The other connections use the documented dashboard workflow. Setup checks do not send test emails or modify DNS. Enablement is an explicit admin attestation after verification; the provider is the final authority when sending.

Cloudflare receiving must retain the receiving MX records. Sender return-path MX records often belong to a subdomain and can coexist. Maintain one SPF TXT record per hostname; merge authorized includes only where needed and observe SPF's lookup limit. DKIM selectors may coexist, but never overwrite a different provider's record at the same hostname. Use DNS-only CNAME records when required by the provider.

## Project structure

```
app/                 Next.js pages, CSS and serverless API handlers
components/          Admin interface
lib/                 Provider adapters, authentication, validation, catalog
db/schema.sql       Neon supporting tables and atomic quota functions
db/d1-messages.sql  Cloudflare D1 message table and indexes
worker/              Cloudflare Email Worker and Wrangler config
public/worker.js      Downloadable copy shown in the app
scripts/secrets.js   Admin password hash and environment secrets generator
tests/               Security, adapters, PostgreSQL quota and dedupe tests
docs/                Provider and Cloudflare instructions
```

## Verification and limits of verification

`npm test` runs security/adapter tests and executes the Neon quota SQL in PGlite (embedded PostgreSQL). `npm run build` compiles the production Next.js project. The Worker has D1/parser/signature tests (`cd worker && npm install && npm test`). It can be bundled without deploying: `cd worker && npm install && npx wrangler deploy --dry-run`.

The project was not connected to your real Neon account, DNS, provider accounts, Cloudflare account or Vercel account. Live approval, delivery, provider-specific authentication and receiving round-trip must be checked with your accounts. A browser smoke check used fixture data; fixture records are not shipped as your application data. No real emails were sent.

Before using real traffic, send one message from each enabled provider to an address you control, verify the visible sender name/domain, reply, inspect Inbox, and compare provider logs with the app. Configure provider-period anchors before the first real send.
