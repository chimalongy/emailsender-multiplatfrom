# Cloudflare receiving deployment

## Prerequisites

Use a domain whose DNS is managed by Cloudflare, a deployed Vercel app, Neon with schema.sql installed, and access to Cloudflare Workers, D1 and Email Routing. Incoming and outgoing messages are stored in D1. Neon continues to store personas, provider connections and quota data.

## Configure the application

In Connections → Cloudflare receiving, enter the domain(s), Cloudflare account ID and zone ID. An optional token with Zone Read for that zone allows the app's Check setup button to check the zone. This connection is used for reply-address generation and domain status; inbound email is written to D1 by the Worker.

Generate INBOUND_SECRET using the root project's `npm run secrets`. Put the identical value in Vercel and the Worker. This secret signs inbound HTTP requests; it is different from a Cloudflare API token.

## Create D1 and deploy the Worker

From the worker directory create the database:

```sh
npx wrangler login
npx wrangler d1 create emailsender-messages
```

Copy the returned database ID into worker/wrangler.jsonc in place of REPLACE_WITH_D1_DATABASE_ID. Then create its schema:

```sh
npx wrangler d1 execute emailsender-messages --remote --file=../db/d1-messages.sql
```

If upgrading an existing installation that already has message history in Neon, first run the updated **db/schema.sql** in that Neon database. It adds the quota reservation ledger and updates the quota functions while leaving the old messages table in place for export. Then run `npm run export:messages` from the project root while DATABASE_URL points to that database. From the worker directory, import the generated file with:

```sh
npx wrangler d1 execute emailsender-messages --remote --file=../db/d1-messages-import.sql
```

The export contains message bodies and should be treated as sensitive. After confirming the import, remove the generated file. Do not run this export against a new Neon database that has no legacy messages table.

Edit worker/wrangler.jsonc:

- account_id: your Cloudflare account ID, available on the dashboard.
- ALLOWED_DOMAINS: comma-separated exact domain names, matching the app's Cloudflare connection.

From the worker folder:

```sh
npm install
npx wrangler login
npx wrangler secret put INBOUND_SECRET
npx wrangler deploy
```

Paste the shared secret at the prompt. Wrangler login handles deployment authorization. For CI, use a scoped CLOUDFLARE_API_TOKEN authorized to deploy Workers in your account, stored as a CI secret. Do not commit it or the shared secret.

The Worker handles both Cloudflare Email Routing and the app's signed D1 API. workers_dev is enabled so Vercel can call its HTTPS endpoint. After deployment, copy the Worker URL from Wrangler output and set MESSAGE_STORE_URL in Vercel to that URL with /api/messages appended. Keep INBOUND_SECRET identical in Vercel and Cloudflare. Redeploy Vercel after setting variables. The D1 migration only creates the table and indexes; existing Neon history is imported separately using the optional steps above. Full source is worker/worker.js.

## Route messages

Enable Email Routing for the domain and follow Cloudflare's DNS setup. Ensure no unrelated receiving MX records remain at the same hostname. Deploy the Worker first, then create routing rules pointing at it. Route persona addresses and a catch-all for generated reply+ addresses. The exact dashboard menu may be under Email Routing or Email Service → Email Routing.

Keep outbound providers' DKIM and sending return-path records. Do not replace Cloudflare receiving MX with a sending provider's inbound MX. Sending return-path subdomains can have their own MX records.

## Verify

1. Enable the matching receiving domain in the app.
2. Email a persona address from an external account; refresh Inbox.
3. Send an email from the app using a provider with Reply-To support, then reply to it.
4. Check that the response appears in the original conversation. On unsupported providers, link the incoming message manually using the outgoing UUID.
5. If Vercel Deployment Protection blocks the public inbound API, configure the production deployment so external Worker/provider webhooks can reach those routes. The app's own HMAC verification remains mandatory.

## Limits and failure behavior

The Worker accepts at most 4 MiB raw MIME and 150,000 characters for each text/HTML body. Attachments are not saved; only their count is shown. The email route acknowledges a message only after its D1 write succeeds. The message API is protected by the shared HMAC secret; do not publish it or use it in browser code.

Source: [Cloudflare Email Worker handler](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/). The parser is [postal-mime](https://github.com/postalsys/postal-mime).
